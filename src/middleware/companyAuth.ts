import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import { prisma } from '../lib/prisma';

// Estende o tipo Request para carregar a empresa autenticada
declare global {
  namespace Express {
    interface Request {
      company?: { id: string; nome: string };
    }
  }
}

/**
 * Middleware que valida a API Key da empresa (enviada via header X-API-KEY).
 * Usado por todos os endpoints que o ERP da empresa consome.
 *
 * Observação: como não temos como indexar por hash diretamente, em produção
 * recomenda-se guardar um "keyId" público + segredo, e comparar o segredo
 * com bcrypt. Aqui simplificamos comparando contra todas as empresas ativas
 * apenas para fins de MVP/demonstração — trocar por lookup por keyId em produção.
 */
export async function companyAuth(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.header('X-API-KEY');

  if (!apiKey) {
    return res.status(401).json({ error: 'API Key ausente. Envie o header X-API-KEY.' });
  }

  try {
    const companies = await prisma.company.findMany({
      select: { id: true, nome: true, apiKeyHash: true },
    });

    const empresa = await Promise.all(
      companies.map(async (c) => ({
        match: await bcrypt.compare(apiKey, c.apiKeyHash),
        c,
      }))
    );

    const encontrada = empresa.find((e) => e.match)?.c;

    if (!encontrada) {
      return res.status(401).json({ error: 'API Key inválida.' });
    }

    req.company = { id: encontrada.id, nome: encontrada.nome };
    next();
  } catch (err) {
    console.error('Erro ao validar API Key:', err);
    return res.status(500).json({ error: 'Erro interno ao validar autenticação.' });
  }
}
