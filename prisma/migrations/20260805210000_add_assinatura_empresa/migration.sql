-- CreateEnum
CREATE TYPE "StatusAssinatura" AS ENUM ('TRIAL', 'ACTIVE', 'EXPIRED', 'BLOCKED');

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "status" "StatusAssinatura" NOT NULL DEFAULT 'TRIAL',
ADD COLUMN     "trialEndsAt" TIMESTAMP(3),
ADD COLUMN     "nextDueDate" TIMESTAMP(3),
ADD COLUMN     "precoMensalCentavos" INTEGER;

-- Empresas que já existiam antes desta migration não têm trialEndsAt (a
-- coluna acabou de ser criada). Decisão explícita: NÃO aplicar o trial
-- retroativo a partir da data de criação original (isso bloquearia sem
-- aviso qualquer empresa com mais de 15 dias de conta assim que este
-- deploy for ao ar). Em vez disso, o relógio de 15 dias começa a contar
-- agora, a partir do momento desta migration — ninguém é bloqueado de
-- surpresa; todo mundo (inclusive quem já usa há meses) passa a ter um
-- prazo dali pra frente. Empresas cadastradas a partir de agora recebem
-- trialEndsAt = createdAt + 15 dias diretamente no código (POST /companies).
UPDATE "companies" SET "trialEndsAt" = NOW() + INTERVAL '15 days' WHERE "trialEndsAt" IS NULL;
