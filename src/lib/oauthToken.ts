import crypto from 'crypto';

/**
 * Quanto tempo um access_token (canal WEB/API, emitido em POST /oauth/token)
 * vale. Curto de propósito — isso não é uma sessão longa, é uma janela pra
 * o backend do sistema externo chamar GET /oauth/userinfo dentro do mesmo
 * checkout que acabou de pedir o compartilhamento. Diferente do
 * authorization_code (uso único), o token PODE ser usado mais de uma vez
 * dentro dessa janela — é essa reusabilidade que faz o canal Web/API se
 * comportar como um SSO de verdade, em vez de "trocar o code por dados uma
 * única vez".
 */
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutos

/**
 * Gera um access_token opaco de alta entropia e devolve também o hash
 * (sha256) que vai pro banco — mesmo padrão de gerarAuthorizationCode em
 * oauthCode.ts. O valor em texto puro só existe na resposta de
 * POST /oauth/token; só o hash é persistido em OAuthToken.tokenHash.
 */
export function gerarAccessToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashAccessToken(token);
  return { token, tokenHash };
}

export function hashAccessToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}
