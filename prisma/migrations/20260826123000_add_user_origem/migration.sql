-- CreateEnum
CREATE TYPE "OrigemCadastro" AS ENUM ('QRCODE', 'NFC', 'LINK_WEB', 'MANUAL');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "origem" "OrigemCadastro" NOT NULL DEFAULT 'MANUAL';
