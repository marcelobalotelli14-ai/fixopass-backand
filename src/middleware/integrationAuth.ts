import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import { prisma } from '../lib/prisma';

declare global {
  namespace Express {
    interface Request {
      integracao?: { id: string; companyId: string; nome: string; redirectUris: string[] };
    }
  }
}

/**
 * Extrai client_id/client_secret do header `Authorization: Basic <base64>`
 * (RFC 7617, o mesmo esquema usado por qualquer client OAuth2
 * client_credentials) — nunca aceitos via querystring/body, pra não
 * arriscar o client_secret acabar logado em algum lugar (URL de acesso,
 * histórico do navegador, etc.).
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
 * Middleware das rotas /integrations/* chamadas pelo BACKEND de um sistema
 * externo (ex.: o cardápio online) — nunca pelo navegador do cliente final.
 * Autentica por client_id (lookup indexado, O(1) — diferente do
 * companyAuth/identifyActor, que comparam a API Key contra todas as
 * empresas ativas; aqui já temos o client_id explícito no próprio header,
 * então não precisamos de uma varredura) + client_secret (bcrypt.compare
 * contra o hash da única integração encontrada).
 *
 * Também confere que a integração está ATIVA (não revogada) e que a
 * empresa dona dela continua ativa — mesma lógica de "encerrar a conta
 * derruba tudo" já aplicada em companyAuth/companyPanelAuth/identifyActor.
 */
export async function integrationAuth(req: Request, res: Response, next: NextFunction) {
  const credenciais = extrairBasicAuth(req);
  if (!credenciais) {
    return res.status(401).json({
      error: 'Autenticação da integração ausente. Envie Authorization: Basic <clientId:clientSecret em Base64>.',
    });
  }

  try {
    const integracao = await prisma.integracao.findUnique({ where: { clientId: credenciais.clientId } });
    if (!integracao || integracao.status !== 'ATIVA') {
      return res.status(401).json({ error: 'Credenciais de integração inválidas.' });
    }

    const senhaOk = await bcrypt.compare(credenciais.clientSecret, integracao.clientSecretHash);
    if (!senhaOk) {
      return res.status(401).json({ error: 'Credenciais de integração inválidas.' });
    }

    const company = await prisma.company.findUnique({ where: { id: integracao.companyId }, select: { ativa: true } });
    if (!company || !company.ativa) {
      return res.status(401).json({ error: 'Credenciais de integração inválidas.' });
    }

    req.integracao = {
      id: integracao.id,
      companyId: integracao.companyId,
      nome: integracao.nome,
      redirectUris: integracao.redirectUris,
    };
    next();
  } catch (err) {
    next(err);
  }
}
