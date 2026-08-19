import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { userAuth } from '../middleware/userAuth';
import { oauthClientAuth } from '../middleware/oauthClientAuth';
import { asyncHandler } from '../lib/asyncHandler';
import { montarPayloadDados } from '../lib/dadosCompartilhados';
import { filtrarCamposPorPrivacidade } from '../lib/privacidade';
import { buscarCamposConfigurados } from '../lib/camposSolicitados';
import { verificarAssinatura, MENSAGEM_ASSINATURA_VENCIDA } from '../lib/assinatura';
import { resolverAprovacao, SolicitacaoInvalidaError, SolicitacaoJaResolvidaError } from '../lib/compartilhamento';
import { gerarAuthorizationCode, hashAuthorizationCode, AUTHORIZATION_CODE_TTL_MS, AUTHORIZATION_REQUEST_TTL_MS } from '../lib/oauthCode';
import { gerarAccessToken, hashAccessToken, ACCESS_TOKEN_TTL_MS } from '../lib/oauthToken';

const router = Router();

const CAMPOS = ['NOME', 'TELEFONE', 'EMAIL', 'CPF', 'RG', 'DATA_NASCIMENTO', 'ENDERECO', 'FOTO'] as const;
type Campo = (typeof CAMPOS)[number];

// Todas as rotas deste módulo (client_credentials + tela de consentimento
// web + userinfo) recebem um limite comum — item que faltava no projeto
// (ver CHECKLIST-PILOTO.md) e que, por serem rotas novas, já nascem
// cobertas. As demais rotas do projeto (/auth/request, /customer/share,
// logins) continuam sem rate limit, como já estavam — fora do escopo deste
// módulo.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'invalid_request', error_description: 'Muitas requisições. Tente novamente em instantes.' },
});
router.use(limiter);

/**
 * Carrega uma solicitação do canal WEB/API por id, aplicando a mesma
 * transição preguiçosa de expiração já usada em verificarAssinatura
 * (lib/assinatura.ts): sem cron/scheduler, checa a validade no momento em
 * que alguém tenta usar a solicitação e, se venceu, transiciona pra
 * EXPIRADA ali mesmo antes de responder.
 */
async function carregarSolicitacaoWebApi(requestId: string) {
  const solicitacao = await prisma.solicitacaoCompartilhamento.findUnique({ where: { id: requestId } });
  if (!solicitacao || solicitacao.metodo !== 'WEB_API') return null;

  if (solicitacao.status === 'PENDENTE' && solicitacao.expiraEm && solicitacao.expiraEm.getTime() < Date.now()) {
    return prisma.solicitacaoCompartilhamento.update({
      where: { id: requestId },
      data: { status: 'EXPIRADA', resolvidaEm: new Date() },
    });
  }
  return solicitacao;
}

const criarAutorizacaoSchema = z.object({
  response_type: z.literal('code'),
  redirect_uri: z.string().url(),
  // Espaço-separado, mesma convenção do OAuth2 (RFC 6749 §3.3) — ex.:
  // "NOME TELEFONE ENDERECO". Opcional: se omitido, usa os campos
  // configurados pela empresa em PUT /companies/me/campos-solicitados
  // (mesmo fallback de NFC/QR).
  scope: z.string().trim().min(1).optional(),
  // Opaco — ecoado de volta exatamente como recebido (padrão OAuth2,
  // RFC 6749 §4.1.1/§4.1.2, proteção contra CSRF do lado do client). Se
  // omitido, o backend usa o requestId como valor de correlação no
  // redirect de volta (compatibilidade com a integração já existente do
  // cardápio, que ainda não manda state próprio).
  state: z.string().max(500).optional(),
  purpose: z.string().trim().min(1).max(300).optional(),
});

/**
 * POST /oauth/authorize
 * Chamado pelo BACKEND do sistema externo (nunca pelo navegador — exige
 * client_id/client_secret via Basic Auth) para iniciar um compartilhamento
 * WEB/API. Ainda não sabemos qual usuário vai autorizar — só o client, o
 * que está sendo pedido e pra onde voltar.
 *
 * Neste projeto o client_id nunca precisa ir pro navegador: diferente de um
 * `GET /oauth/authorize?client_id=...` "de livro" (onde o client_id é
 * público por definição do OAuth2), aqui o próprio backend do sistema
 * externo já autentica com Basic Auth nesta chamada, e o navegador só
 * recebe de volta uma authorizationUrl opaca (com um requestId, não um
 * client_id) — uma superfície de ataque a menos, sem precisar de PKCE.
 */
