import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { isAdmin } from '../middleware/isAdmin';
import { asyncHandler } from '../lib/asyncHandler';
import { calcularDaysLeftInTrial, diasEmMs, PRECO_PADRAO_CENTAVOS } from '../lib/assinatura';
import { listarCandidatosLimpeza, apagarCandidatosLimpeza } from '../lib/limpezaDados';

const router = Router();
router.use(isAdmin);

/**
 * POST /admin/auth
 * Endpoint dedicado só pra testar o X-ADMIN-SECRET, sem precisar buscar
 * stats/companies inteiros só pra descobrir se a senha está certa (o
 * admin-dashboard.html ainda valida via carregarTudo() — esta rota fica
 * disponível pra quando quiser trocar por essa checagem mais leve). Se a
 * requisição chegou até aqui é porque o middleware `isAdmin` já validou o
 * segredo — então só confirma com 200. Erros (401 segredo errado, 503 não
 * configurado) já saem direto do middleware, antes de chegar na rota.
 */
router.post(
  '/auth',
  asyncHandler(async (_req, res) => {
    return res.status(200).json({ ok: true });
  })
);

/**
 * GET /admin/companies
 * Lista todas as empresas (inclusive as com `ativa:false`/encerradas — o
 * Super Admin precisa ver o quadro completo) com status de assinatura,
 * dias de trial restantes e o preço mensal (customizado ou o padrão).
 */
router.get(
  '/companies',
  asyncHandler(async (_req, res) => {
    const companies = await prisma.company.findMany({ orderBy: { createdAt: 'desc' } });

    const resposta = companies.map((c) => ({
      id: c.id,
      nome: c.nome,
      cnpj: c.cnpj,
      categoria: c.categoria,
      emailContato: c.emailContato,
      ativa: c.ativa,
      status: c.status,
      trialEndsAt: c.trialEndsAt,
      daysLeftInTrial: calcularDaysLeftInTrial(c),
      nextDueDate: c.nextDueDate,
      precoMensalCentavos: c.precoMensalCentavos ?? PRECO_PADRAO_CENTAVOS,
      precoCustomizado: c.precoMensalCentavos !== null,
      createdAt: c.createdAt,
    }));

    return res.status(200).json(resposta);
  })
);

const editSchema = z
  .object({
    precoMensalCentavos: z.number().int().nonnegative().nullable().optional(),
    diasExtras: z.number().int().optional(),
    status: z.enum(['ACTIVE', 'TRIAL', 'EXPIRED', 'BLOCKED']).optional(),
  })
  .refine((d) => d.precoMensalCentavos !== undefined || d.diasExtras !== undefined || d.status !== undefined, {
    message: 'Informe ao menos um campo para atualizar (precoMensalCentavos, diasExtras ou status).',
  });

/**
 * PUT /admin/companies/:id
 * Super Admin edita preço customizado, soma/subtrai dias de trial e/ou
 * troca o status manualmente — os 3 num único endpoint, tudo opcional.
 *
 * `diasExtras`: some (ou subtrai, se negativo) a partir do trialEndsAt
 * atual (ou de agora, se não havia trial vigente). Se `status` não vier
 * junto nesse mesmo PUT e o novo trialEndsAt cair no futuro, o status volta
 * pra TRIAL sozinho — é o que o botão "+15 Dias de Teste" espera: dar mais
 * tempo já destrava a empresa que estava EXPIRED, sem precisar de um
 * segundo clique pra também mudar o status manualmente.
 */
router.put(
  '/companies/:id',
  asyncHandler(async (req, res) => {
    const parsed = editSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos.', detalhes: parsed.error.flatten() });
    }

    const company = await prisma.company.findUnique({ where: { id: req.params.id } });
    if (!company) {
      return res.status(404).json({ error: 'Empresa não encontrada.' });
    }

    const data: {
      precoMensalCentavos?: number | null;
      trialEndsAt?: Date;
      status?: 'ACTIVE' | 'TRIAL' | 'EXPIRED' | 'BLOCKED';
    } = {};

    if (parsed.data.precoMensalCentavos !== undefined) {
      data.precoMensalCentavos = parsed.data.precoMensalCentavos;
    }

    if (parsed.data.diasExtras !== undefined) {
      const base = company.trialEndsAt && company.trialEndsAt.getTime() > Date.now() ? company.trialEndsAt : new Date();
      data.trialEndsAt = new Date(base.getTime() + diasEmMs(parsed.data.diasExtras));
      if (parsed.data.status === undefined && data.trialEndsAt.getTime() > Date.now()) {
        data.status = 'TRIAL';
      }
    }

    if (parsed.data.status !== undefined) {
      data.status = parsed.data.status;
    }

    const atualizada = await prisma.company.update({ where: { id: req.params.id }, data });
    const { senhaHash, apiKeyHash, resetPasswordTokenHash, resetPasswordExpiresAt, ...perfil } = atualizada;

    return res.status(200).json({
      ...perfil,
      daysLeftInTrial: calcularDaysLeftInTrial(atualizada),
      precoMensalCentavos: atualizada.precoMensalCentavos ?? PRECO_PADRAO_CENTAVOS,
    });
  })
);

