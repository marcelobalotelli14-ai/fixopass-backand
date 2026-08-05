-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "ativa" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "encerradaEm" TIMESTAMP(3);
