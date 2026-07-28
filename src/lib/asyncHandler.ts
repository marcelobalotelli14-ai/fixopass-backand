import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Express 4 NÃO captura automaticamente erros lançados dentro de handlers
 * async — uma exceção (ex.: Prisma recusando um UUID malformado, ou uma
 * violação de constraint única) fica como uma promise rejeitada sem
 * tratamento, e a requisição trava sem nunca responder ao cliente.
 *
 * Este wrapper garante que qualquer erro caia em next(err), onde o
 * middleware de erro global (ver index.ts) transforma isso numa resposta
 * HTTP de verdade em vez de travar a conexão.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
