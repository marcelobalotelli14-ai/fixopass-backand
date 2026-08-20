import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { z } from 'zod';
import QRCode from 'qrcode';
import { prisma } from '../lib/prisma';
import { gerarApiKey } from '../lib/apiKey';
import { gerarClientSecret } from '../lib/oauthClient';
import { companyPanelAuth } from '../middleware/companyPanelAuth';
import { asyncHandler } from '../lib/asyncHandler';
import { uploadLogo } from '../lib/upload';
import { cloudinary } from '../lib/cloudinary';
import { enviarEmailRecuperacaoSenha } from '../lib/email';
import { montarPayloadDados } from '../lib/dadosCompartilhados';
import { TRIAL_DIAS, PRECO_PADRAO_CENTAVOS, calcularDaysLeftInTrial, diasEmMs } from '../lib/assinatura';
import { criarCobrancaPix, AsaasNaoConfiguradoError } from '../lib/asaas';

const router = Router();

const CATEGORIAS = ['RESTAURANTE', 'CONDOMINIO', 'HOSPITAL', 'HOTEL', 'LOJA', 'OUTROS'] as const;
const CAMPOS = ['NOME', 'TELEFONE', 'EMAIL', 'CPF', 'RG', 'DATA_NASCIMENTO', 'ENDERECO', 'FOTO'] as const;

const cadastroSchema = z.object({
  nome: z.string().min(2),
  cnpj: z.string().min(14).max(18),
  categoria: z.enum(CATEGORIAS),
  emailContato: z.string().email(),
  senha: z.string().min(6),
});

/**
 * POST /companies
 * Cadastro inicial da empresa no painel web (item 3 do roadmap).
 * Retorna a API Key EM TEXTO PURO uma única vez — a empresa deve guardar
 * para configurar no ERP. Só o hash fica salvo no banco.
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = cadastroSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos.', detalhes: parsed.error.flatten() });
    }

    const { senha, ...dados } = parsed.data;

    const existente = await prisma.company.findFirst({
      where: { OR: [{ cnpj: dados.cnpj }, { emailContato: dados.emailContato }] },
    });
    if (existente) {
      return res.status(409).json({ error: 'Já existe uma empresa com este CNPJ ou e-mail.' });
    }

    const senhaHash = await bcrypt.hash(senha, 10);
    const apiKeyPlaintext = gerarApiKey();
    const apiKeyHash = await bcrypt.hash(apiKeyPlaintext, 10);

    // Trial de 15 dias começa na hora do cadastro — status já nasce TRIAL
    // pelo default do schema, só precisamos gravar até quando ele vale.
    const trialEndsAt = new Date(Date.now() + diasEmMs(TRIAL_DIAS));

    const company = await prisma.company.create({
      data: { ...dados, senhaHash, apiKeyHash, trialEndsAt },
    });

    return res.status(201).json({
      id: company.id,
      nome: company.nome,
      apiKey: apiKeyPlaintext,
      aviso: 'Guarde esta API Key com segurança — ela não será mostrada novamente. Configure-a no seu ERP.',
      status: company.status,
      trialEndsAt: company.trialEndsAt,
      daysLeftInTrial: calcularDaysLeftInTrial(company),
    });
  })
);

const loginSchema = z.object({
  emailContato: z.string().email(),
  senha: z.string(),
});

/**
 * POST /companies/login
 * MVP: login do painel web (diferente da API Key usada pelo ERP).
 * Retorna o companyId a ser usado no header X-COMPANY-ID.
 */
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos.' });
    }

    const company = await prisma.company.findUnique({ where: { emailContato: parsed.data.emailContato } });
    if (!company || !(await bcrypt.compare(parsed.data.senha, company.senhaHash))) {
      return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
    }
    if (!company.ativa) {
      return res.status(401).json({ error: 'Esta conta foi encerrada.' });
    }

    return res.status(200).json({ companyId: company.id, nome: company.nome });
  })
);

/**
 * GET /companies/me
 * Dados da própria empresa logada no painel.
 */
router.get(
  '/me',
  companyPanelAuth,
  asyncHandler(async (req, res) => {
    const company = await prisma.company.findUnique({
      where: { id: req.panelCompanyId },
      include: { camposSolicitados: true, unidades: true },
    });
    if (!company) return res.status(404).json({ error: 'Empresa não encontrada.' });

    const { senhaHash, apiKeyHash, ...perfil } = company;
    return res.status(200).json({
      ...perfil,
      daysLeftInTrial: calcularDaysLeftInTrial(company),
      precoMensalCentavos: company.precoMensalCentavos ?? PRECO_PADRAO_CENTAVOS,
    });
  })
);

