import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/asyncHandler';
import { MENSALIDADE_DIAS, diasEmMs } from '../lib/assinatura';

const router = Router();

const paymentWebhookSchema = z
  .object({
    companyId: z.string().uuid(),
  })
  // .passthrough() porque o gateway escolhido (Mercado Pago/Asaas) manda um
  // monte de outros campos (id da transação, valor, método...) que não
  // validamos estritamente aqui — só precisamos do companyId pra saber quem
  // ativar. Quando a integração de verdade entrar, provavelmente vale
  // mapear companyId a partir de um metadata/external_reference do gateway
  // em vez de esperar que ele mande esse campo — ajustar então.
  .passthrough();

/**
 * POST /webhooks/payment
 * Confirmação de pagamento (PIX ou cartão) via gateway — ativa a empresa
 * (status=ACTIVE) e soma 30 dias ao vencimento.
 *
 * ATENÇÃO — SEGURANÇA (leia antes de ligar num gateway de verdade):
 * Isso hoje só confere um segredo compartilhado simples (header
 * X-WEBHOOK-SECRET contra a env var PAYMENT_WEBHOOK_SECRET) — NÃO verifica
 * a assinatura/autenticidade oficial do Mercado Pago ou Asaas. Sem
 * credenciais reais de nenhum gateway configuradas ainda (confirmado com o
 * time de produto), essa é a proteção mínima possível: sem ela, qualquer
 * pessoa que descobrisse essa URL poderia "confirmar pagamentos" falsos e
 * destravar o serviço de graça pra sempre. Antes de conectar um gateway de
 * verdade, trocar essa checagem pela validação de assinatura oficial do
 * provedor escolhido:
 *   - Mercado Pago: valida o header `x-signature` (HMAC-SHA256) contra o
 *     webhook secret da conta — ver https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/additional-content/notifications/webhooks
 *   - Asaas: valida o token enviado no header configurado no painel do Asaas
 * Sem PAYMENT_WEBHOOK_SECRET configurado no ambiente, a rota recusa por
 * padrão (fail closed) — nunca fica aberta "por engano".
 */
router.post(
  '/payment',
  asyncHandler(async (req, res) => {
    const segredoEsperado = process.env.PAYMENT_WEBHOOK_SECRET;
    if (!segredoEsperado) {
      return res.status(503).json({ error: 'Webhook de pagamento não configurado (PAYMENT_WEBHOOK_SECRET ausente no servidor).' });
    }
    if (req.header('X-WEBHOOK-SECRET') !== segredoEsperado) {
      return res.status(401).json({ error: 'Segredo do webhook inválido.' });
    }

    const parsed = paymentWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Payload inválido.', detalhes: parsed.error.flatten() });
    }

    const { companyId } = parsed.data;
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) {
      return res.status(404).json({ error: 'Empresa não encontrada.' });
    }

    // Se já tinha um vencimento futuro (renovação antecipada), soma a partir
    // dele em vez de "perder" os dias que ainda restavam.
    const base = company.nextDueDate && company.nextDueDate.getTime() > Date.now() ? company.nextDueDate : new Date();
    const nextDueDate = new Date(base.getTime() + diasEmMs(MENSALIDADE_DIAS));

    const atualizada = await prisma.company.update({
      where: { id: companyId },
      data: { status: 'ACTIVE', nextDueDate, trialEndsAt: null },
    });

    return res.status(200).json({
      companyId: atualizada.id,
      status: atualizada.status,
      nextDueDate: atualizada.nextDueDate,
    });
  })
);

export default router;
