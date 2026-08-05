import { Company } from '@prisma/client';
import { prisma } from './prisma';

export const TRIAL_DIAS = 15;
export const MENSALIDADE_DIAS = 30;
export const PRECO_PADRAO_CENTAVOS = 2990; // R$ 29,90 — mesmo valor já anunciado na landing page

const UM_DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Confere se a assinatura da empresa está em dia pra validar um pareamento
 * NFC/QR Code (chamado em POST /auth/request). Se o trial ou a mensalidade
 * já venceram, transiciona pra EXPIRED na hora (side effect: grava no
 * banco) — é assim que "verifique o status e, se TRIAL vencido, atualize
 * pra EXPIRED" funciona sem precisar de um job/cron rodando por fora.
 *
 * Retorna a empresa (possivelmente já atualizada) e se o pareamento deve
 * ser recusado.
 */
export async function verificarAssinatura(company: Company): Promise<{ empresa: Company; bloqueado: boolean }> {
  let empresa = company;
  const agora = Date.now();

  if (empresa.status === 'TRIAL' && empresa.trialEndsAt && empresa.trialEndsAt.getTime() < agora) {
    empresa = await prisma.company.update({ where: { id: empresa.id }, data: { status: 'EXPIRED' } });
  } else if (empresa.status === 'ACTIVE' && empresa.nextDueDate && empresa.nextDueDate.getTime() < agora) {
    empresa = await prisma.company.update({ where: { id: empresa.id }, data: { status: 'EXPIRED' } });
  }

  const bloqueado = empresa.status === 'EXPIRED' || empresa.status === 'BLOCKED';
  return { empresa, bloqueado };
}

/** Mensagem padrão devolvida quando POST /auth/request recusa por assinatura vencida. */
export const MENSAGEM_ASSINATURA_VENCIDA = 'Período de teste/mensalidade expirado. Efetue a renovação para continuar.';

/** Dias restantes de trial — 0 se não estiver em TRIAL ou já tiver vencido. */
export function calcularDaysLeftInTrial(company: Pick<Company, 'status' | 'trialEndsAt'>): number {
  if (company.status !== 'TRIAL' || !company.trialEndsAt) return 0;
  const ms = company.trialEndsAt.getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / UM_DIA_MS));
}

export function diasEmMs(dias: number): number {
  return dias * UM_DIA_MS;
}