router.post(
  '/authorize',
  oauthClientAuth,
  asyncHandler(async (req, res) => {
    const parsed = criarAutorizacaoSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'Dados inválidos.', detalhes: parsed.error.flatten() });
    }
    const { redirect_uri, scope, state, purpose } = parsed.data;
    const oauthClient = req.oauthClient!;

    // Nunca aceitar qualquer URL enviada pelo chamador — só as previamente
    // cadastradas neste client (evita open redirect).
    if (!oauthClient.redirectUris.includes(redirect_uri)) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri não está cadastrada para este client.' });
    }

    let company = await prisma.company.findUniqueOrThrow({ where: { id: oauthClient.companyId } });
    const { empresa: companyAtualizada, bloqueado } = await verificarAssinatura(company);
    if (bloqueado) {
      return res.status(403).json({ error: 'access_denied', error_description: MENSAGEM_ASSINATURA_VENCIDA });
    }
    company = companyAtualizada;

    // O client controla o TETO do que pode pedir (mesma configuração usada
    // por NFC/QR) — um client não pode pedir um escopo que a empresa nunca
    // liberou solicitar.
    const camposPermitidos = await buscarCamposConfigurados(company.id);
    let camposPedidos: Campo[] = camposPermitidos;
    if (scope) {
      const solicitados = scope.split(/\s+/).filter(Boolean);
      const desconhecidos = solicitados.filter((s) => !CAMPOS.includes(s as Campo));
      if (desconhecidos.length > 0) {
        return res.status(400).json({ error: 'invalid_scope', error_description: `Escopo(s) desconhecido(s): ${desconhecidos.join(', ')}.` });
      }
      const permitidosSet = new Set(camposPermitidos);
      const foraDoPermitido = solicitados.filter((s) => !permitidosSet.has(s as Campo));
      if (foraDoPermitido.length > 0) {
        return res.status(400).json({
          error: 'invalid_scope',
          error_description: `Escopo(s) não permitido(s) para este client: ${foraDoPermitido.join(', ')}.`,
        });
      }
      camposPedidos = solicitados as Campo[];
    }

    const solicitacao = await prisma.solicitacaoCompartilhamento.create({
      data: {
        companyId: company.id,
        integracaoId: oauthClient.id,
        redirectUri: redirect_uri,
        purpose: purpose ?? null,
        state: state ?? null,
        metodo: 'WEB_API',
        camposPedidos,
        expiraEm: new Date(Date.now() + AUTHORIZATION_REQUEST_TTL_MS),
      },
    });

    const panelUrl = process.env.PANEL_URL || 'https://painel.fixopass.com';
    return res.status(201).json({
      requestId: solicitacao.id,
      authorizationUrl: `${panelUrl}/authorize.html?requestId=${solicitacao.id}`,
      expiresAt: solicitacao.expiraEm,
    });
  })
);

/**
 * GET /oauth/authorize/:requestId
 * Chamado pela TELA de consentimento (app/authorize.html) já com o usuário
 * logado no FIXO PASS (X-USER-ID), para saber o que mostrar: empresa,
 * finalidade, escopos pedidos. Na primeira vez que a solicitação é vista,
 * vincula o userId (a solicitação nasceu sem ele — ver schema.prisma) e já
 * aplica o mesmo filtro de privacidade por categoria que NFC/QR aplicam na
 * criação (lib/privacidade.ts).
 */
