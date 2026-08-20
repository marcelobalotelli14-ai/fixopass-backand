import { Router } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { userAuth } from '../middleware/userAuth';
import { asyncHandler } from '../lib/asyncHandler';
import { uploadFoto } from '../lib/upload';
import { cloudinary } from '../lib/cloudinary';
import { senhaConfere } from '../lib/senha';

const router = Router();

const cadastroSchema = z.object({
  nomeCompleto: z.string().min(3),
  telefone: z.string().min(8),
  email: z.string().email(),
  cpf: z.string().min(11).max(14),
  rg: z.string().optional(),
  dataNascimento: z.string().datetime().optional(), // ISO 8601
  endereco: z.string().optional(), // texto livre — mantido pelo mobile-app
  // Endereço estruturado (opcional, preenchido pela web) — ver comentário no schema.prisma.
  enderecoCep: z.string().optional(),
  enderecoLogradouro: z.string().optional(),
  enderecoNumero: z.string().optional(),
  enderecoComplemento: z.string().optional(),
  enderecoBairro: z.string().optional(),
  enderecoCidade: z.string().optional(),
  enderecoEstado: z.string().optional(),
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
 *
 * senhaConfere (ver lib/senha.ts) sempre roda o bcrypt.compare — mesmo
 * quando `user` é null — pra não vazar por timing se o e-mail existe ou não
 * no banco (mitigação de timing attack).
 */
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos.' });
    }

    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    const senhaOk = await senhaConfere(parsed.data.senha, user?.senhaHash);
    if (!user || !senhaOk) {
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

const trocarSenhaSchema = z.object({
  senhaAtual: z.string().min(1),
  novaSenha: z.string().min(6),
});

/**
 * PUT /users/me/senha
 * Troca de senha exigindo a senha atual (diferente de
 * POST /companies/forgot-password, que é fluxo de "esqueci a senha" por
 * token/e-mail — aqui o usuário já está logado e sabe a senha atual).
 */
router.put(
  '/me/senha',
  userAuth,
  asyncHandler(async (req, res) => {
    const parsed = trocarSenhaSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos.', detalhes: parsed.error.flatten() });
    }

    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    const senhaCorreta = await bcrypt.compare(parsed.data.senhaAtual, user.senhaHash);
    if (!senhaCorreta) {
      return res.status(401).json({ error: 'Senha atual incorreta.' });
    }

    const senhaHash = await bcrypt.hash(parsed.data.novaSenha, 10);
    await prisma.user.update({ where: { id: req.userId }, data: { senhaHash } });

    return res.status(204).send();
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
 * POST /users/me/foto
 * Recebe a foto de perfil (multipart/form-data, campo "foto"), envia pro
 * Cloudinary e salva a URL pública resultante em fotoUrl — mesmo padrão de
 * POST /companies/me/logo. Essa é a foto que aparece pra empresa quando o
 * campo FOTO estiver entre os liberados num compartilhamento
 * (ver montarPayloadDados em lib/dadosCompartilhados.ts).
 */
router.post(
  '/me/foto',
  userAuth,
  uploadFoto.single('foto'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado. Envie a imagem no campo "foto".' });
    }

    const resultadoUpload = await new Promise<{ secure_url: string }>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'fixopass/fotos-usuarios', public_id: req.userId, overwrite: true, resource_type: 'image' },
        (err, result) => {
          if (err || !result) return reject(err ?? new Error('Falha ao enviar imagem para o Cloudinary.'));
          resolve(result);
        }
      );
      stream.end(req.file!.buffer);
    });

    const user = await prisma.user.update({
      where: { id: req.userId },
      data: { fotoUrl: resultadoUpload.secure_url },
    });

    return res.status(200).json({ fotoUrl: user.fotoUrl });
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
      // companyId precisa ir junto — é o que a tela usa pra saber qual
      // empresa revogar em DELETE /users/me/autorizacoes/:companyId.
      companyId: a.companyId,
      empresa: a.company.nome,
      categoria: a.company.categoria,
      dadosLiberados: a.camposLiberados,
      dataAutorizacao: a.dataAutorizacao,
      accessCount: a.accessCount,
      lastAccessedAt: a.lastAccessedAt,
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

const CATEGORIAS_PRIVACIDADE = ['RESTAURANTE', 'CONDOMINIO', 'HOSPITAL', 'HOTEL', 'LOJA', 'OUTROS', 'GERAL'] as const;

// Mesmos defaults da coluna no schema.prisma (nome liberado, resto bloqueado)
// — usado só pra preencher categorias que o usuário ainda não configurou,
// sem criar uma linha no banco pra cada uma. Ver comentário completo em
// PrivacidadeCategoria no schema.prisma.
const PRIVACIDADE_PADRAO = { foto: false, nome: true, cpf: false, rg: false, dataNascimento: false, telefone: false, endereco: false };

/**
 * GET /users/me/privacidade
 * Preferências de compartilhamento por TIPO de estabelecimento (ex.: libera
 * Foto+Nome+Telefone pra restaurante, mas não CPF/RG/Endereço). Sempre
 * devolve as 7 categorias (RESTAURANTE..OUTROS + GERAL); pra quem ainda não
 * configurou uma categoria, devolve o padrão sugerido com `existe: false` —
 * a tela pode pré-marcar os toggles com isso, mas POST /auth/request só
 * aplica o filtro de fato pras categorias com `existe: true` (ver
 * filtrarCamposPorPrivacidade em auth.ts).
 */
router.get(
  '/me/privacidade',
  userAuth,
  asyncHandler(async (req, res) => {
    const salvas = await prisma.privacidadeCategoria.findMany({ where: { userId: req.userId } });
    const porCategoria = new Map(salvas.map((s) => [s.categoria, s]));

    const resposta = CATEGORIAS_PRIVACIDADE.map((categoria) => {
      const salva = porCategoria.get(categoria);
      if (salva) {
        const { id, userId, categoria: _categoria, createdAt, updatedAt, ...regras } = salva;
        return { categoria, ...regras, existe: true };
      }
      return { categoria, ...PRIVACIDADE_PADRAO, existe: false };
    });

    return res.status(200).json(resposta);
  })
);

const regraPrivacidadeSchema = z.object({
  categoria: z.enum(CATEGORIAS_PRIVACIDADE),
  foto: z.boolean(),
  nome: z.boolean(),
  cpf: z.boolean(),
  rg: z.boolean(),
  dataNascimento: z.boolean(),
  telefone: z.boolean(),
  endereco: z.boolean(),
});
const privacidadeSchema = z.object({
  categorias: z.array(regraPrivacidadeSchema).min(1),
});

/**
 * PUT /users/me/privacidade
 * Salva (upsert) as regras de uma ou mais categorias de uma vez — a tela
 * manda o estado atual de todas as abas que a pessoa mexeu.
 */
router.put(
  '/me/privacidade',
  userAuth,
  asyncHandler(async (req, res) => {
    const parsed = privacidadeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos.', detalhes: parsed.error.flatten() });
    }

    await prisma.$transaction(
      parsed.data.categorias.map(({ categoria, ...regras }) =>
        prisma.privacidadeCategoria.upsert({
          where: { userId_categoria: { userId: req.userId!, categoria } },
          update: regras,
          create: { userId: req.userId!, categoria, ...regras },
        })
      )
    );

    const atualizado = await prisma.privacidadeCategoria.findMany({ where: { userId: req.userId } });
    return res.status(200).json(atualizado);
  })
);

export default router;
