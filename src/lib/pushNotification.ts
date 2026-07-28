/**
 * Dispara uma push notification via Expo Push API (https://exp.host/--/api/v2/push/send).
 * Não precisa de nenhuma credencial — a Expo Push API aceita o token do
 * dispositivo diretamente. Assim como o webhook do ERP, roda "fire and
 * forget": uma falha aqui nunca deve quebrar o fluxo principal (criar a
 * solicitação já aconteceu, a notificação é só um aviso a mais).
 */
export async function dispararPush(
  expoPushToken: string,
  titulo: string,
  corpo: string,
  data: Record<string, unknown> = {}
) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const resposta = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: expoPushToken,
        title: titulo,
        body: corpo,
        data,
        priority: 'high',
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!resposta.ok) {
      console.error(`Expo Push API respondeu ${resposta.status}`);
    }
  } catch (err) {
    console.error('Falha ao disparar push notification:', err);
  }
}
