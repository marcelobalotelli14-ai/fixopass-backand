import { Company } from '@prisma/client';
import { PRECO_PADRAO_CENTAVOS } from './assinatura';

// https://api.asaas.com/v3 (produção) — sandbox é
// https://sandbox.asaas.com/api/v3; ajustável via ASAAS_API_URL pra apontar
// pro sandbox durante testes, sem precisar mexer em código.
const ASAAS_API_BASE = process.env.ASAAS_API_URL || 'https://api.asaas.com/v3';

/**
 * Integração REAL com a API v3 do Asaas (não é mock/placeholder) — gera uma
 * cobrança PIX de verdade e consulta o status real de um pagamento. Gated
 * por ASAAS_API_KEY (env var): sem essa credencial configurada, as funções
 * abaixo lançam AsaasNaoConfiguradoError em vez de inventar um QR Code
 * falso — as rotas que usam isso (POST /companies/me/pix, POST
 * /webhooks/asaas) traduzem isso pra um 503 "fail closed", igual ao resto
 * do backend.
 *
 * Como conseguir a API Key: painel do Asaas > Integrações > API > "Gerar
 * nova chave de API" (produção). https://www.asaas.com/
 */
export class AsaasNaoConfiguradoError extends Error {
  constructor() {
    super('Pagamento automático via PIX ainda não está configurado (ASAAS_API_KEY ausente no servidor).');
    this.name = 'AsaasNaoConfiguradoError';
  }
}

function getApiKey(): string {
  const key = process.env.ASAAS_API_KEY;
  if (!key) throw new AsaasNaoConfiguradoError();
  return key;
}

/**
 * Pagamento consultado não existe na conta Asaas (HTTP 404) — diferente de
 * uma falha de rede/instabilidade da API, que é passageira e vale a pena o
 * Asaas reenviar depois. Um paymentId inexistente NUNCA vai passar a
 * existir só porque o Asaas reenviou a mesma notificação de novo (é o caso,
 * por exemplo, do teste de conectividade que o próprio painel do Asaas
 * dispara ao ativar/salvar um webhook, com um paymentId fictício) — então a
 * rota trata isso como "nada a fazer" (200) em vez de erro (500), pra não
 * fazer o Asaas achar que o endpoint está quebrado e suspender o webhook
 * (status "Interrompido") por causa de um teste que nunca teria como dar
 * certo.
 */
export class PagamentoAsaasNaoEncontradoError extends Error {
  constructor(paymentId: string) {
    super(`Pagamento ${paymentId} não encontrado na conta Asaas.`);
    this.name = 'PagamentoAsaasNaoEncontradoError';
  }
}

function headersAsaas(apiKey: string): Record<string, string> {
  // O Asaas autentica pelo header `access_token` (não é Bearer) — vale tanto
  // pra chave de produção quanto de sandbox.
  return { 'Content-Type': 'application/json', access_token: apiKey };
}

/**
 * Monta uma mensagem de erro segura pra logar/propagar quando o Asaas
 * recusa uma chamada — NUNCA inclui o corpo bruto da resposta (`corpo`),
 * porque em erros de validação o Asaas costuma ecoar de volta os campos
 * submetidos (nome, cpfCnpj, email do cliente). Usa só o HTTP status e,
 * se existir, o código de erro estruturado do Asaas
 * (`corpo.errors[].code`/`.description`, sem os dados do cliente).
 */
function mensagemErroAsaas(prefixo: string, status: number, corpo: any): string {
  const primeiroErro = Array.isArray(corpo?.errors) ? corpo.errors[0] : undefined;
  const codigo = primeiroErro?.code;
  return codigo ? `${prefixo} (HTTP ${status}, código: ${codigo})` : `${prefixo} (HTTP ${status})`;
}

/**
 * O Asaas exige um "customer" cadastrado antes de criar a cobrança. Busca
 * por CNPJ (evita duplicar o cliente a cada renovação) e cria na hora se
 * ainda não existir.
 */
async function buscarOuCriarCliente(
  company: Pick<Company, 'id' | 'nome' | 'emailContato' | 'cnpj'>,
  apiKey: string
): Promise<string> {
  const cpfCnpj = company.cnpj.replace(/\D/g, '');

  const busca = await fetch(`${ASAAS_API_BASE}/customers?cpfCnpj=${cpfCnpj}`, {
    headers: headersAsaas(apiKey),
  });
  const corpoBusca: any = await busca.json();
  if (!busca.ok) {
    throw new Error(mensagemErroAsaas('Asaas recusou a busca do cliente', busca.status, corpoBusca));
  }

  const existente = corpoBusca.data?.[0];
  if (existente?.id) return existente.id;

  const criacao = await fetch(`${ASAAS_API_BASE}/customers`, {
    method: 'POST',
    headers: headersAsaas(apiKey),
    body: JSON.stringify({
      name: company.nome,
      cpfCnpj,
      email: company.emailContato,
      externalReference: company.id,
    }),
  });
  const corpoCriacao: any = await criacao.json();
  if (!criacao.ok || !corpoCriacao.id) {
    throw new Error(mensagemErroAsaas('Asaas recusou a criação do cliente', criacao.status, corpoCriacao));
  }
  return corpoCriacao.id;
}

