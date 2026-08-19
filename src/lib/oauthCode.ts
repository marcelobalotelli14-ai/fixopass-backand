import crypto from 'crypto';

/** Quanto tempo um authorization_code (canal WEB/API) vale depois de emitido. */
export const AUTHORIZATION_CODE_TTL_MS = 2 * 60 * 1000; // 2 minutos

/** Quanto tempo uma solicitação WEB/API vale até o usuário aprovar/negar. */
export const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000; // 10 minutos

/**
 * Gera um authorization_code opaco de alta entropia (32 bytes aleatórios,
 * codificados em base64url — sem caracteres problemáticos em URL/query
 * string) e devolve também o hash (sha256) que efetivamente vai pro banco.
 *
 * O valor em texto puro só existe neste retorno e na resposta HTTP de
 * POST /oauth/authorize/:requestId — nunca é persistido, só o hash (mesmo
 * motivo do resetPasswordTokenHash em companies.ts: um vazamento do banco
 * não deve permitir reconstruir authorization_codes válidos).
 */
export function gerarAuthorizationCode(): { codigo: string; codigoHash: string } {
  const codigo = crypto.randomBytes(32).toString('base64url');
  const codigoHash = hashAuthorizationCode(codigo);
  return { codigo, codigoHash };
}

export function hashAuthorizationCode(codigo: string): string {
  return crypto.createHash('sha256').update(codigo, 'utf8').digest('hex');
}
