import { CampoDado } from '@prisma/client';
import { prisma } from './prisma';

/**
 * Busca os campos que a empresa configurou como necessários
 * (PUT /companies/me/campos-solicitados). Se a empresa ainda não configurou
 * nada, cai de volta para NOME + TELEFONE como padrão mínimo seguro.
 *
 * Extraído de routes/auth.ts para ser reaproveitado também por
 * routes/oauth.ts (canal WEB/API) — os dois precisam do mesmo
 * "teto" de campos que uma empresa pode pedir, seja o pedido vindo do app
 * lendo NFC/QR ou de uma integração de terceiro.
 */
export async function buscarCamposConfigurados(companyId: string): Promise<CampoDado[]> {
  const configurados = await prisma.campoSolicitadoEmpresa.findMany({ where: { companyId } });
  if (configurados.length === 0) return ['NOME', 'TELEFONE'];
  return configurados.map((c) => c.campo);
}