const atualizarEmpresaSchema = z
  .object({
    nome: z.string().min(2).optional(),
    cnpj: z.string().min(14).max(18).optional(),
    emailContato: z.string().email().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Informe ao menos um campo para atualizar.' });

/**
 * PUT /companies/me
 * Empresa edita seus próprios dados cadastrais (nome, CNPJ, e-mail de contato).
 * Não altera senha nem API Key — isso continua em fluxos dedicados.
 */
router.put(
  '/me',
  companyPanelAuth,
  asyncHandler(async (req, res) => {
    const parsed = atualizarEmpresaSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos.', detalhes: parsed.error.flatten() });
    }

    const company = await prisma.company.update({
      where: { id: req.panelCompanyId },
      data: parsed.data,
    });

    const { senhaHash, apiKeyHash, resetPasswordTokenHash, resetPasswordExpiresAt, ...perfil } = company;
    return res.status(200).json(perfil);
  })
);

/**
 * DELETE /companies/me
 * Encerramento da conta da empresa — SOFT DELETE, ao contrário de
 * DELETE /users/me (que é exclusão definitiva/LGPD). Aqui só marcamos
 * `ativa = false`:
 *
 * - Revoga a API Key e a sessão do painel "na prática": companyAuth,
 *   companyPanelAuth e identifyActor só consideram empresas com `ativa: true`,
 *   então qualquer requisição usando o X-API-KEY ou X-COMPANY-ID antigos passa
 *   a ser rejeitada a partir daqui — sem precisar invalidar hash nem gerenciar
 *   lista de sessões.
 * - Desativa as tags NFC/QR Code das unidades: POST /auth/request rejeita
 *   qualquer leitura cujo qrCodeToken/companyId resolva pra uma empresa
 *   inativa (mesma mensagem de "QR Code inválido", pra não vazar que a
 *   empresa existiu).
 * - Bloqueia login futuro no painel (POST /companies/login checa `ativa`).
 * - NÃO apaga nada: unidades, campos solicitados, autorizações, solicitações
 *   e — o mais importante — os logs de auditoria (LogAcesso) continuam no
 *   banco intactos. Diferente do usuário comum, o encerramento de uma conta
 *   de empresa não é "direito ao esquecimento" — é desligar o acesso mantendo
 *   o histórico de auditoria de compartilhamentos já realizados.
 */
router.delete(
  '/me',
  companyPanelAuth,
  asyncHandler(async (req, res) => {
    await prisma.company.update({
      where: { id: req.panelCompanyId },
      data: { ativa: false, encerradaEm: new Date() },
    });

    return res.status(204).send();
  })
);

/**
 * POST /companies/me/logo
 * Recebe a imagem da logo (multipart/form-data, campo "logo"), envia para
 * o Cloudinary e salva a URL pública resultante em logoUrl.
 */
router.post(
  '/me/logo',
  companyPanelAuth,
  uploadLogo.single('logo'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado. Envie a imagem no campo "logo".' });
    }

    const resultadoUpload = await new Promise<{ secure_url: string }>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'fixopass/logos', public_id: req.panelCompanyId, overwrite: true, resource_type: 'image' },
        (err, result) => {
          if (err || !result) return reject(err ?? new Error('Falha ao enviar imagem para o Cloudinary.'));
          resolve(result);
        }
      );
      stream.end(req.file!.buffer);
    });

    const company = await prisma.company.update({
      where: { id: req.panelCompanyId },
      data: { logoUrl: resultadoUpload.secure_url },
    });

    return res.status(200).json({ logoUrl: company.logoUrl });
  })
);

const camposSchema = z.object({
  campos: z.array(z.object({ campo: z.enum(CAMPOS), obrigatorio: z.boolean() })).min(1),
});

/**
 * PUT /companies/me/campos-solicitados
 * Empresa escolhe quais dados solicita por padrão.
 * Ex.: Pizzaria libera [Nome, Telefone, Endereço]; Hospital pede também CPF/RG.
 */
