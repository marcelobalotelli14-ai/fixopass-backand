import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import { prisma } from '../lib/prisma';

export type Actor =
  | { type: 'user'; id: string }
  | { type: 'company'; id: string; nome: string };

declare global {
  namespace Express {
    interface Request {
      actor?: Actor;
    }
  }
}

/**
 * POST /auth/request pode ser chamado de dois jeitos:
 *
 * 1) Pelo APP DO USUÁRIO, quando ele mesmo escaneia o QR Code ou aproxima o
 *    NFC — nesse caso quem está autenticado é o usuário (X-USER-ID), e a
 *    empresa/unidade é identificada pelo conteúdo do QR/NFC lido.
 *
 * 2) Pelo ERP/painel da empresa (ex.: recepção de hospital digitando o CPF
 *    do paciente num terminal) — nesse caso quem está autenticado é a
 *    empresa (X-API-KEY), e o usuário é identificado por CPF/telefone.
 *
 * Este middleware detecta qual dos dois headers veio e popula req.actor
 * de acordo, deixando a rota decidir o que fazer com cada caso.
 */
export async function identifyActor(req: Request, res: Response, next: NextFunction) {
  const userId = req.header('X-USER-ID');
  const apiKey = req.header('X-API-KEY');

  try {
    if (userId) {
      // Confirma que o ID realmente existe — sem isso, um ID inventado só
      // ia quebrar mais na frente com um erro de foreign key confuso.
      const existe = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!existe) {
        return res.status(401).json({ error: 'Usuário não encontrado.' });
      }
      req.actor = { type: 'user', id: userId };
      return next();
    }

    if (apiKey) {
      const companies = await prisma.company.findMany({ select: { id: true, nome: true, apiKeyHash: true } });
      const encontrada = (
        await Promise.all(companies.map(async (c) => ({ match: await bcrypt.compare(apiKey, c.apiKeyHash), c })))
      ).find((e) => e.match)?.c;

      if (!encontrada) {
        return res.status(401).json({ error: 'API Key inválida.' });
      }

      req.actor = { type: 'company', id: encontrada.id, nome: encontrada.nome };
      return next();
    }

    return res.status(401).json({
      error: 'Autenticação ausente. Envie X-USER-ID (app do usuário) ou X-API-KEY (ERP da empresa).',
    });
  } catch (err) {
    next(err);
  }
}
