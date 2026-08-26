import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { isAdmin } from '../middleware/isAdmin';
import { asyncHandler } from '../lib/asyncHandler';
import { calcularDaysLeftInTrial, diasEmMs, PRECO_PADRAO_CENTAVOS } from '../lib/assinatura';
import { listarCandidatosLimpeza, apagarCandidatosLimpeza } from '../lib/limpezaDados';

const router = Router();
router.use(isAdmin);

router.post(
  '/auth',
  asyncHandler(async (_req, res) => {
    return res.status(200).json({ ok: true });
  })
);

const SORTABLE_FIELDS = ['nome', 'createdAt', 'status', 'precoMensalCentavos', 'trialEndsAt'] as const;

const companiesQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
  search: z.string().trim().min(1).optional(),
  status: z.enum(['ACTIVE', 'TRIAL', 'EXPIRED', 'BLOCKED']).optional(),
  categoria: z.enum(['RESTAURANTE', 'CONDOMINIO', 'HOSPITAL', 'HOTEL', 'LOJA', 'OUTROS']).optional(),
  sortBy: z.enum(SORTABLE_FIELDS).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

router.get(
  '/companies',
  asyncHandler(async (req, res) => {
    const parsed = companiesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Parametros invalidos.', detalhes: parsed.error.flatten() });
    }
    const { page, pageSize, search, status, categoria, sortBy, order } = parsed.data;

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (categoria) where.categoria = categoria;
    if (search) {
      where.OR = [
        { nome: { contains: search, mode: 'insensitive' } },
        { cnpj: { contains: search, mode: 'insensitive' } },
        { emailContato: { contains: search, mode: 'insensitive' } },
      ];
    }

    const orderBy: Record<string, 'asc' | 'desc'> = sortBy ? { [sortBy]: order } : { createdAt: 'desc' };

    const paginando = page !== undefined || pageSize !== undefined;
    const take = pageSize ?? 20;
    const currentPage = page ?? 1;

    const [companies, total] = await Promise.all([
      prisma.company.findMany({
        where,
        orderBy: orderBy as any,
        ...(paginando ? { skip: (currentPage - 1) * take, take } : {}),
      }),
      paginando ? prisma.company.count({ where }) : Promise.resolve(undefined),
    ]);

    const somaPorEmpresa = await prisma.autorizacao.groupBy({
      by: ['companyId'],
      where: { companyId: { in: companies.map((c) => c.id) } },
      _sum: { accessCount: true },
    });
    const accessCountPorEmpresa = new Map(somaPorEmpresa.map((s) => [s.companyId, s._sum.accessCount ?? 0]));

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
      accessCount: accessCountPorEmpresa.get(c.id) ?? 0,
      isTest: c.isTest,
      createdAt: c.createdAt,
    }));

    if (!paginando) {
      return res.status(200).json(resposta);
    }

    return res.status(200).json({
      empresas: resposta,
      page: currentPage,
      pageSize: take,
      total: total ?? 0,
      totalPages: Math.max(1, Math.ceil((total ?? 0) / take)),
    });
  })
);

const editSchema = z
  .object({
    precoMensalCentavos: z.number().int().nonnegative().nullable().optional(),
    diasExtras: z.number().int().optional(),
    status: z.enum(['ACTIVE', 'TRIAL', 'EXPIRED', 'BLOCKED']).optional(),
    isTest: z.boolean().optional(),
  })
  .refine(
    (d) =>
      d.precoMensalCentavos !== undefined ||
      d.diasExtras !== undefined ||
      d.status !== undefined ||
      d.isTest !== undefined,
    {
      message: 'Informe ao menos um campo para atualizar (precoMensalCentavos, diasExtras, status ou isTest).',
    }
  );

