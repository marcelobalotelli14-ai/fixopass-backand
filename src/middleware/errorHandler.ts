import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';

/**
 * Middleware de erro global — precisa ser o ÚLTIMO app.use() em index.ts.
 * Sem isso, qualquer erro que escape de um asyncHandler (ou de middlewares
 * síncronos) derruba a conexão sem resposta, ou vaza stack trace pro cliente.
 */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) {
    return next(err);
  }

  // Erros conhecidos do Prisma viram respostas claras em vez de 500 cru.
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const alvo = (err.meta?.target as string[] | undefined)?.join(', ') || 'campo único';
      return res.status(409).json({ error: `Já existe um registro com esse ${alvo}.` });
    }
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Registro não encontrado.' });
    }
  }

  // Formato de UUID inválido enviado em algum :id de rota — Postgres recusa
  // o cast e o Prisma propaga como erro de validação.
  if (err instanceof Prisma.PrismaClientValidationError) {
    return res.status(400).json({ error: 'Identificador inválido enviado na requisição.' });
  }

  console.error('Erro não tratado:', err);
  return res.status(500).json({ error: 'Erro interno no servidor.' });
}
