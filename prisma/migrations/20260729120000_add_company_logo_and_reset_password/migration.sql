-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "logoUrl" TEXT,
ADD COLUMN     "resetPasswordExpiresAt" TIMESTAMP(3),
ADD COLUMN     "resetPasswordTokenHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "companies_resetPasswordTokenHash_key" ON "companies"("resetPasswordTokenHash");