router.get(
  '/authorize/:requestId',
  userAuth,
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    let solicitacao = await carregarSolicitacaoWebApi(req.params.requestId);
    if (!solicitacao) {
      return res.status(404).json({ error: 'Solicitação não encontrada.' });
    }

    if (solicitacao.status === 'PENDENTE' && !solicitacao.userId) {
      const company = await prisma.company.findUniqueOrThrow({ where: { id: solicitacao.companyId } });
      const camposFiltrados = await filtrarCamposPorPrivacidade(userId, company.categoria, solicitacao.camposPedidos);
      solicitacao = await prisma.solicitacaoCompartilhamento.update({
        where: { id: solicitacao.id },
        data: { userId, camposPedidos: camposFiltrados },
      });
    } else if (solicitacao.userId && solicitacao.userId !== userId) {
      // Este link de consentimento já foi aberto por outra conta antes —
      // não deixamos um segundo usuário "assumir" a mesma solicitação.
      return res.status(403).json({ error: 'Esta solicitação já está associada a outro usuário.' });
    }

    const [company, oauthClient] = await Promise.all([
      prisma.company.findUniqueOrThrow({ where: { id: solicitacao.companyId } }),
      solicitacao.integracaoId ? prisma.oAuthClient.findUnique({ where: { id: solicitacao.integracaoId } }) : null,
    ]);

    return res.status(200).json({
      requestId: solicitacao.id,
      status: solicitacao.status,
      empresa: company.nome,
      integracao: oauthClient?.name ?? null,
      purpose: solicitacao.purpose ?? 'Preenchimento de dados.',
      camposPedidos: solicitacao.camposPedidos,
      expiresAt: solicitacao.expiraEm,
    });
  })
);

const decisaoSchema = z.object({
  aprovar: z.boolean(),
  camposLiberados: z.array(z.enum(CAMPOS)).optional(),
});

/**
 * POST /oauth/authorize/:requestId
 * O usuário aprova ou nega, a partir da tela de consentimento. Reaproveita
 * o mesmo núcleo de POST /customer/share (lib/compartilhamento.ts) — a
 * diferença é só a resposta: aqui NUNCA devolvemos os dados pro navegador,
 * só um authorization_code opaco, de uso único e validade curta (2
 * minutos), que o BACKEND do sistema externo troca depois em
 * POST /oauth/token.
 */
router.post(
  '/authorize/:requestId',
  userAuth,
  asyncHandler(async (req, res) => {
    const parsed = decisaoSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos.', detalhes: parsed.error.flatten() });
    }
    const userId = req.userId!;

    const solicitacao = await carregarSolicitacaoWebApi(req.params.requestId);
    if (!solicitacao) {
      return res.status(404).json({ error: 'Solicitação não encontrada.' });
    }
    if (solicitacao.userId !== userId) {
      return res.status(403).json({ error: 'Esta solicitação não pertence a este usuário.' });
    }
    if (solicitacao.status !== 'PENDENTE') {
      return res.status(409).json({ error: `Solicitação já foi ${solicitacao.status.toLowerCase()}.` });
    }

    // state do client (se mandou um) é sempre ecoado igualzinho; se não
    // mandou, caímos no requestId — ver comentário em schema.prisma.
    const stateDevolvido = solicitacao.state ?? solicitacao.id;

    let resultado;
    try {
      resultado = await resolverAprovacao({
        solicitacaoId: solicitacao.id,
        userId,
        aprovar: parsed.data.aprovar,
        camposLiberados: parsed.data.camposLiberados,
      });
    } catch (err) {
      if (err instanceof SolicitacaoInvalidaError) return res.status(404).json({ error: 'Solicitação não encontrada.' });
      if (err instanceof SolicitacaoJaResolvidaError) return res.status(409).json({ error: err.message });
      throw err;
    }

    if (resultado.status === 'NEGADA') {
      return res.status(200).json({ status: 'NEGADA', redirectUri: solicitacao.redirectUri, state: stateDevolvido });
    }

    const { codigo, codigoHash } = gerarAuthorizationCode();
    await prisma.oAuthCode.create({
      data: {
        codeHash: codigoHash,
        requestId: solicitacao.id,
        oauthClientId: solicitacao.integracaoId!,
        companyId: solicitacao.companyId,
        userId,
        scopes: resultado.campos,
        redirectUri: solicitacao.redirectUri!,
        expiresAt: new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS),
      },
    });

    return res.status(200).json({ status: 'APROVADA', code: codigo, redirectUri: solicitacao.redirectUri, state: stateDevolvido });
  })
);

const tokenSchema = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().min(1),
  redirect_uri: z.string().url(),
});

