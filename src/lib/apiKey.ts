import crypto from 'crypto';

/**
 * Gera uma API Key legível (para o ERP configurar) no formato:
 * fixopass_live_xxxxxxxxxxxxxxxxxxxxxxxx
 * O valor em texto puro só existe neste momento — só o hash é persistido.
 */
export function gerarApiKey(): string {
  const token = crypto.randomBytes(24).toString('hex');
  return `fixopass_live_${token}`;
}