router.put(
  '/companies/:id',
  asyncHandler(async (req, res) => {
    const parsed = editSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados invalidos.', detalhes: parsed.error.flatten() });
    }

    const company = await prisma.company.findUnique({ where: { id: req.params.id } });
    if (!company) {
      return res.status(404).json({ error: 'Empresa nao encontrada.' });
    }

    const data: Record<string, unknown> = {};

    if (parsed.data.precoMensalCentavos !== undefined) {
      data.precoMensalCentavos = parsed.data.precoMensalCentavos;
    }

    if (parsed.data.isTest !== undefined) {
      data.isTest = parsed.data.isTest;
    }

    if (parsed.data.diasExtras !== undefined) {
      const base = company.trialEndsAt && company.trialEndsAt.getTime() > Date.now() ? company.trialEndsAt : new Date();
      const novoTrialEndsAt = new Date(base.getTime() + diasEmMs(parsed.data.diasExtras));
      data.trialEndsAt = novoTrialEndsAt;
      if (parsed.data.status === undefined && novoTrialEndsAt.getTime() > Date.now()) {
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

router.delete(
  '/companies/:id',
  asyncHandler(async (req, res) => {
    const company = await prisma.company.findUnique({ where: { id: req.params.id } });
    if (!company) {
      return res.status(404).json({ error: 'Empresa nao encontrada.' });
    }

    await prisma.company.update({
      where: { id: req.params.id },
      data: { ativa: false, encerradaEm: new Date() },
    });

    return res.status(204).send();
  })
);

router.get(
    '/companies/:id/logs',
    asyncHandler(async (req, res) => {
          const company = await prisma.company.findUnique({ where: { id: req.params.id } });
          if (!company) {
                  return res.status(404).json({ error: 'Empresa nao encontrada.' });
          }

          const logs = await prisma.logAcesso.findMany({
                  where: { companyId: req.params.id },
                  orderBy: { timestamp: 'desc' },
                  take: 200,
          });

          const autorizacoes = await prisma.autorizacao.findMany({
                  where: { companyId: req.params.id, userId: { in: [...new Set(logs.map((l) => l.userId))] } },
                  select: { userId: true, accessCount: true },
          });
          const accessCountPorUsuario = new Map(autorizacoes.map((a) => [a.userId, a.accessCount]));

          const resposta = logs.map((log) => ({
                  timestamp: log.timestamp,
                  metodo: log.metodo,
                  accessCount: accessCountPorUsuario.get(log.userId) ?? 0,
                  camposRecebidos: log.camposEnviados,
          }));

          return res.status(200).json(resposta);
    })
  );

router.get(
  '/dashboard-stats',
  asyncHandler(async (req, res) => {
    const includeTest = req.query.includeTest === 'true';

    const companies = await prisma.company.findMany({
      where: includeTest ? undefined : { isTest: false },
      select: { ativa: true, status: true, precoMensalCentavos: true, id: true },
    });

    const emAtividade = companies.filter((c) => c.ativa);
    const ativas = emAtividade.filter((c) => c.status === 'ACTIVE');
    const emTeste = emAtividade.filter((c) => c.status === 'TRIAL');
    const inadimplentes = emAtividade.filter((c) => c.status === 'EXPIRED' || c.status === 'BLOCKED');

    const faturamentoEstimadoCentavos = ativas.reduce((soma, c) => soma + (c.precoMensalCentavos ?? PRECO_PADRAO_CENTAVOS), 0);

    const somaPareamentos = await prisma.autorizacao.aggregate({
      _sum: { accessCount: true },
      where: includeTest ? undefined : { companyId: { in: companies.map((c) => c.id) } },
    });

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

router.get(
  '/pairings-stats',
  asyncHandler(async (req, res) => {
    const daysParsed = z.coerce.number().int().positive().max(365).default(30).safeParse(req.query.days);
    if (!daysParsed.success) {
      return res.status(400).json({ error: 'Parametro days invalido.', detalhes: daysParsed.error.flatten() });
    }
    const days = daysParsed.data;
    const desde = new Date(Date.now() - diasEmMs(days));

    const linhas = await prisma.$queryRaw<{ dia: Date; total: bigint }[]>`
      SELECT DATE(\"timestamp\") AS dia, COUNT(*) AS total
      FROM \"logs_acesso\"
      WHERE \"timestamp\" >= ${desde}
      GROUP BY DATE(\"timestamp\")
      ORDER BY DATE(\"timestamp\") ASC
    `;

    return res.status(200).json({
      diasConsiderados: days,
      serie: linhas.map((l) => ({ data: l.dia, total: Number(l.total) })),
    });
  })
);

router.get(
  '/categories-stats',
  asyncHandler(async (req, res) => {
    const includeTest = req.query.includeTest === 'true';

    const companies = await prisma.company.findMany({
      where: includeTest ? undefined : { isTest: false },
      select: { categoria: true, status: true, ativa: true, precoMensalCentavos: true },
    });

    const porCategoria = new Map();
    for (const c of companies) {
      const atual = porCategoria.get(c.categoria) ?? {
        categoria: c.categoria,
        totalEmpresas: 0,
        ativas: 0,
        faturamentoEstimadoCentavos: 0,
      };
      atual.totalEmpresas += 1;
      if (c.ativa) {
        atual.ativas += 1;
        if (c.status === 'ACTIVE') {
          atual.faturamentoEstimadoCentavos += c.precoMensalCentavos ?? PRECO_PADRAO_CENTAVOS;
        }
      }
      porCategoria.set(c.categoria, atual);
    }

    return res.status(200).json({
      categorias: Array.from(porCategoria.values()).sort((a, b) => b.totalEmpresas - a.totalEmpresas),
    });
  })
);

router.get(
  '/alerts',
  asyncHandler(async (_req, res) => {
    const companies = await prisma.company.findMany({
      where: {
        isTest: false,
        ativa: true,
        OR: [{ status: 'TRIAL' }, { status: 'EXPIRED' }, { status: 'BLOCKED' }],
      },
    });

    const comDaysLeft = companies.map((c) => ({ ...c, daysLeftInTrial: calcularDaysLeftInTrial(c) }));

    const trialAcabando = comDaysLeft
      .filter((c) => c.status === 'TRIAL' && c.daysLeftInTrial <= 5)
      .sort((a, b) => a.daysLeftInTrial - b.daysLeftInTrial);

    const inadimplentes = comDaysLeft
      .filter((c) => c.status === 'EXPIRED' || c.status === 'BLOCKED')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const paraResposta = (c: (typeof comDaysLeft)[number]) => ({
      tipo: c.status === 'TRIAL' ? 'TRIAL_VENCENDO' : 'INADIMPLENTE',
      id: c.id,
      nome: c.nome,
      cnpj: c.cnpj,
      emailContato: c.emailContato,
      status: c.status,
      trialEndsAt: c.trialEndsAt,
      daysLeftInTrial: c.daysLeftInTrial,
      nextDueDate: c.nextDueDate,
    });

    const alertas = [...trialAcabando.map(paraResposta), ...inadimplentes.map(paraResposta)];

    return res.status(200).json({
      total: alertas.length,
      alertas,
    });
  })
);

router.get(
  '/users-stats',
  asyncHandler(async (req, res) => {
    const daysParsed = z.coerce.number().int().positive().default(30).safeParse(req.query.days);
    if (!daysParsed.success) {
      return res.status(400).json({ error: 'Parametro days invalido.', detalhes: daysParsed.error.flatten() });
    }
    const days = daysParsed.data;

    const desde = new Date(Date.now() - diasEmMs(days));
    const desdeAtividade = new Date(Date.now() - diasEmMs(30));

    const [totalUsuarios, novosNoPeriodo, porOrigem, usuariosAtivosIds] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: desde } } }),
      prisma.user.groupBy({ by: ['origem'], _count: { _all: true } }),
      prisma.logAcesso.findMany({
        where: { timestamp: { gte: desdeAtividade } },
        select: { userId: true },
        distinct: ['userId'],
      }),
    ]);

    const ativos = usuariosAtivosIds.length;

    return res.status(200).json({
      totalUsuarios,
      novosNoPeriodo,
      periodoDias: days,
      ativos,
      inativos: totalUsuarios - ativos,
      porOrigem: porOrigem.map((g) => ({ origem: g.origem, total: g._count._all })),
    });
  })
);

router.get(
  '/dashboard-history',
  asyncHandler(async (req, res) => {
    const daysParsed = z.coerce.number().int().positive().max(365).default(30).safeParse(req.query.days);
    if (!daysParsed.success) {
      return res.status(400).json({ error: 'Parametro days invalido.', detalhes: daysParsed.error.flatten() });
    }
    const days = daysParsed.data;
    const includeTest = req.query.includeTest === 'true';

    const hojeUtc = new Date(Date.now());
    const inicioHojeUtc = Date.UTC(hojeUtc.getUTCFullYear(), hojeUtc.getUTCMonth(), hojeUtc.getUTCDate());
    const primeiroDiaJanela = inicioHojeUtc - (days - 1) * 24 * 60 * 60 * 1000;

    const [companies, logs] = await Promise.all([
      prisma.company.findMany({
        where: includeTest ? undefined : { isTest: false },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.logAcesso.findMany({
        where: includeTest ? undefined : { company: { isTest: false } },
        select: { timestamp: true },
        orderBy: { timestamp: 'asc' },
      }),
    ]);

    const empresasOrdenadas = companies.map((c) => c.createdAt.getTime()).sort((a, b) => a - b);
    const logsOrdenados = logs.map((l) => l.timestamp.getTime()).sort((a, b) => a - b);

    let ponteiroEmpresas = 0;
    let ponteiroLogs = 0;
    const serie = [];

    for (let i = 0; i < days; i++) {
      const fimDoDia = primeiroDiaJanela + (i + 1) * 24 * 60 * 60 * 1000;
      while (ponteiroEmpresas < empresasOrdenadas.length && empresasOrdenadas[ponteiroEmpresas] < fimDoDia) {
        ponteiroEmpresas++;
      }
      while (ponteiroLogs < logsOrdenados.length && logsOrdenados[ponteiroLogs] < fimDoDia) {
        ponteiroLogs++;
      }
      const dataDoDia = new Date(primeiroDiaJanela + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      serie.push({ data: dataDoDia, totalEmpresas: ponteiroEmpresas, totalPareamentos: ponteiroLogs });
    }

    return res.status(200).json({
      aviso:
        'Historico calculado sob demanda (sem snapshot diario/cron): os valores refletem o estado atual projetado ' +
        'para tras por data de criacao/acesso, nao o que o painel mostrava naquele dia. Uma empresa excluida ou uma ' +
        'mudanca de marcacao de teste depois do fato nao aparece retroativamente.',
      serie,
    });
  })
);

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
    confirmar: z.literal(true),
  })
  .refine((d) => d.companyIds.length > 0 || d.userIds.length > 0, {
    message: 'Informe ao menos um id em companyIds ou userIds (use GET /admin/dados-teste pra obte-los).',
  });

router.delete(
  '/dados-teste',
  asyncHandler(async (req, res) => {
    const parsed = limpezaSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados invalidos.', detalhes: parsed.error.flatten() });
    }

    const resultado = await apagarCandidatosLimpeza(parsed.data.companyIds, parsed.data.userIds);
    return res.status(200).json(resultado);
  })
);

export default router;
