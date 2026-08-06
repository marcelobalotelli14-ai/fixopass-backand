import { randomUUID } from 'crypto';
import { Company } from '@prisma/client';
import { PRECO_PADRAO_CENTAVOS } from './assinatura';

const MP_API_BASE = 'https://api.mercadopago.com';

/**
 * Integração REAL com a API de Pagamentos do Mercado Pago (não é mock/
 * placeholder) — gera uma cobrança PIX de verdade e consulta o status real
 * de um pagamento. Gated por MERCADOPAGO_ACCESS_TOKEN (env var): sem essa
 * credencial configurada, as funções abaixo lançam
 * MercadoPagoNaoConfiguradoError em vez de inventar um QR Code falso — as
 * rotas que usam isso (POST /companies/me/pix, POST /webhooks/mercadopago)
 * traduzem isso pra um 503 "fail closed", igual ao resto do backend.
 *
 * Como conseguir o token: painel do Mercado Pago > Suas integrações >
 * criar aplicação > Credenciais de produção > "Access Token".
 * https://www.mercadopago.com.br/developers/panel
 */
export class MercadoPagoNaoConfiguradoError extends Error {
  constructor() {
    super('Pagamento automático via PIX ainda não está configurado (MERCADOPAGO_ACCESS_TOKEN ausente no servidor).');
    this.name = 'MercadoPagoNaoConfiguradoError';
  }
}

function getAccessToken(): string {
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!token) throw new MercadoPagoNaoConfiguradoError();
  return token;
}

export interface CobrancaPix {
  paymentId: string;
  status: string;
  qrCode: string; // "copia e cola"
  qrCodeBase64: string; // imagem do QR Code, já em base64 (PNG)
  valorCentavos: number;
  expiraEm: string; // ISO — o Mercado Pago expira a cobrança PIX sozinho
}

/**
 * Cria uma cobrança PIX real pra renovação da mensalidade de `company`,
 * usando o preço customizado dela (se houver) ou o padrão. `external_reference`
 * carrega o companyId — é assim que o webhook (POST /webhooks/mercadopago)
 * sabe qual empresa ativar quando o Mercado Pago avisar que foi pago.
 */
export async function criarCobrancaPix(company: Pick<Company, 'id' | 'nome' | 'emailContato' | 'precoMensalCentavos'>): Promise<CobrancaPix> {
  const token = getAccessToken();
  const valorCentavos = company.precoMensalCentavos ?? PRECO_PADRAO_CENTAVOS;

  const resposta = await fetch(`${MP_API_BASE}/v1/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      // Evita duplicar a cobrança se a chamada for repetida (retry de rede) —
      // recomendação oficial do Mercado Pago para POST /v1/payments.
      'X-Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({
      transaction_amount: valorCentavos / 100,
      description: `FIXO PASS - Mensalidade (${company.nome})`,
      payment_method_id: 'pix',
      payer: { email: company.emailContato },
      external_reference: company.id,
      date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30min pra pagar
    }),
  });

  const corpo: any = await resposta.json();

  if (!resposta.ok) {
    throw new Error(`Mercado Pago recusou a criação do PIX (HTTP ${resposta.status}): ${JSON.stringify(corpo)}`);
  }

  const dadosPix = corpo.point_of_interaction?.transaction_data;
  if (!dadosPix?.qr_code || !dadosPix?.qr_code_base64) {
    throw new Error(`Resposta do Mercado Pago sem dados de QR Code PIX: ${JSON.stringify(corpo)}`);
  }

  return {
    paymentId: String(corpo.id),
    status: corpo.status,
    qrCode: dadosPix.qr_code,
    qrCodeBase64: dadosPix.qr_code_base64,
    valorCentavos,
    expiraEm: corpo.date_of_expiration,
  };
}

export interface StatusPagamento {
  paymentId: string;
  status: string; // 'approved' | 'pending' | 'rejected' | 'cancelled' | ...
  companyId: string | null; // vem do external_reference
}

/**
 * Consulta o status REAL de um pagamento direto na API do Mercado Pago,
 * usando nosso próprio access token — é essa consulta, e não o conteúdo da
 * notificação recebida em POST /webhooks/mercadopago, que decide se a
 * empresa é ativada. Isso é o que torna o webhook seguro sem precisar
 * validar a assinatura x-signature: um invasor pode até adivinhar/forjar um
 * paymentId na notificação, mas não consegue fazer essa consulta aqui
 * retornar "approved" pra um pagamento que não foi aprovado de verdade,
 * porque só o Mercado Pago decide essa resposta.
 */
export async function consultarPagamento(paymentId: string): Promise<StatusPagamento> {
  const token = getAccessToken();

  const resposta = await fetch(`${MP_API_BASE}/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const corpo: any = await resposta.json();

  if (!resposta.ok) {
    throw new Error(`Mercado Pago recusou a consulta do pagamento ${paymentId} (HTTP ${resposta.status}): ${JSON.stringify(corpo)}`);
  }

  return {
    paymentId: String(corpo.id),
    status: corpo.status,
    companyId: corpo.external_reference ?? null,
  };
}
