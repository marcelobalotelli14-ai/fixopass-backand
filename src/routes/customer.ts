import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { companyAuth } from '../middleware/companyAuth';
import { userAuth } from '../middleware/userAuth';
import { dispararWebhook } from '../lib/webhook';
import { asyncHandler } from '../lib/asyncHandler';
import { montarPayloadDados } from '../lib/dadosCompartilhados';

const router = Router();

const CAMPOS = ['NOME', 'TELEFONE', 'EMAIL', 'CPF', 'RG', 'DATA_NASCIMENTO', 'ENDERECO', 'FOTO'] as const;

const shareSchema = z.object({
  solicitacaoId: z.string().uuid(),
  aprovar: z.boolean(),
  // Campos que o usuário efetivamente decide liberar (pode ser um subconjunto do pedido)
  camposLiberados: z.array(z.enum(CAMPOS)).optional(),
});

/**
 * POST /customer/share
 * Chamado pelo APP DO USUÁRIO depois que ele toca em "Aceitar" na tela de
 * autorização. Atualiza a solicitação, grava/atualiza a autorização
 * permanente da empresa e devolve os dados liberados para o ERP consumir.
 */
router.post(
  '/share',
  userAuth,
  asyncHandler(async (req, res) => {
    const parsed = shareSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos.', detalhes: parsed.error.flatten() });
    }

    const { solicitacaoId, aprovar, camposLiberados } = parsed.data;
    const userId = req.userId!;

    const solicitacao = await prisma.solicitacaoCompartilhamento.findUnique({ where: { id: solicitacaoId } });

    if (!solicitacao || solicitacao.userId !== userId) {
      return res.status(404).json({ error: 'Solicitação não encontrada.' });
    }

    if (solicitacao.status !== 'PENDENTE') {
      return res.status(409).json({ error: `Solicitação já foi ${solicitacao.status.toLowerCase()}.` });
    }

    if (!aprovar) {
      await prisma.solicitacaoCompartilhamento.update({
        where: { id: solicitacaoId },
        data: { status: 'NEGADA', resolvidaEm: new Date() },
      });
      return res.status(200).json({ status: 'NEGADA' });
    }

    // BUG CORRIGIDO: antes, camposLiberados vindo do cliente era aceito sem
    // checagem — um app malicioso/com bug podia liberar campos que a empresa
    // nunca pediu (ex.: empresa pediu só Nome+Telefone, cliente "libera" CPF).
    // Agora filtramos para ser sempre um subconjunto do que foi pedido.
    const pedidos = new Set(solicitacao.camposPedidos);
    const camposValidos = (camposLiberados ?? []).filter((c) => pedidos.has(c));
    const campos = camposValidos.length > 0 ? camposValidos : solicitacao.camposPedidos;

    // Grava/atualiza a autorização permanente do usuário para essa empresa
    await prisma.autorizacao.upsert({
      where: { userId_companyId: { userId, companyId: solicitacao.companyId } },
      update: { camposLiberados: campos, ativo: true, dataAutorizacao: new Date(), dataRevogacao: null },
      create: {
        userId,
        companyId: solicitacao.companyId,
        camposLiberados: campos,
      },
    });

    await prisma.solicitacaoCompartilhamento.update({
      where: { id: solicitacaoId },
      data: { status: 'APROVADA', resolvidaEm: new Date() },
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const dadosLiberados = montarPayloadDados(user, campos);

    await prisma.logAcesso.create({
      data: {
        userId,
        companyId: solicitacao.companyId,
        camposEnviados: campos,
        metodo: solicitacao.metodo,
      },
    });

    // Entrega automática pro ERP da empresa, se ela tiver configurado um webhook.
    // Roda em segundo plano — não atrasa nem depende do resultado dessa resposta.
    const company = await prisma.company.findUnique({ where: { id: solicitacao.companyId } });
    if (company?.webhookUrl) {
      dispararWebhook(company.webhookUrl, {
        solicitacaoId,
        userId,
        companyId: solicitacao.companyId,
        dados: dadosLiberados,
      });
    }

    return res.status(200).json({ status: 'APROVADA', dados: dadosLiberados });
  })
);

/**
 * GET /customer/:id
 * Chamado pelo ERP da empresa para consultar os dados já autorizados
 * de um cliente (ex: cliente recorrente que já autorizou antes).
 * Só retorna os campos presentes na autorização ATIVA daquela empresa.
 */
router.get(
  '/:id',
  companyAuth,
  asyncHandler(async (req, res) => {
    const userId = req.params.id;
    const companyId = req.company!.id;

    const autorizacao = await prisma.autorizacao.findUnique({
      where: { userId_companyId: { userId, companyId } },
    });

    if (!autorizacao || !autorizacao.ativo) {
      return res.status(403).json({ error: 'Nenhuma autorização ativa para este usuário.' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }

    const dados = montarPayloadDados(user, autorizacao.camposLiberados);

    await prisma.logAcesso.create({
      data: {
        userId,
        companyId,
        camposEnviados: autorizacao.camposLiberados,
        // BUG CORRIGIDO: antes gravava 'QRCODE' mesmo quando não houve
        // nenhum evento de QR/NFC — era uma consulta direta da API. Isso
        // poluía o histórico de auditoria com um método que não aconteceu.
        metodo: 'CONSULTA_API',
      },
    });

    return res.status(200).json({ dados });
  })
);

export default router;
