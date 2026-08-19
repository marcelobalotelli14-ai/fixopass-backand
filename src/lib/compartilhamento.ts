import { CampoDado } from '@prisma/client';
import { prisma } from './prisma';
import { montarPayloadDados } from './dadosCompartilhados';
import { dispararWebhook } from './webhook';

export class SolicitacaoInvalidaError extends Error {}

export class SolicitacaoJaResolvidaError extends Error {
  constructor(public statusAtual: string) {
    super(`Solicitação já foi ${statusAtual.toLowerCase()}.`);
  }
}

interface ResolverAprovacaoParams {
  solicitacaoId: string;
  userId: string;
  aprovar: boolean;
  camposLiberados?: CampoDado[];
}

interface ResolverAprovacaoResultado {
  status: 'APROVADA' | 'NEGADA';
  campos: CampoDado[];
  dados?: Record<string, unknown>;
  accessCount?: number;
  lastAccessedAt?: Date;
  companyId: string;
}

/**
 * Núcleo comum de "usuário decide sobre uma solicitação pendente" —
 * extraído de POST /customer/share para ser reaproveitado também por
 * POST /oauth/authorize/:requestId (canal WEB/API). Os dois fluxos
 * compartilham tudo até aqui: validar ownership/status, filtrar
 * camposLiberados pro subconjunto realmente pedido (nunca confiar
 * cegamente no que o cliente manda — é a mesma blindagem que já existia
 * em customer.ts), gravar/atualizar a Autorizacao permanente, marcar a
 * solicitação como resolvida, gravar o LogAcesso e disparar o webhook da
 * empresa (se configurado).
 *
 * O que muda entre os dois fluxos fica de fora daqui, no chamador: NFC/QR
 * (customer.ts) devolve `dados` direto pro app; WEB/API (integrations.ts)
 * NUNCA devolve dados pro navegador — só usa esse resultado pra decidir se
 * emite um authorization_code.
 */
export async function resolverAprovacao(params: ResolverAprovacaoParams): Promise<ResolverAprovacaoResultado> {
  const { solicitacaoId, userId, aprovar, camposLiberados } = params;

  const solicitacao = await prisma.solicitacaoCompartilhamento.findUnique({ where: { id: solicitacaoId } });
  if (!solicitacao || solicitacao.userId !== userId) {
    throw new SolicitacaoInvalidaError('Solicitação não encontrada.');
  }
  if (solicitacao.status !== 'PENDENTE') {
    throw new SolicitacaoJaResolvidaError(solicitacao.status);
  }

  if (!aprovar) {
    await prisma.solicitacaoCompartilhamento.update({
      where: { id: solicitacaoId },
      data: { status: 'NEGADA', resolvidaEm: new Date() },
    });
    return { status: 'NEGADA', campos: [], companyId: solicitacao.companyId };
  }

  // BUG CORRIGIDO (histórico, ver customer.ts): camposLiberados vindo do
  // cliente nunca é aceito sem checagem — sempre um subconjunto do que a
  // empresa realmente pediu em `solicitacao.camposPedidos`.
  const pedidos = new Set(solicitacao.camposPedidos);
  const camposValidos = (camposLiberados ?? []).filter((c) => pedidos.has(c));
  const campos = camposValidos.length > 0 ? camposValidos : solicitacao.camposPedidos;

  // Grava/atualiza a autorização permanente do usuário para essa empresa.
  // Cada aprovação é um "pareamento" — accessCount soma 1 se já existia.
  const autorizacaoAtualizada = await prisma.autorizacao.upsert({
    where: { userId_companyId: { userId, companyId: solicitacao.companyId } },
    update: {
      camposLiberados: campos,
      ativo: true,
      dataAutorizacao: new Date(),
      dataRevogacao: null,
      accessCount: { increment: 1 },
      lastAccessedAt: new Date(),
    },
    create: { userId, companyId: solicitacao.companyId, camposLiberados: campos },
  });

  await prisma.solicitacaoCompartilhamento.update({
    where: { id: solicitacaoId },
    data: { status: 'APROVADA', resolvidaEm: new Date() },
  });

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const dadosLiberados = montarPayloadDados(user, campos);

  await prisma.logAcesso.create({
    data: { userId, companyId: solicitacao.companyId, camposEnviados: campos, metodo: solicitacao.metodo },
  });

  // Entrega automática pro ERP da empresa, se ela tiver configurado um
  // webhook — mesmo evento independente do canal (NFC/QR/WEB_API) ter sido
  // a origem do pareamento. Roda em segundo plano.
  const company = await prisma.company.findUnique({ where: { id: solicitacao.companyId } });
  if (company?.webhookUrl) {
    dispararWebhook(company.webhookUrl, {
      solicitacaoId,
      userId,
      companyId: solicitacao.companyId,
      dados: dadosLiberados,
      accessCount: autorizacaoAtualizada.accessCount,
      lastAccessedAt: autorizacaoAtualizada.lastAccessedAt,
    });
  }

  return {
    status: 'APROVADA',
    campos,
    dados: dadosLiberados,
    accessCount: autorizacaoAtualizada.accessCount,
    lastAccessedAt: autorizacaoAtualizada.lastAccessedAt,
    companyId: solicitacao.companyId,
  };
}
