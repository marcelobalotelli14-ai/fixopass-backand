import { Router } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { userAuth } from '../middleware/userAuth';
import { asyncHandler } from '../lib/asyncHandler';

const router = Router();

const cadastroSchema = z.object({
  nomeCompleto: z.string().min(3),
  telefone: z.string().min(8),
  email: z.string().email(),
  cpf: z.string().min(11).max(14),
  rg: z.string().optional(),
  dataNascimento: z.string().datetime().optional(), // ISO 8601
  endereco: z.string().optional(),
  fotoUrl: z.string().url().optional(),
  senha: z.string().min(6),
});

/**
 * POST /users
 * Cadastro inicial do usuário no app (item 2 do roadmap).
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = cadastroSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos.', detalhes: parsed.error.flatten() });
    }

    const { senha, dataNascimento, ...dados } = parsed.data;

    const existente = await prisma.user.findFirst({
      where: { OR: [{ email: dados.email }, { cpf: dados.cpf }] },
    });
    if (existente) {
      return res.status(409).json({ error: 'Já existe um usuário com este e-mail ou CPF.' });
    }

    const senhaHash = await bcrypt.hash(senha, 10);

    const user = await prisma.user.create({
      data: {
        ...dados,
        dataNascimento: dataNascimento ? new Date(dataNascimento) : undefined,
        senhaHash,
      },
    });

    return res.status(201).json({
      id: user.id,
      nomeCompleto: user.nomeCompleto,
      email: user.email,
    });
  })
);

const loginSchema = z.object({
  email: z.string().email(),
  senha: z.string(),
});

/**
 * POST /users/login
 * MVP: retorna o userId a ser usado no header X-USER-ID nas próximas chamadas.
 * Trocar por emissão de JWT assim que o app mobile tiver fluxo de sessão real.
 */
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos.' });
    }

    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    if (!user || !(await bcrypt.compare(parsed.data.senha, user.senhaHash))) {
      return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
    }

    return res.status(200).json({ userId: user.id, nomeCompleto: user.nomeCompleto });
  })
);

/**
 * GET /users/me
 * Dados do próprio usuário logado (tela de perfil/edição no app).
 */
router.get(
  '/me',
  userAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const { senhaHash, ...perfil } = user;
    return res.status(200).json(perfil);
  })
);

const edicaoSchema = cadastroSchema.partial().omit({ senha: true });

/**
 * PUT /users/me
 * Usuário edita seus próprios dados (item "O usuário pode editar seus dados").
 * Se o e-mail/CPF novo já pertencer a outro usuário, o middleware de erro
 * global converte a violação de unicidade do Prisma num 409 amigável.
 */
router.put(
  '/me',
  userAuth,
  asyncHandler(async (req, res) => {
    const parsed = edicaoSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos.', detalhes: parsed.error.flatten() });
    }

    const { dataNascimento, ...resto } = parsed.data;

    const user = await prisma.user.update({
      where: { id: req.userId },
      data: {
        ...resto,
        dataNascimento: dataNascimento ? new Date(dataNascimento) : undefined,
      },
    });

    const { senhaHash, ...perfil } = user;
    return res.status(200).json(perfil);
  })
);

/**
 * DELETE /users/me
 * Exclusão definitiva da própria conta (LGPD). O schema tem
 * `onDelete: Cascade` de Autorizacao, SolicitacaoCompartilhamento e
 * LogAcesso para User, então apagar o usuário já remove tudo isso junto —
 * não precisa (e não deve) apagar essas tabelas manualmente aqui.
 */
router.delete(
  '/me',
  userAuth,
  asyncHandler(async (req, res) => {
    await prisma.user.delete({ where: { id: req.userId } });
    return res.status(204).send();
  })
);

/**
 * GET /users/me/autorizacoes
 * Tela "Empresas autorizadas": empresa, dados liberados e data da autorização.
 */
router.get(
  '/me/autorizacoes',
  userAuth,
  asyncHandler(async (req, res) => {
    const autorizacoes = await prisma.autorizacao.findMany({
      where: { userId: req.userId, ativo: true },
      include: { company: { select: { nome: true, categoria: true } } },
      orderBy: { dataAutorizacao: 'desc' },
    });

    const resposta = autorizacoes.map((a) => ({
      empresa: a.company.nome,
      categoria: a.company.categoria,
      dadosLiberados: a.camposLiberados,
      dataAutorizacao: a.dataAutorizacao,
    }));

    return res.status(200).json(resposta);
  })
);

/**
 * DELETE /users/me/autorizacoes/:companyId
 * Usuário revoga o acesso de uma empresa a qualquer momento.
 */
router.delete(
  '/me/autorizacoes/:companyId',
  userAuth,
  asyncHandler(async (req, res) => {
    const { companyId } = req.params;

    const autorizacao = await prisma.autorizacao.findUnique({
      where: { userId_companyId: { userId: req.userId!, companyId } },
    });
    if (!autorizacao) return res.status(404).json({ error: 'Autorização não encontrada.' });

    await prisma.autorizacao.update({
      where: { userId_companyId: { userId: req.userId!, companyId } },
      data: { ativo: false, dataRevogacao: new Date() },
    });

    return res.status(204).send();
  })
);

/**
 * PUT /users/me/push-token
 * O app chama isso depois de pedir permissão de notificação e obter o
 * Expo Push Token do dispositivo. Usado para avisar o usuário quando uma
 * empresa (via ERP/terminal) cria uma solicitação sem ele estar escaneando.
 */
router.put(
  '/me/push-token',
  userAuth,
  asyncHandler(async (req, res) => {
    const schema = z.object({ expoPushToken: z.string().nullable() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos.' });
    }

    await prisma.user.update({
      where: { id: req.userId },
      data: { expoPushToken: parsed.data.expoPushToken },
    });

    return res.status(204).send();
  })
);

export default router;
