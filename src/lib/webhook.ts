/**
 * Dispara o webhook configurado pela empresa quando uma solicitação é
 * aprovada, entregando os dados autorizados automaticamente pro ERP.
 *
 * Importante: nunca deixamos uma falha de rede do ERP da empresa quebrar
 * a resposta que o app do usuário está esperando — por isso isso roda
 * "fire and forget", com timeout curto, e qualquer erro só é logado.
 */
export async function dispararWebhook(
  webhookUrl: string,
  payload: {
    solicitacaoId: string;
    userId: string;
    companyId: string;
    dados: Record<string, unknown>;
  }
) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const resposta = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ evento: 'compartilhamento.aprovado', ...payload }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!resposta.ok) {
      console.error(`Webhook respondeu ${resposta.status} para ${webhookUrl}`);
    }
  } catch (err) {
    // Não relança o erro — o compartilhamento já foi concluído do lado do
    // FIXO PASS. A empresa pode consultar GET /auth/request/:id como
    // alternativa caso o webhook falhe.
    console.error(`Falha ao chamar webhook (${webhookUrl}):`, err);
  }
}
