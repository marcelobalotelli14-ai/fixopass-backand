import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';

declare global {
  namespace Express {
    interface Request {
      panelCompanyId?: string;
    }
  }
}

/**
 * MVP: identifica a empresa logada no PAINEL WEB via header X-COMPANY-ID
 * (obtido no login com email/senha). Isto é diferente da X-API-KEY, que é
 * usada pelo ERP da empresa para consumir /auth/request e /customer/*.
 * Em produção, substituir por JWT/cookie de sessão.
 *
 * Confirma que o ID realmente existe no banco antes de seguir — mesmo
 * motivo do userAuth: evita erros confusos mais adiante na rota.
 */
export async function companyPanelAuth(req: Request, res: Response, next: NextFunction) {
  const companyId = req.header('X-COMPANY-ID');

  if (!companyId) {
    return res.status(401).json({ error: 'Empresa não autenticada no painel.' });
  }

  try {
    const existe = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
    if (!existe) {
      return res.status(401).json({ error: 'Empresa não encontrada.' });
    }

    req.panelCompanyId = companyId;
    next();
  } catch (err) {
    next(err);
  }
}