/**
 * DELETE /admin/companies/:id
 * Mesmo soft-delete de sempre (DELETE /companies/me), só que o Super Admin
 * pode acionar em nome de qualquer empresa — decisão deliberada de manter
 * consistente com o resto do sistema: nunca apaga unidades/logs/histórico
 * de verdade, só marca `ativa:false`.
 */
router.delete(
  '/companies/:id',
  asyncHandler(async (req, res) => {
    const company = await prisma.company.findUnique({ where: { id: req.params.id } });
    if (!company) {
      return res.status(404).json({ error: 'Empresa não encontrada.' });
    }

    await prisma.company.update({
      where: { id: req.params.id },
      data: { ativa: false, encerradaEm: new Date() },
    });

    return res.status(204).send();
  })
);

/**
 * GET /admin/dashboard-stats
 * Métricas globais pro topo do painel admin.
 */
router.get(
  '/dashboard-stats',
  asyncHandler(async (_req, res) => {
    const companies = await prisma.company.findMany({
      select: { ativa: true, status: true, precoMensalCentavos: true },
    });

    const emAtividade = companies.filter((c) => c.ativa);
    const ativas = emAtividade.filter((c) => c.status === 'ACTIVE');
    const emTeste = emAtividade.filter((c) => c.status === 'TRIAL');
    const inadimplentes = emAtividade.filter((c) => c.status === 'EXPIRED' || c.status === 'BLOCKED');

    const faturamentoEstimadoCentavos = ativas.reduce((soma, c) => soma + (c.precoMensalCentavos ?? PRECO_PADRAO_CENTAVOS), 0);

    const somaPareamentos = await prisma.autorizacao.aggregate({ _sum: { accessCount: true } });

    return res.status(200).json({
      totalEmpresas: companies.length,
      ativas: ativas.length,
      emTeste: emTeste.length,
      inadimplentes: inadimplentes.length,
      encerradas: companies.length - emAtividade.length,
      faturamentoEstimadoCentavos,
      volumePareamentos: somaPareamentos._sum.accessCount ?? 0,
    });
  })
);

/**
 * GET /admin/dados-teste
 * Preview (NÃO apaga nada) dos cadastros de empresa e usuário que a
 * heurística de src/lib/limpezaDados.ts identifica como FAKE/TESTE — os
 * mesmos dados plantados por prisma/seed.ts, mais qualquer nome/e-mail/cnpj
 * com cara de teste (domínios como example.com, palavras "teste"/"fake"/
 * "demo"/...). A conta configurada em ADMIN_MASTER_EMAIL/ADMIN_MASTER_CPF
 * nunca aparece aqui, mesmo que bata na heurística.
 *
 * SEMPRE confira esta lista manualmente antes de chamar
 * DELETE /admin/dados-teste com os ids — é uma heurística por
 * nome/e-mail/CNPJ/CPF, não uma flag confiável no banco.
 */
router.get(
  '/dados-teste',
  asyncHandler(async (_req, res) => {
    const candidatos = await listarCandidatosLimpeza();
    return res.status(200).json({
      total: candidatos.length,
      companies: candidatos.filter((c) => c.tipo === 'company'),
      users: candidatos.filter((c) => c.tipo === 'user'),
    });
  })
);

const limpezaSchema = z
  .object({
    companyIds: z.array(z.string().uuid()).default([]),
    userIds: z.array(z.string().uuid()).default([]),
    // Mensagem de "Valor inválido, esperado true" já sai traduzida pelo
    // errorMap global (ver src/lib/zodErrorMap.ts) — não precisa de mensagem
    // customizada aqui.
    confirmar: z.literal(true),
  })
  .refine((d) => d.companyIds.length > 0 || d.userIds.length > 0, {
    message: 'Informe ao menos um id em companyIds ou userIds (use GET /admin/dados-teste pra obtê-los).',
  });

/**
 * DELETE /admin/dados-teste
 * Apaga DEFINITIVAMENTE (hard delete, não é o soft-delete de
 * DELETE /companies/me) as empresas/usuários cujos ids vierem em
 * companyIds/userIds — nunca a conta do Admin Master, e nunca um id que não
 * bata (de novo, no momento desta chamada) na heurística de
 * src/lib/limpezaDados.ts, mesmo que ele apareça no corpo da requisição.
 * `confirmar: true` é obrigatório, exatamente pra evitar apagar por engano
 * ao testar a rota.
 *
 * Fluxo esperado: 1) GET /admin/dados-teste, 2) revisar a lista, 3) DELETE
 * com os ids escolhidos + confirmar:true.
 */
router.delete(
  '/dados-teste',
  asyncHandler(async (req, res) => {
    const parsed = limpezaSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos.', detalhes: parsed.error.flatten() });
    }

    const resultado = await apagarCandidatosLimpeza(parsed.data.companyIds, parsed.data.userIds);
    return res.status(200).json(resultado);
  })
);

export default router;
