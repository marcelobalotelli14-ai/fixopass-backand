-- AlterEnum
ALTER TYPE "MetodoIdentificacao" ADD VALUE 'WEB_API';

-- CreateEnum
CREATE TYPE "StatusIntegracao" AS ENUM ('ATIVA', 'REVOGADA');

-- CreateTable
CREATE TABLE "integracoes" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretHash" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "status" "StatusIntegracao" NOT NULL DEFAULT 'ATIVA',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revogadaEm" TIMESTAMP(3),

    CONSTRAINT "integracoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "autorizacao_codigos" (
    "id" TEXT NOT NULL,
    "codigoHash" TEXT NOT NULL,
    "solicitacaoId" TEXT NOT NULL,
    "integracaoId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "camposLiberados" "CampoDado"[],
    "redirectUri" TEXT NOT NULL,
    "expiraEm" TIMESTAMP(3) NOT NULL,
    "usadoEm" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "autorizacao_codigos_pkey" PRIMARY KEY ("id")
);

-- AlterTable
-- userId vira opcional: no canal WEB_API a solicitação nasce antes de
-- sabermos o usuário (ver comentário no schema.prisma). NFC/QR/ERP
-- continuam sempre preenchendo userId na criação, sem nenhuma mudança de
-- comportamento pra eles.
ALTER TABLE "solicitacoes_compartilhamento"
    ALTER COLUMN "userId" DROP NOT NULL,
    ADD COLUMN     "integracaoId" TEXT,
    ADD COLUMN     "redirectUri" TEXT,
    ADD COLUMN     "purpose" TEXT,
    ADD COLUMN     "expiraEm" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "integracoes_clientId_key" ON "integracoes"("clientId");

-- CreateIndex
CREATE INDEX "integracoes_companyId_idx" ON "integracoes"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "autorizacao_codigos_codigoHash_key" ON "autorizacao_codigos"("codigoHash");

-- CreateIndex
CREATE UNIQUE INDEX "autorizacao_codigos_solicitacaoId_key" ON "autorizacao_codigos"("solicitacaoId");

-- CreateIndex
CREATE INDEX "autorizacao_codigos_integracaoId_idx" ON "autorizacao_codigos"("integracaoId");

-- AddForeignKey
ALTER TABLE "integracoes" ADD CONSTRAINT "integracoes_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solicitacoes_compartilhamento" ADD CONSTRAINT "solicitacoes_compartilhamento_integracaoId_fkey" FOREIGN KEY ("integracaoId") REFERENCES "integracoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autorizacao_codigos" ADD CONSTRAINT "autorizacao_codigos_solicitacaoId_fkey" FOREIGN KEY ("solicitacaoId") REFERENCES "solicitacoes_compartilhamento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autorizacao_codigos" ADD CONSTRAINT "autorizacao_codigos_integracaoId_fkey" FOREIGN KEY ("integracaoId") REFERENCES "integracoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
