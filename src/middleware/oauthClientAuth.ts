import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import { prisma } from '../lib/prisma';

declare global {
  namespace Express {
    interface Request {
      oauthClient?: { id: string; companyId: string; name: string; redirectUris: string[] };
    }
  }
}

/**
 * Extrai client_id/client_secret do header `Authorization: Basic <base64>`
 * (RFC 7617 — client_credentials, o mesmo esquema descrito na RFC 6749
 * §2.3.1 para autenticação de client OAuth2) — nunca aceitos via
 * querystring/body, pra não arriscar o client_secret acabar logado em
 * algum lugar (URL de acesso, histórico do navegador, etc.).
 */
function extrairBasicAuth(req: Request): { clientId: string; clientSecret: string } | null {
  const header = req.header('Authorization');
  if (!header || !header.startsWith('Basic ')) return null;

  let decodificado: string;
  try {
    decodificado = Buffer.from(header.slice('Basic '.length).trim(), 'base64').toString('utf8');
  } catch {
    return null;
  }

  const indice = decodificado.indexOf(':');
  if (indice === -1) return null;

  return { clientId: decodificado.slice(0, indice), clientSecret: decodificado.slice(indice + 1) };
}

/**
 * Middleware das rotas /oauth/* chamadas pelo BACKEND de um sistema externo
 * (ex.: o cardápio online) — nunca pelo navegador do cliente final. Neste
 * projeto o client_id nunca é exposto ao navegador (diferente do OAuth2
 * "puro", que trata client_id como público) — POST /oauth/authorize já
 * exige Basic Auth pra criar a solicitação, então o client_id nunca precisa
 * viajar numa URL que o navegador veria.
 *
 * Autentica por client_id (lookup indexado, O(1) — diferente do
 * companyAuth/identifyActor, que comparam a API Key contra todas as
 * empresas ativas; aqui já temos o client_id explícito no próprio header,
 * então não precisamos de uma varredura) + client_secret (bcrypt.compare
 * contra o hash da única credencial encontrada).
 *
 * Também confere que o client está ACTIVE (não revogado) e que a empresa
 * dona dele continua ativa — mesma lógica de "encerrar a conta derruba
 * tudo" já aplicada em companyAuth/companyPanelAuth/identifyActor.
 */
export async function oauthClientAuth(req: Request, res: Response, next: NextFunction) {
  const credenciais = extrairBasicAuth(req);
  if (!credenciais) {
    return res.status(401).json({
      error: 'invalid_client',
      error_description: 'Autenticação ausente. Envie Authorization: Basic <clientId:clientSecret em Base64>.',
    });
  }

  try {
    const oauthClient = await prisma.oAuthClient.findUnique({ where: { clientId: credenciais.clientId } });
    if (!oauthClient || oauthClient.status !== 'ACTIVE') {
      return res.status(401).json({ error: 'invalid_client', error_description: 'Credenciais inválidas.' });
    }

    const senhaOk = await bcrypt.compare(credenciais.clientSecret, oauthClient.clientSecretHash);
    if (!senhaOk) {
      return res.status(401).json({ error: 'invalid_client', error_description: 'Credenciais inválidas.' });
    }

    const company = await prisma.company.findUnique({ where: { id: oauthClient.companyId }, select: { ativa: true } });
    if (!company || !company.ativa) {
      return res.status(401).json({ error: 'invalid_client', error_description: 'Credenciais inválidas.' });
    }

    req.oauthClient = {
      id: oauthClient.id,
      companyId: oauthClient.companyId,
      name: oauthClient.name,
      redirectUris: oauthClient.redirectUris,
    };
    next();
  } catch (err) {
    next(err);
  }
}