router.put(
  '/me/campos-solicitados',
  companyPanelAuth,
  asyncHandler(async (req, res) => {
    const parsed = camposSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos.', detalhes: parsed.error.flatten() });
    }

    const companyId = req.panelCompanyId!;

    await prisma.$transaction([
      prisma.campoSolicitadoEmpresa.deleteMany({ where: { companyId } }),
      prisma.campoSolicitadoEmpresa.createMany({
        data: parsed.data.campos.map((c) => ({ companyId, campo: c.campo, obrigatorio: c.obrigatorio })),
      }),
    ]);

    const atualizado = await prisma.campoSolicitadoEmpresa.findMany({ where: { companyId } });
    return res.status(200).json(atualizado);
  })
);

const unidadeSchema = z.object({
  nome: z.string().min(2),
  endereco: z.string().optional(),
});

/**
 * POST /companies/me/unidades
 * Cria uma unidade/filial da empresa. Já gera o token único do QR Code
 * (pré-requisito do item 5 do roadmap: "QR Code funcionando").
 */
router.post(
  '/me/unidades',
  companyPanelAuth,
  asyncHandler(async (req, res) => {
    const parsed = unidadeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos.', detalhes: parsed.error.flatten() });
    }

    const unidade = await prisma.unidade.create({
      data: { ...parsed.data, companyId: req.panelCompanyId! },
    });

    return res.status(201).json({
      id: unidade.id,
      nome: unidade.nome,
      qrCodeToken: unidade.qrCodeToken,
      // O app/front do painel usa este token para gerar a imagem do QR Code
    });
  })
);

/**
 * GET /companies/me/unidades
 * Lista as unidades da empresa (para exibir os QR Codes no painel).
 */
router.get(
  '/me/unidades',
  companyPanelAuth,
  asyncHandler(async (req, res) => {
    const unidades = await prisma.unidade.findMany({ where: { companyId: req.panelCompanyId } });
    return res.status(200).json(unidades);
  })
);

/**
 * Confere que a unidade pedida realmente pertence à empresa logada no painel,
 * evitando que uma empresa gere o QR Code de uma unidade de outra empresa.
 */
async function buscarUnidadeDaEmpresa(unidadeId: string, companyId: string) {
  const unidade = await prisma.unidade.findUnique({ where: { id: unidadeId } });
  if (!unidade || unidade.companyId !== companyId) return null;
  return unidade;
}

/**
 * GET /companies/me/unidades/:id/qrcode
 * Devolve a imagem PNG do QR Code para imprimir/exibir no balcão da unidade.
 * O conteúdo do QR é o qrCodeToken — o app do usuário lê esse valor e chama
 * POST /auth/request com { qrCodeToken }.
 */
router.get(
  '/me/unidades/:id/qrcode',
  companyPanelAuth,
  asyncHandler(async (req, res) => {
    const unidade = await buscarUnidadeDaEmpresa(req.params.id, req.panelCompanyId!);
    if (!unidade) return res.status(404).json({ error: 'Unidade não encontrada.' });

    const pngBuffer = await QRCode.toBuffer(unidade.qrCodeToken, {
      type: 'png',
      width: 400,
      margin: 2,
    });
    res.setHeader('Content-Type', 'image/png');
    return res.status(200).send(pngBuffer);
  })
);

/**
 * GET /companies/me/unidades/:id/qrcode-base64
 * Mesma coisa, mas devolve como data URL base64 dentro de um JSON — útil
 * para um painel web em React embutir a imagem direto num <img src="...">
 * sem precisar de uma segunda requisição.
 */
router.get(
  '/me/unidades/:id/qrcode-base64',
  companyPanelAuth,
  asyncHandler(async (req, res) => {
    const unidade = await buscarUnidadeDaEmpresa(req.params.id, req.panelCompanyId!);
    if (!unidade) return res.status(404).json({ error: 'Unidade não encontrada.' });

    const dataUrl = await QRCode.toDataURL(unidade.qrCodeToken, { width: 400, margin: 2 });
    return res.status(200).json({ qrCodeDataUrl: dataUrl });
  })
);

/**
 * GET /companies/me/compartilhamentos
 * Histórico de compartilhamentos recebidos pela empresa (LogAcesso), com os
 * dados atuais do cliente já resolvidos para os campos liberados naquele
 * evento — inclui a foto do cliente (fotoUrl) sempre que FOTO estiver entre
 * eles. É a "tela do lojista": o que apareceu quando um cliente aproximou o
 * NFC ou leu o QR Code. Sem paginação por ora (50 mais recentes) — ok pro
 * volume de um piloto.
 */
