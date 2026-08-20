import nodemailer, { Transporter } from 'nodemailer';

/**
 * Envio REAL de e-mail (não é mock/placeholder) — suporta dois provedores,
 * escolhidos por qual env var estiver configurada:
 *
 *  1) Resend (RESEND_API_KEY) — API HTTP simples, preferida quando presente.
 *  2) SMTP genérico via Nodemailer (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS)
 *     — funciona com qualquer provedor (Gmail, SES, Mailgun, etc.).
 *
 * Se nenhum dos dois estiver configurado, lança EmailNaoConfiguradoError em
 * vez de fingir que enviou (mesmo padrão "fail closed" já usado no resto do
 * backend para Asaas/Admin/Webhook) — as rotas que chamam isso devem tratar
 * esse erro com um 503, nunca deixar passar em silêncio.
 */
export class EmailNaoConfiguradoError extends Error {
  constructor() {
    super('Envio de e-mail não está configurado no servidor (configure RESEND_API_KEY, ou SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS).');
    this.name = 'EmailNaoConfiguradoError';
  }
}

export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const REMETENTE_PADRAO = process.env.EMAIL_FROM || 'FIXO PASS <nao-responda@fixopass.com>';

/** Usado pela rota antes de tentar qualquer coisa, pra recusar fail-closed (503) sem nem tocar no banco. */
export function emailConfigurado(): boolean {
  return Boolean(process.env.RESEND_API_KEY) || Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

async function enviarViaResend(payload: EmailPayload): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY!;

  const resposta = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: REMETENTE_PADRAO,
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
    }),
  });

  if (!resposta.ok) {
    const corpo = await resposta.text().catch(() => '');
    throw new Error(`Resend recusou o envio do e-mail (HTTP ${resposta.status}): ${corpo}`);
  }
}

// Reaproveita a mesma conexão SMTP entre chamadas (Nodemailer recomenda não
// recriar o transporter a cada envio) — criado só na primeira vez que for
// preciso, e só quando SMTP for de fato o provedor escolhido.
let smtpTransporter: Transporter | null = null;

function getSmtpTransporter(): Transporter {
  if (smtpTransporter) return smtpTransporter;

  const port = Number(process.env.SMTP_PORT || 587);
  smtpTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // 465 é SMTPS (TLS implícito); qualquer outra porta (587, 25) usa
    // STARTTLS, negociado automaticamente pelo Nodemailer com secure:false.
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return smtpTransporter;
}

async function enviarViaSmtp(payload: EmailPayload): Promise<void> {
  const transporter = getSmtpTransporter();
  await transporter.sendMail({
    from: REMETENTE_PADRAO,
    to: payload.to,
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
  });
}

/**
 * Envia um e-mail de verdade pelo provedor configurado. RESEND_API_KEY tem
 * prioridade sobre SMTP_* quando os dois estiverem presentes (Resend é mais
 * simples de operar — sem gerenciar conexão SMTP).
 */
export async function enviarEmail(payload: EmailPayload): Promise<void> {
  if (process.env.RESEND_API_KEY) {
    return enviarViaResend(payload);
  }
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    return enviarViaSmtp(payload);
  }
  throw new EmailNaoConfiguradoError();
}

/**
 * POST /companies/forgot-password chama isso para mandar o link de
 * redefinição de senha. Não decide o que fazer se o envio falhar — quem
 * chama decide (ver comentário na rota sobre nunca deixar isso vazar se o
 * e-mail existe ou não).
 */
export async function enviarEmailRecuperacaoSenha(destinatario: string, linkReset: string): Promise<void> {
  await enviarEmail({
    to: destinatario,
    subject: 'Redefinição de senha — FIXO PASS',
    html: `
      <p>Recebemos um pedido para redefinir a senha da sua conta FIXO PASS.</p>
      <p><a href="${linkReset}">Clique aqui para redefinir sua senha</a></p>
      <p>Este link expira em 1 hora. Se você não pediu essa redefinição, pode ignorar este e-mail — sua senha continua a mesma.</p>
    `.trim(),
    text: `Recebemos um pedido para redefinir a senha da sua conta FIXO PASS.\n\nAcesse o link para redefinir: ${linkReset}\n\nEste link expira em 1 hora. Se você não pediu essa redefinição, pode ignorar este e-mail — sua senha continua a mesma.`,
  });
}
