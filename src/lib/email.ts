/**
 * MVP: nenhum provedor de e-mail está configurado ainda — "enviar" aqui
 * apenas loga o link no console do servidor, seguindo o mesmo espírito
 * fire-and-forget de webhook.ts. Substituir por um provedor real
 * (Resend, SES, SMTP) antes de ir para produção.
 */
export async function enviarEmailRecuperacaoSenha(destinatario: string, linkReset: string) {
  console.log(`[email:forgot-password] destinatario=${destinatario} link=${linkReset}`);
}