router.get(
  '/me/compartilhamentos',
  companyPanelAuth,
  asyncHandler(async (req, res) => {
    const logs = await prisma.logAcesso.findMany({
      where: { companyId: req.panelCompanyId },
      include: { user: true },
      orderBy: { timestamp: 'desc' },
      take: 50,
    });

    // Pareamentos (accessCount/lastAccessedAt) de quem aparece nos logs —
    // uma query só pra todo mundo, não uma por linha.
    const autorizacoes = await prisma.autorizacao.findMany({
      where: { companyId: req.panelCompanyId, userId: { in: [...new Set(logs.map((l) => l.userId))] } },
      select: { userId: true, accessCount: true, lastAccessedAt: true },
    });
    const pareamentoPorUsuario = new Map(autorizacoes.map((a) => [a.userId, a]));

    const resposta = logs.map((log) => {
      const pareamento = pareamentoPorUsuario.get(log.userId);
      return {
        id: log.id,
        metodo: log.metodo,
        timestamp: log.timestamp,
        camposRecebidos: log.camposEnviados,
        dados: montarPayloadDados(log.user, log.camposEnviados),
        accessCount: pareamento?.accessCount ?? null,
        lastAccessedAt: pareamento?.lastAccessedAt ?? null,
      };
    });

    return res.status(200).json(resposta);
  })
);

const webhookSchema = z.object({
  webhookUrl: z.string().url().nullable(),
});

/**
 * PUT /companies/me/webhook
 * Configura (ou remove, enviando null) a URL que o FIXO PASS chama
 * automaticamente sempre que um cliente aprova um compartilhamento.
 * Alternativa ao polling em GET /auth/request/:id.
 */
router.put(
  '/me/webhook',
  companyPanelAuth,
  asyncHandler(async (req, res) => {
    const parsed = webhookSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos.', detalhes: parsed.error.flatten() });
    }

    const company = await prisma.company.update({
      where: { id: req.panelCompanyId },
      data: { webhookUrl: parsed.data.webhookUrl },
    });

    return res.status(200).json({ webhookUrl: company.webhookUrl });
  })
);

/**
 * POST /companies/me/api-key/regenerate
 * Gera uma nova API Key e substitui o hash salvo — a key anterior para de
 * funcionar imediatamente. Não existe forma de recuperar/reexibir uma key
 * já existente (só o hash bcrypt é persistido), então isso é o único jeito
 * de a empresa obter uma API Key de novo caso tenha perdido a original.
 * Devolve a nova key em texto puro UMA vez, mesmo padrão do cadastro.
 */
router.post(
  '/me/api-key/regenerate',
  companyPanelAuth,
  asyncHandler(async (req, res) => {
    const apiKeyPlaintext = gerarApiKey();
    const apiKeyHash = await bcrypt.hash(apiKeyPlaintext, 10);

    await prisma.company.update({
      where: { id: req.panelCompanyId },
      data: { apiKeyHash },
    });

    return res.status(200).json({
      apiKey: apiKeyPlaintext,
      aviso: 'Guarde esta API Key com segurança — ela não será mostrada novamente. A API Key anterior parou de funcionar.',
    });
  })
);

const forgotPasswordSchema = z.object({
  emailContato: z.string().email(),
});

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hora

/**
 * POST /companies/forgot-password
 * Inicia o fluxo de "esqueci minha senha" do painel web da empresa.
 * Sempre responde com a mesma mensagem genérica, exista ou não o e-mail,
 * para não permitir enumerar e-mails cadastrados por tentativa e erro.
 */
router.post(
  '/forgot-password',
  asyncHandler(async (req, res) => {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos.', detalhes: parsed.error.flatten() });
    }

    const company = await prisma.company.findUnique({ where: { emailContato: parsed.data.emailContato } });

    if (company) {
      const tokenPlaintext = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(tokenPlaintext).digest('hex');

      await prisma.company.update({
        where: { id: company.id },
        data: {
          resetPasswordTokenHash: tokenHash,
          resetPasswordExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        },
      });

      const linkReset = `${process.env.PANEL_URL || 'https://painel.fixopass.com'}/redefinir-senha?token=${tokenPlaintext}`;
      await enviarEmailRecuperacaoSenha(company.emailContato, linkReset);
    }

    return res.status(200).json({
      mensagem: 'Se este e-mail estiver cadastrado, enviaremos instruções para redefinir a senha.',
    });
  })
);

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  novaSenha: z.string().min(6),
});

/**
 * POST /companies/reset-password
 * Conclui o fluxo de "esqueci minha senha": troca a senha usando o token
 * recebido por e-mail em POST /companies/forgot-password.
 */
