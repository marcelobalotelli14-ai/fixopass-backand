-- AlterEnum
ALTER TYPE "MetodoIdentificacao" ADD VALUE 'WEB_API';

-- CreateEnum
CREATE TYPE "OAuthClientStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateTable
CREATE TABLE "oauth_clients" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretHash" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "status" "OAuthClientStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_codes" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "oauthClientId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scopes" "CampoDado"[],
    "redirectUri" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_tokens" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "oauthClientId" TEXT NOT NULL,
    "oauthCodeId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scopes" "CampoDado"[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_tokens_pkey" PRIMARY KEY ("id")
);

-- AlterTable
-- userId vira opcional: no fluxo OAuth2/Web-API a solicitacao (o "request")
-- pode nascer antes de sabermos o usuario. NFC/QR/ERP continuam sempre
-- preenchendo na criacao, sem nenhuma mudanca de comportamento pra eles.
ALTER TABLE "solicitacoes_compartilhamento"
    ALTER COLUMN "userId" DROP NOT NULL,
    ADD COLUMN     "integracaoId" TEXT,
    ADD COLUMN     "redirectUri" TEXT,
    ADD COLUMN     "purpose" TEXT,
    ADD COLUMN     "state" TEXT,
    ADD COLUMN     "expiraEm" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_clients_clientId_key" ON "oauth_clients"("clientId");

-- CreateIndex
CREATE INDEX "oauth_clients_companyId_idx" ON "oauth_clients"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_codes_codeHash_key" ON "oauth_codes"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_codes_requestId_key" ON "oauth_codes"("requestId");

-- CreateIndex
CREATE INDEX "oauth_codes_oauthClientId_idx" ON "oauth_codes"("oauthClientId");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_tokens_tokenHash_key" ON "oauth_tokens"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_tokens_oauthCodeId_key" ON "oauth_tokens"("oauthCodeId");

-- CreateIndex
CREATE INDEX "oauth_tokens_oauthClientId_idx" ON "oauth_tokens"("oauthClientId");

-- AddForeignKey
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "solicitacoes_compartilhamento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_oauthClientId_fkey" FOREIGN KEY ("oauthClientId") REFERENCES "oauth_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_oauthClientId_fkey" FOREIGN KEY ("oauthClientId") REFERENCES "oauth_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_oauthCodeId_fkey" FOREIGN KEY ("oauthCodeId") REFERENCES "oauth_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solicitacoes_compartilhamento" ADD CONSTRAINT "solicitacoes_compartilhamento_integracaoId_fkey" FOREIGN KEY ("integracaoId") REFERENCES "oauth_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
