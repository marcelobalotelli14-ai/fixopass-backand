import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/asyncHandler';
import { MENSALIDADE_DIAS, diasEmMs } from '../lib/assinatura';
import { consultarPagamento, MercadoPagoNaoConfiguradoError } from '../lib/mercadopago';
import {
  consultarPagamento as consultarPagamentoAsaas,
  pagamentoAsaasFoiConfirmado,
  AsaasNaoConfiguradoError,
  PagamentoAsaasNaoEncontradoError,
} from '../lib/asaas';

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

/**
 * POST /webhooks/mercadopago
 * Notificação REAL do Mercado Pago (configurada como notification_url da
 * aplicação, ou recebida via IPN legado) — confirmação de pagamento PIX
 * criado em POST /companies/me/pix.
 *
 * SEGURANÇA: diferente de POST /webhooks/payment (segredo compartilhado
 * simples), esta rota não confia em nada do que chega na notificação além
 * do id do pagamento. Assim que recebe um aviso, ela CONSULTA o pagamento
 * de verdade na API do Mercado Pago (GET /v1/payments/:id) usando nosso
 * próprio MERCADOPAGO_ACCESS_TOKEN — só esse token consegue fazer essa
 * consulta responder "approved", então não dá pra forjar uma ativação só
 * mandando um POST pra essa URL com um payload inventado. Isso segue a
 * própria recomendação do Mercado Pago de sempre re-consultar o pagamento
 * em vez de confiar cegamente no corpo da notificação.
 * https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/additional-content/notifications/webhooks
 *
 * O Mercado Pago manda o id do pagamento de duas formas possíveis
 * (dependendo de como a notificação foi configurada): no corpo
 * `{ type: 'payment', data: { id } }` (webhooks novos) ou na query string
 * `?topic=payment&id=...` (IPN legado) — esta rota aceita as duas.
 *
 * Sem MERCADOPAGO_ACCESS_TOKEN configurado, recusa com 503 (fail closed) —
 * sem a credencial não dá nem pra confirmar se o pagamento é real.
 */
router.post(
  '/mercadopago',
  asyncHandler(async (req, res) => {
    const tipo = req.body?.type ?? req.query.topic;
    const paymentId = req.body?.data?.id ?? req.query.id;

    // Mercado Pago também notifica outros tipos de evento (merchant_order,
    // etc.) que não nos interessam aqui — só respondemos 200 e ignoramos,
    // pra ele não ficar reenviando à toa.
    if (tipo !== 'payment' || !paymentId) {
      return res.status(200).json({ ignorado: true });
    }

    let statusPagamento;
    try {
      statusPagamento = await consultarPagamento(String(paymentId));
    } catch (err) {
      if (err instanceof MercadoPagoNaoConfiguradoError) {
        return res.status(503).json({ error: err.message });
      }
      throw err;
    }

    if (!statusPagamento.companyId) {
      return res.status(200).json({ aviso: 'Pagamento sem external_reference — não sei a qual empresa pertence.' });
    }

    if (statusPagamento.status !== 'approved') {
      // Pendente, rejeitado, cancelado... nada a fazer ainda; o Mercado
      // Pago manda uma nova notificação quando o status mudar de verdade.
      return res.status(200).json({ status: statusPagamento.status, aplicado: false });
    }

    const company = await prisma.company.findUnique({ where: { id: statusPagamento.companyId } });
    if (!company) {
      return res.status(200).json({ aviso: 'Empresa do external_reference não encontrada.' });
    }

    // Idempotência: o Mercado Pago pode reenviar a mesma notificação mais de
    // uma vez — sem essa checagem, cada reenvio somaria +30 dias de novo.
    if (company.ultimoPagamentoIdProcessado === statusPagamento.paymentId) {
      return res.status(200).json({ status: 'approved', aplicado: false, motivo: 'já processado' });
    }

    const base = company.nextDueDate && company.nextDueDate.getTime() > Date.now() ? company.nextDueDate : new Date();
    const nextDueDate = new Date(base.getTime() + diasEmMs(MENSALIDADE_DIAS));

    const atualizada = await prisma.company.update({
      where: { id: company.id },
      data: {
        status: 'ACTIVE',
        nextDueDate,
        trialEndsAt: null,
        ultimoPagamentoIdProcessado: statusPagamento.paymentId,
      },
    });

    return res.status(200).json({
      companyId: atualizada.id,
      status: atualizada.status,
      nextDueDate: atualizada.nextDueDate,
      aplicado: true,
    });
  })
);