router.post(
  '/reset-password',
  asyncHandler(async (req, res) => {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos.', detalhes: parsed.error.flatten() });
    }

    const tokenHash = crypto.createHash('sha256').update(parsed.data.token).digest('hex');
    const company = await prisma.company.findUnique({ where: { resetPasswordTokenHash: tokenHash } });

    if (!company || !company.resetPasswordExpiresAt || company.resetPasswordExpiresAt < new Date()) {
      return res.status(400).json({ error: 'Token inválido ou expirado.' });
    }

    const senhaHash = await bcrypt.hash(parsed.data.novaSenha, 10);

    await prisma.company.update({
      where: { id: company.id },
      data: { senhaHash, resetPasswordTokenHash: null, resetPasswordExpiresAt: null },
    });

    return res.status(200).json({ mensagem: 'Senha redefinida com sucesso.' });
  })
);

/**
 * POST /companies/me/pix
 * Gera uma cobrança PIX REAL (Asaas, API v3) pra renovar a mensalidade da
 * empresa logada — usada pela tela de checkout quando o trial/assinatura
 * expira, mas também disponível a qualquer momento pra quem quiser renovar
 * antecipado. Devolve o QR Code (imagem base64) e o código "copia e cola".
 *
 * A confirmação de pagamento chega depois via POST /webhooks/asaas — esta
 * rota só CRIA a cobrança, não ativa nada sozinha.
 *
 * Sem ASAAS_API_KEY configurado no servidor, devolve 503 (fail closed) em
 * vez de inventar um QR Code que não seria pago de verdade.
 */
router.post(
  '/me/pix',
  companyPanelAuth,
  asyncHandler(async (req, res) => {
    const company = await prisma.company.findUnique({ where: { id: req.panelCompanyId } });
    if (!company) {
      return res.status(404).json({ error: 'Empresa não encontrada.' });
    }

    try {
      const cobranca = await criarCobrancaPix(company);
      return res.status(201).json(cobranca);
    } catch (err) {
      if (err instanceof AsaasNaoConfiguradoError) {
        return res.status(503).json({ error: err.message });
      }
      throw err;
    }
  })
);

const integracaoSchema = z.object({
  nome: z.string().min(2),
  redirectUris: z.array(z.string().url()).min(1).max(5),
});

// Nota de nomenclatura: as rotas continuam em /companies/me/integracoes,
// com os mesmos nomes de campo no JSON (nome, clientId, clientSecret,
// redirectUris, status) — é o contrato que app/index.html (painel da
// empresa) já consome. Por baixo, o model agora é OAuthClient (schema
// renomeado pra OAuth2 "de verdade" — ver auditoria); só o nome interno
// (`name`) e o enum de status (ACTIVE/REVOKED) mudaram.

/**
 * POST /companies/me/integracoes
 * Cria um OAuthClient do canal WEB/API (ex.: "Cardápio Online") —
 * client_id + client_secret + redirect URIs cadastradas. Mesmo padrão de
 * POST /companies (API Key): o client_secret em texto puro só existe nesta
 * resposta, só o hash (bcrypt) fica salvo.
 */
router.post(
  '/me/integracoes',
  companyPanelAuth,
  asyncHandler(async (req, res) => {
    const parsed = integracaoSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos.', detalhes: parsed.error.flatten() });
    }

    const clientSecretPlaintext = gerarClientSecret();
    const clientSecretHash = await bcrypt.hash(clientSecretPlaintext, 10);

    const oauthClient = await prisma.oAuthClient.create({
      data: {
        companyId: req.panelCompanyId!,
        name: parsed.data.nome,
        redirectUris: parsed.data.redirectUris,
        clientSecretHash,
      },
    });

    return res.status(201).json({
      id: oauthClient.id,
      nome: oauthClient.name,
      clientId: oauthClient.clientId,
      clientSecret: clientSecretPlaintext,
      redirectUris: oauthClient.redirectUris,
      status: oauthClient.status,
      aviso: 'Guarde o Client Secret com segurança — ele não será mostrado novamente. Configure-o apenas no backend do seu sistema, nunca no navegador.',
    });
  })
);

/**
 * GET /companies/me/integracoes
 * Lista os OAuthClients da empresa (nunca inclui o client_secret/hash).
 */
