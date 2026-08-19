import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { companyAuth } from '../middleware/companyAuth';
import { userAuth } from '../middleware/userAuth';
import { asyncHandler } from '../lib/asyncHandler';
import { montarPayloadDados } from '../lib/dadosCompartilhados';
import { resolverAprovacao, SolicitacaoInvalidaError, SolicitacaoJaResolvidaError } from '../lib/compartilhamento';

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

    // Núcleo compartilhado com POST /integrations/authorize/:requestId (canal
    // WEB/API) — ver lib/compartilhamento.ts. Mesmo comportamento de sempre,
    // só que agora extraído pra ser reaproveitado pelos dois canais.
    let resultado;
    try {
      resultado = await resolverAprovacao({ solicitacaoId, userId, aprovar, camposLiberados });
    } catch (err) {
      if (err instanceof SolicitacaoInvalidaError) {
        return res.status(404).json({ error: 'Solicitação não encontrada.' });
      }
      if (err instanceof SolicitacaoJaResolvidaError) {
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }

    if (resultado.status === 'NEGADA') {
      return res.status(200).json({ status: 'NEGADA' });
    }

    return res.status(200).json({
      status: 'APROVADA',
      dados: resultado.dados,
      accessCount: resultado.accessCount,
      lastAccessedAt: resultado.lastAccessedAt,
    });
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

    return res.status(200).json({
      dados,
      accessCount: autorizacao.accessCount,
      lastAccessedAt: autorizacao.lastAccessedAt,
    });
  })
);

export default router;
