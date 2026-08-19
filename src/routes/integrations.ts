import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { userAuth } from '../middleware/userAuth';
import { integrationAuth } from '../middleware/integrationAuth';
import { asyncHandler } from '../lib/asyncHandler';
import { montarPayloadDados } from '../lib/dadosCompartilhados';
import { filtrarCamposPorPrivacidade } from '../lib/privacidade';
import { buscarCamposConfigurados } from '../lib/camposSolicitados';
import { verificarAssinatura, MENSAGEM_ASSINATURA_VENCIDA } from '../lib/assinatura';
import { resolverAprovacao, SolicitacaoInvalidaError, SolicitacaoJaResolvidaError } from '../lib/compartilhamento';
import {
  gerarAuthorizationCode,
  hashAuthorizationCode,
  AUTHORIZATION_CODE_TTL_MS,
  AUTHORIZATION_REQUEST_TTL_MS,
} from '../lib/authorizationCode';

const router = Router();

const CAMPOS = ['NOME', 'TELEFONE', 'EMAIL', 'CPF', 'RG', 'DATA_NASCIMENTO', 'ENDERECO', 'FOTO'] as const;

// Todas as rotas deste módulo (client_credentials + tela de consentimento
// web) recebem um limite comum — item que faltava no projeto (ver
// CHECKLIST-PILOTO.md) e que, por serem rotas novas, já nascem cobertas.
// As demais rotas do projeto (/auth/request, /customer/share, logins)
// continuam sem rate limit, como já estavam — fora do escopo deste módulo.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em instantes.' },
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

const criarSolicitacaoSchema = z.object({
  purpose: z.string().trim().min(1).max(300).optional(),
  // Opcional: se omitido, usa os campos configurados pela empresa em
  // PUT /companies/me/campos-solicitados (mesmo fallback de NFC/QR).
  requestedFields: z.array(z.enum(CAMPOS)).min(1).optional(),
  redirectUri: z.string().url(),
});

/**
 * POST /integrations/authorization-requests
 * Chamado pelo BACKEND do sistema externo (nunca pelo navegador — exige
 * client_id/client_secret via Basic Auth) para iniciar um compartilhamento
 * WEB/API. Equivalente do POST /auth/request para o canal Web, só que aqui
 * ainda não sabemos qual usuário vai autorizar — só a empresa, a
 * integração e o que está sendo pedido.
 */