router.get(
  '/me/integracoes',
  companyPanelAuth,
  asyncHandler(async (req, res) => {
    const oauthClients = await prisma.oAuthClient.findMany({
      where: { companyId: req.panelCompanyId },
      select: { id: true, name: true, clientId: true, redirectUris: true, status: true, createdAt: true, revokedAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return res.status(200).json(
      oauthClients.map((c) => ({
        id: c.id,
        nome: c.name,
        clientId: c.clientId,
        redirectUris: c.redirectUris,
        status: c.status,
        createdAt: c.createdAt,
        revogadaEm: c.revokedAt,
      }))
    );
  })
);

/**
 * Confere que o OAuthClient pedido realmente pertence à empresa logada no
 * painel — mesmo padrão de buscarUnidadeDaEmpresa, pra uma empresa nunca
 * conseguir editar/revogar o client de outra.
 */
async function buscarIntegracaoDaEmpresa(id: string, companyId: string) {
  const oauthClient = await prisma.oAuthClient.findUnique({ where: { id } });
  if (!oauthClient || oauthClient.companyId !== companyId) return null;
  return oauthClient;
}

const atualizarIntegracaoSchema = z
  .object({
    nome: z.string().min(2).optional(),
    redirectUris: z.array(z.string().url()).min(1).max(5).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Informe ao menos um campo para atualizar.' });

/**
 * PUT /companies/me/integracoes/:id
 * Edita nome e/ou redirect URIs. Não altera client_id nem client_secret.
 */
router.put(
  '/me/integracoes/:id',
  companyPanelAuth,
  asyncHandler(async (req, res) => {
    const oauthClient = await buscarIntegracaoDaEmpresa(req.params.id, req.panelCompanyId!);
    if (!oauthClient) return res.status(404).json({ error: 'Integração não encontrada.' });

    const parsed = atualizarIntegracaoSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos.', detalhes: parsed.error.flatten() });
    }

    const { nome, redirectUris } = parsed.data;
    const atualizada = await prisma.oAuthClient.update({
      where: { id: oauthClient.id },
      data: { ...(nome !== undefined && { name: nome }), ...(redirectUris !== undefined && { redirectUris }) },
    });
    return res.status(200).json({
      id: atualizada.id,
      nome: atualizada.name,
      clientId: atualizada.clientId,
      redirectUris: atualizada.redirectUris,
      status: atualizada.status,
    });
  })
);

/**
 * POST /companies/me/integracoes/:id/regenerate-secret
 * Gera um novo client_secret — o anterior para de funcionar imediatamente
 * (qualquer authorization_code/access_token emitido antes continua válido
 * até expirar normalmente; só a EMISSÃO de novos codes/tokens com o secret
 * antigo é que passa a falhar, já que o Basic Auth de POST /oauth/* deixa
 * de bater).
 */
router.post(
  '/me/integracoes/:id/regenerate-secret',
  companyPanelAuth,
  asyncHandler(async (req, res) => {
    const oauthClient = await buscarIntegracaoDaEmpresa(req.params.id, req.panelCompanyId!);
    if (!oauthClient) return res.status(404).json({ error: 'Integração não encontrada.' });
    if (oauthClient.status !== 'ACTIVE') {
      return res.status(409).json({ error: 'Esta integração está revogada. Reative-a antes de gerar um novo secret.' });
    }

    const clientSecretPlaintext = gerarClientSecret();
    const clientSecretHash = await bcrypt.hash(clientSecretPlaintext, 10);
    await prisma.oAuthClient.update({ where: { id: oauthClient.id }, data: { clientSecretHash } });

    return res.status(200).json({
      clientSecret: clientSecretPlaintext,
      aviso: 'Guarde com segurança — não será mostrado novamente. O client_secret anterior parou de funcionar.',
    });
  })
);

/**
 * DELETE /companies/me/integracoes/:id
 * Revoga o OAuthClient — POST /oauth/authorize e POST /oauth/token passam
 * a rejeitar suas credenciais imediatamente (oauthClientAuth checa
 * status === 'ACTIVE'). Não apaga o registro nem o histórico de
 * solicitações/compartilhamentos já feitos por ele, mesmo critério de
 * soft-delete já usado em DELETE /companies/me.
 */
router.delete(
  '/me/integracoes/:id',
  companyPanelAuth,
  asyncHandler(async (req, res) => {
    const oauthClient = await buscarIntegracaoDaEmpresa(req.params.id, req.panelCompanyId!);
    if (!oauthClient) return res.status(404).json({ error: 'Integração não encontrada.' });

    await prisma.oAuthClient.update({
      where: { id: oauthClient.id },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    return res.status(204).send();
  })
);

export default router;
