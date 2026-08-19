import crypto from 'crypto';

/**
 * Gera um client_secret legível (para a empresa configurar no backend do
 * sistema externo) no formato: fixopass_secret_xxxxxxxxxxxxxxxxxxxxxxxx
 * O valor em texto puro só existe neste momento e na resposta HTTP de
 * criação/regeneração — só o hash (bcrypt, ver routes/companies.ts) é
 * persistido. Mesmo padrão de lib/apiKey.ts (gerarApiKey), propositalmente
 * com prefixo diferente para dar pra distinguir os dois tipos de credencial
 * à primeira vista (ex.: num log ou num .env de exemplo).
 */
export function gerarClientSecret(): string {
  const segredo = crypto.randomBytes(24).toString('hex');
  return `fixopass_secret_${segredo}`;
}
