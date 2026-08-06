import { Request, Response, NextFunction } from 'express';

/**
 * MVP: Super Admin autenticado por segredo compartilhado (ADMIN_SECRET),
 * enviado no header X-ADMIN-SECRET — mesmo padrão simplificado já usado no
 * resto do backend (sem JWT). Diferença importante: X-USER-ID/X-COMPANY-ID
 * identificam UM registro específico; este segredo dá acesso de LEITURA E
 * ESCRITA a TODAS as empresas do sistema (preço, status de assinatura,
 * encerramento). Guardar com o mesmo cuidado de uma credencial de produção
 * — nunca commitar o valor real, só configurar via variável de ambiente.
 *
 * Sem ADMIN_SECRET configurado no ambiente, as rotas admin recusam por
 * padrão (fail closed) — nunca ficam abertas "por engano" só porque
 * ninguém configurou a env var ainda.
 */
export function isAdmin(req: Request, res: Response, next: NextFunction) {
  const segredoEsperado = process.env.ADMIN_SECRET;
  if (!segredoEsperado) {
    return res.status(503).json({ error: 'Painel admin não configurado (ADMIN_SECRET ausente no servidor).' });
  }

  // Node normaliza nomes de header pra minúsculo em req.headers — o cliente
  // pode mandar "X-ADMIN-SECRET" ou "x-admin-secret", chega igual aqui.
  const recebido = req.headers['x-admin-secret'];
  if (typeof recebido !== 'string' || recebido !== segredoEsperado) {
    return res.status(401).json({ error: 'Acesso negado.' });
  }

  next();
}
