import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

/**
 * MVP: identifica o usuário logado no app via header X-USER-ID.
 * Em produção, substituir por validação de JWT emitido no login do app.
 *
 * IMPORTANTE: mesmo sendo um esquema simplificado, sempre confirmamos que o
 * ID realmente existe no banco antes de deixar a rota seguir. Sem isso, um
 * ID malformado ou inexistente só ia estourar mais na frente (ex.: violação
 * de foreign key ao criar um registro), como um erro confuso e tardio.
 */
export async function userAuth(req: Request, res: Response, next: NextFunction) {
  const userId = req.header('X-USER-ID');

  if (!userId) {
    return res.status(401).json({ error: 'Usuário não autenticado.' });
  }

  try {
    const existe = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!existe) {
      return res.status(401).json({ error: 'Usuário não encontrado.' });
    }

    req.userId = userId;
    next();
  } catch (err) {
    next(err);
  }
}