export interface CobrancaPix {
  paymentId: string;
  status: string;
  qrCode: string; // "copia e cola"
  qrCodeBase64: string; // imagem do QR Code, já em base64 (PNG)
  valorCentavos: number;
  expiraEm: string; // ISO — quando o QR Code PIX expira
}

/**
 * Cria uma cobrança PIX real pra renovação da mensalidade de `company`,
 * usando o preço customizado dela (se houver) ou o padrão. `externalReference`
 * carrega o companyId — é assim que o webhook (POST /webhooks/asaas) sabe
 * qual empresa ativar quando o Asaas avisar que foi pago.
 */
export async function criarCobrancaPix(
  company: Pick<Company, 'id' | 'nome' | 'emailContato' | 'cnpj' | 'precoMensalCentavos'>
): Promise<CobrancaPix> {
  const apiKey = getApiKey();
  const valorCentavos = company.precoMensalCentavos ?? PRECO_PADRAO_CENTAVOS;
  const customerId = await buscarOuCriarCliente(company, apiKey);

  // O Asaas exige `dueDate` (data, sem hora) igual ou posterior a hoje —
  // usamos amanhã pra nunca cair em "hoje" já vencido por causa de fuso
  // horário entre o servidor e o Asaas.
  const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const resposta = await fetch(`${ASAAS_API_BASE}/payments`, {
    method: 'POST',
    headers: headersAsaas(apiKey),
    body: JSON.stringify({
      customer: customerId,
      billingType: 'PIX',
      value: valorCentavos / 100,
      dueDate,
      description: `FIXO PASS - Mensalidade (${company.nome})`,
      externalReference: company.id,
    }),
  });
  const corpo: any = await resposta.json();
  if (!resposta.ok || !corpo.id) {
    throw new Error(mensagemErroAsaas('Asaas recusou a criação da cobrança PIX', resposta.status, corpo));
  }

  const qr = await fetch(`${ASAAS_API_BASE}/payments/${corpo.id}/pixQrCode`, {
    headers: headersAsaas(apiKey),
  });
  const dadosQr: any = await qr.json();
  if (!qr.ok || !dadosQr.encodedImage || !dadosQr.payload) {
    throw new Error(mensagemErroAsaas(`Asaas não retornou QR Code PIX para a cobrança ${corpo.id}`, qr.status, dadosQr));
  }

  return {
    paymentId: String(corpo.id),
    status: corpo.status,
    qrCode: dadosQr.payload,
    qrCodeBase64: dadosQr.encodedImage,
    valorCentavos,
    expiraEm: dadosQr.expirationDate ?? corpo.dueDate,
  };
}

export interface StatusPagamento {
  paymentId: string;
  status: string; // 'PENDING' | 'RECEIVED' | 'CONFIRMED' | 'OVERDUE' | ...
  companyId: string | null; // vem do externalReference
}

// PIX confirmado cai direto em RECEIVED; CONFIRMED é o equivalente usado
// para outros meios (cartão) — aceitamos os dois como "pago" por segurança,
// já que o Asaas pode mandar qualquer um dependendo do fluxo.
const STATUS_PAGO = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];

export function pagamentoAsaasFoiConfirmado(status: string): boolean {
  return STATUS_PAGO.includes(status);
}

/**
 * Consulta o status REAL de um pagamento direto na API do Asaas, usando
 * nossa própria ASAAS_API_KEY — é essa consulta, e não o conteúdo da
 * notificação recebida em POST /webhooks/asaas, que decide se a empresa é
 * ativada. Isso é o que torna o webhook seguro mesmo com o token
 * compartilhado simples (ver comentário na rota): um invasor pode até
 * adivinhar/forjar um paymentId na notificação, mas não consegue fazer essa
 * consulta aqui retornar "RECEIVED" pra um pagamento que não foi aprovado
 * de verdade, porque só o Asaas decide essa resposta.
 */
export async function consultarPagamento(paymentId: string): Promise<StatusPagamento> {
  const apiKey = getApiKey();

  const resposta = await fetch(`${ASAAS_API_BASE}/payments/${encodeURIComponent(paymentId)}`, {
    headers: headersAsaas(apiKey),
  });
  const corpo: any = await resposta.json();

  if (resposta.status === 404) {
    throw new PagamentoAsaasNaoEncontradoError(paymentId);
  }
  if (!resposta.ok) {
    throw new Error(mensagemErroAsaas(`Asaas recusou a consulta do pagamento ${paymentId}`, resposta.status, corpo));
  }

  return {
    paymentId: String(corpo.id),
    status: corpo.status,
    companyId: corpo.externalReference ?? null,
  };
}