/**
 * POST /webhooks/asaas
 * Notificação REAL do Asaas (configurada em Integrações > Webhooks, no
 * painel do Asaas) — confirmação de pagamento PIX criado em
 * POST /companies/me/pix. Escuta os eventos `PAYMENT_RECEIVED` (PIX/dinheiro
 * — o principal aqui) e `PAYMENT_CONFIRMED` (outros meios); qualquer outro
 * evento é apenas confirmado com 200 e ignorado.
 *
 * SEGURANÇA — duas camadas:
 *  1) Autenticação do webhook: o Asaas manda o "Token de autenticação" que
 *     você configurar no painel de volta no header `asaas-access-token` —
 *     comparamos contra ASAAS_WEBHOOK_TOKEN (segredo compartilhado). Sem essa
 *     env var configurada, a rota recusa tudo com 503 (fail closed).
 *  2) Mesmo com o token batendo, não confiamos no conteúdo da notificação:
 *     assim que recebe o aviso, esta rota CONSULTA o pagamento de verdade na
 *     API do Asaas (GET /v3/payments/:id) usando nossa própria
 *     ASAAS_API_KEY — só essa consulta decide se o pagamento foi mesmo
 *     recebido, então não dá pra forjar uma ativação só mandando um POST com
 *     um payload inventado (mesmo padrão já usado em POST /webhooks/mercadopago).
 * https://docs.asaas.com/docs/webhook-de-cobrancas
 *
 * Sem ASAAS_API_KEY configurado, recusa com 503 (fail closed) — sem a
 * credencial não dá nem pra confirmar se o pagamento é real.
 */

/**
 * GET /webhooks/asaas
 * Não é chamado pelo Asaas de verdade (ele só faz POST) — existe só pra um
 * teste de conectividade (curl, painel do provedor, etc.) confirmar que a
 * URL existe e responde, sem precisar de token nem tocar em nada. Método
 * GET não tem efeito colateral, então não tem risco de segurança em deixar
 * sem autenticação — é só um "sim, este endpoint existe".
 */
router.get('/asaas', (_req, res) => res.status(200).json({ status: 'ok' }));

router.post(
  '/asaas',
  asyncHandler(async (req, res) => {
    const tokenEsperado = process.env.ASAAS_WEBHOOK_TOKEN;
    if (!tokenEsperado) {
      return res.status(503).json({ error: 'Webhook do Asaas não configurado (ASAAS_WEBHOOK_TOKEN ausente no servidor).' });
    }
    if (req.header('asaas-access-token') !== tokenEsperado) {
      return res.status(401).json({ error: 'Token do webhook inválido.' });
    }

    const evento = req.body?.event;
    const paymentId = req.body?.payment?.id;

    // O Asaas manda outros eventos (PAYMENT_CREATED, PAYMENT_OVERDUE,
    // PAYMENT_DELETED...) que não nos interessam aqui — só respondemos 200 e
    // ignoramos, pra ele não ficar reenviando à toa.
    if ((evento !== 'PAYMENT_RECEIVED' && evento !== 'PAYMENT_CONFIRMED') || !paymentId) {
      return res.status(200).json({ ignorado: true });
    }

    let statusPagamento;
    try {
      statusPagamento = await consultarPagamentoAsaas(String(paymentId));
    } catch (err) {
      if (err instanceof AsaasNaoConfiguradoError) {
        return res.status(503).json({ error: err.message });
      }
      // paymentId não existe na conta Asaas — nunca vai passar a existir só
      // porque o Asaas reenvia a mesma notificação (ex.: teste de
      // conectividade do painel, com um id fictício). Responder 200 aqui
      // evita que isso seja lido como "endpoint quebrado" e suspenda o
      // webhook de verdade (status "Interrompido"); outras falhas (rede,
      // instabilidade da API do Asaas) continuam virando 500 pra ele tentar
      // reenviar depois.
      if (err instanceof PagamentoAsaasNaoEncontradoError) {
        console.warn('[webhooks/asaas]', err.message);
        return res.status(200).json({ ignorado: true, aviso: err.message });
      }
      throw err;
    }

    if (!statusPagamento.companyId) {
      return res.status(200).json({ aviso: 'Pagamento sem externalReference — não sei a qual empresa pertence.' });
    }

    if (!pagamentoAsaasFoiConfirmado(statusPagamento.status)) {
      // Pendente, vencido, estornado... nada a fazer ainda; o Asaas manda
      // uma nova notificação quando o status mudar de verdade.
      return res.status(200).json({ status: statusPagamento.status, aplicado: false });
    }

    const company = await prisma.company.findUnique({ where: { id: statusPagamento.companyId } });
    if (!company) {
      return res.status(200).json({ aviso: 'Empresa do externalReference não encontrada.' });
    }

    // Idempotência: o Asaas pode reenviar a mesma notificação mais de uma
    // vez — sem essa checagem, cada reenvio somaria +30 dias de novo.
    if (company.ultimoPagamentoIdProcessado === statusPagamento.paymentId) {
      return res.status(200).json({ status: statusPagamento.status, aplicado: false, motivo: 'já processado' });
    }

    const base = company.nextDueDate && company.nextDueDate.getTime() > Date.now() ? company.nextDueDate : new Date();
    const nextDueDate = new Date(base.getTime() + diasEmMs(MENSALIDADE_DIAS));

    const atualizada = await prisma.company.update({
      where: { id: company.id },
      data: {
        status: 'ACTIVE',
        nextDueDate,
        trialEndsAt: null,
        ultimoPagamentoIdProcessado: statusPagamento.paymentId,
      },
    });

    return res.status(200).json({
      companyId: atualizada.id,
      status: atualizada.status,
      nextDueDate: atualizada.nextDueDate,
      aplicado: true,
    });
  })
);

export default router;