/**
 * POST /oauth/token
 * Chamado pelo BACKEND do sistema externo (Basic Auth) para trocar o
 * authorization_code por um access_token — não pelos dados diretamente
 * (ver GET /oauth/userinfo). Uso único do CODE: o consumo é um update
 * condicional (WHERE usedAt IS NULL), então duas trocas concorrentes do
 * mesmo code não conseguem as duas "vencer" a corrida. O access_token
 * emitido aqui É reutilizável (dentro da validade) — essa é a diferença
 * para GET /oauth/userinfo poder ser chamado mais de uma vez.
 */
router.post(
  '/token',
  oauthClientAuth,
  asyncHandler(async (req, res) => {
    const parsed = tokenSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'Dados inválidos.', detalhes: parsed.error.flatten() });
    }
    const { code, redirect_uri } = parsed.data;

    const codeHash = hashAuthorizationCode(code);
    const oauthCode = await prisma.oAuthCode.findUnique({ where: { codeHash } });

    if (!oauthCode) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Código inválido.' });
    }
    // Multi-tenant: o code só pode ser trocado pelo MESMO client (logo, pela
    // mesma empresa) que o originou — nunca por outro, mesmo que ele tenha
    // suas próprias credenciais válidas.
    if (oauthCode.oauthClientId !== req.oauthClient!.id) {
      return res.status(403).json({ error: 'invalid_grant', error_description: 'Este código não pertence a este client.' });
    }
    if (oauthCode.redirectUri !== redirect_uri) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri não confere com a autorização original.' });
    }
    if (oauthCode.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Código expirado.' });
    }
    if (oauthCode.usedAt) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Código já utilizado.' });
    }

    const consumo = await prisma.oAuthCode.updateMany({
      where: { id: oauthCode.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (consumo.count === 0) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Código já utilizado.' });
    }

    const { token, tokenHash } = gerarAccessToken();
    const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
    await prisma.oAuthToken.create({
      data: {
        tokenHash,
        oauthClientId: oauthCode.oauthClientId,
        oauthCodeId: oauthCode.id,
        companyId: oauthCode.companyId,
        userId: oauthCode.userId,
        scopes: oauthCode.scopes,
        expiresAt,
      },
    });

    return res.status(200).json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: oauthCode.scopes.join(' '),
    });
  })
);

function extrairBearer(req: { header(name: string): string | undefined }): string | null {
  const header = req.header('Authorization');
  if (!header || !header.startsWith('Bearer ')) return null;
  const valor = header.slice('Bearer '.length).trim();
  return valor || null;
}

/**
 * GET /oauth/userinfo
 * Chamado pelo BACKEND do sistema externo (nunca pelo navegador —
 * `Authorization: Bearer <access_token>`) para obter os dados autorizados.
 * Diferente de POST /oauth/token, pode ser chamado mais de uma vez dentro
 * da validade do token (não marca uso único) — é essa reusabilidade que dá
 * o comportamento de "SSO de verdade" ao canal Web/API: o backend do
 * sistema externo pode reconsultar sem pedir um novo consentimento, desde
 * que o token ainda esteja válido.
 *
 * Só a posse do token é exigida aqui (nenhuma credencial de client) — mesmo
 * padrão de um endpoint OAuth2 userinfo/resource server, onde o Bearer é a
 * própria credencial de acesso.
 */
router.get(
  '/userinfo',
  asyncHandler(async (req, res) => {
    const token = extrairBearer(req);
    if (!token) {
      return res.status(401).json({ error: 'invalid_token', error_description: 'Envie Authorization: Bearer <access_token>.' });
    }

    const tokenHash = hashAccessToken(token);
    const oauthToken = await prisma.oAuthToken.findUnique({ where: { tokenHash } });

    if (!oauthToken) {
      return res.status(401).json({ error: 'invalid_token', error_description: 'Token inválido.' });
    }
    if (oauthToken.revokedAt) {
      return res.status(401).json({ error: 'invalid_token', error_description: 'Token revogado.' });
    }
    if (oauthToken.expiresAt.getTime() < Date.now()) {
      return res.status(401).json({ error: 'invalid_token', error_description: 'Token expirado.' });
    }

    const user = await prisma.user.findUniqueOrThrow({ where: { id: oauthToken.userId } });
    const dados = montarPayloadDados(user, oauthToken.scopes);

    return res.status(200).json({ data: dados, scope: oauthToken.scopes.join(' ') });
  })
);

export default router;