router.post(
  '/authorization-requests',
  integrationAuth,
  asyncHandler(async (req, res) => {
    const parsed = criarSolicitacaoSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos.', detalhes: parsed.error.flatten() });
    }
    const { purpose, requestedFields, redirectUri } = parsed.data;
    const integracao = req.integracao!;

    // Nunca aceitar qualquer URL enviada pelo chamador — só as previamente
    // cadastradas nesta integração (evita open redirect).
    if (!integracao.redirectUris.includes(redirectUri)) {
      return res.status(400).json({ error: 'redirectUri não está cadastrada para esta integração.' });
    }

    let company = await prisma.company.findUniqueOrThrow({ where: { id: integracao.companyId } });
    const { empresa: companyAtualizada, bloqueado } = await verificarAssinatura(company);
    if (bloqueado) {
      return res.status(402).json({ error: MENSAGEM_ASSINATURA_VENCIDA });
    }
    company = companyAtualizada;

    // A empresa controla o TETO do que qualquer integração dela pode pedir
    // (mesma configuração usada por NFC/QR) — uma integração não pode pedir
    // um campo que a empresa nunca liberou solicitar.
    const camposPermitidos = await buscarCamposConfigurados(company.id);
    let camposPedidos = camposPermitidos;
    if (requestedFields && requestedFields.length > 0) {
      const permitidosSet = new Set(camposPermitidos);
      const foraDoPermitido = requestedFields.filter((c) => !permitidosSet.has(c));
      if (foraDoPermitido.length > 0) {
        return res.status(400).json({
          error: `Campo(s) não permitido(s) para esta integração: ${foraDoPermitido.join(', ')}.`,
        });
      }
      camposPedidos = requestedFields;
    }

    const solicitacao = await prisma.solicitacaoCompartilhamento.create({
      data: {
        companyId: company.id,
        integracaoId: integracao.id,
        redirectUri,
        purpose: purpose ?? null,
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
 * GET /integrations/authorize/:requestId
 * Chamado pela TELA de consentimento (app/authorize.html) já com o usuário
 * logado no FIXO PASS (X-USER-ID), para saber o que mostrar: empresa,
 * finalidade, campos pedidos. Na primeira vez que a solicitação é vista,
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

    const [company, integracao] = await Promise.all([
      prisma.company.findUniqueOrThrow({ where: { id: solicitacao.companyId } }),
      solicitacao.integracaoId ? prisma.integracao.findUnique({ where: { id: solicitacao.integracaoId } }) : null,
    ]);

    return res.status(200).json({
      requestId: solicitacao.id,
      status: solicitacao.status,
      empresa: company.nome,
      integracao: integracao?.nome ?? null,
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
 * POST /integrations/authorize/:requestId
 * O usuário aprova ou nega, a partir da tela de consentimento. Reaproveita
 * o mesmo núcleo de POST /customer/share (lib/compartilhamento.ts) — a
 * diferença é só a resposta: aqui NUNCA devolvemos os dados pro navegador,
 * só um authorization_code opaco, de uso único e validade curta, que o
 * BACKEND do sistema externo troca depois em POST /integrations/token.
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
      return res.status(200).json({ status: 'NEGADA', redirectUri: solicitacao.redirectUri });
    }

    const { codigo, codigoHash } = gerarAuthorizationCode();
    await prisma.autorizacaoCodigo.create({
      data: {
        codigoHash,
        solicitacaoId: solicitacao.id,
        integracaoId: solicitacao.integracaoId!,
        companyId: solicitacao.companyId,
        userId,
        camposLiberados: resultado.campos,
        redirectUri: solicitacao.redirectUri!,
        expiraEm: new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS),
      },
    });

    return res.status(200).json({ status: 'APROVADA', code: codigo, redirectUri: solicitacao.redirectUri });
  })
);

const tokenSchema = z.object({
  code: z.string().min(1),
  redirectUri: z.string().url(),
});

/**
 * POST /integrations/token
 * Chamado pelo BACKEND do sistema externo (Basic Auth) para trocar o
 * authorization_code pelos dados autorizados. Uso único: o consumo é um
 * update condicional (WHERE usadoEm IS NULL), então duas trocas
 * concorrentes do mesmo code não conseguem as duas "vencer" a corrida.
 */
router.post(
  '/token',
  integrationAuth,
  asyncHandler(async (req, res) => {
    const parsed = tokenSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos.', detalhes: parsed.error.flatten() });
    }
    const { code, redirectUri } = parsed.data;

    const codigoHash = hashAuthorizationCode(code);
    const autorizacaoCodigo = await prisma.autorizacaoCodigo.findUnique({ where: { codigoHash } });

    if (!autorizacaoCodigo) {
      return res.status(400).json({ error: 'Código inválido.' });
    }
    // Multi-tenant: o code só pode ser trocado pela MESMA integração (logo,
    // pela mesma empresa) que o emitiu — nunca por outra, mesmo que ela
    // tenha suas próprias credenciais válidas.
    if (autorizacaoCodigo.integracaoId !== req.integracao!.id) {
      return res.status(403).json({ error: 'Este código não pertence a esta integração.' });
    }
    if (autorizacaoCodigo.redirectUri !== redirectUri) {
      return res.status(400).json({ error: 'redirectUri não confere com a autorização original.' });
    }
    if (autorizacaoCodigo.expiraEm.getTime() < Date.now()) {
      return res.status(400).json({ error: 'Código expirado.' });
    }
    if (autorizacaoCodigo.usadoEm) {
      return res.status(400).json({ error: 'Código já utilizado.' });
    }

    const consumo = await prisma.autorizacaoCodigo.updateMany({
      where: { id: autorizacaoCodigo.id, usadoEm: null },
      data: { usadoEm: new Date() },
    });
    if (consumo.count === 0) {
      return res.status(400).json({ error: 'Código já utilizado.' });
    }

    const user = await prisma.user.findUniqueOrThrow({ where: { id: autorizacaoCodigo.userId } });
    const dados = montarPayloadDados(user, autorizacaoCodigo.camposLiberados);

    return res.status(200).json({ data: dados });
  })
);

export default router;
