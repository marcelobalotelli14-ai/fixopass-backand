-- CreateEnum
CREATE TYPE "CategoriaPrivacidade" AS ENUM ('RESTAURANTE', 'CONDOMINIO', 'HOSPITAL', 'HOTEL', 'LOJA', 'OUTROS', 'GERAL');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "enderecoBairro" TEXT,
ADD COLUMN     "enderecoCep" TEXT,
ADD COLUMN     "enderecoCidade" TEXT,
ADD COLUMN     "enderecoComplemento" TEXT,
ADD COLUMN     "enderecoEstado" TEXT,
ADD COLUMN     "enderecoLogradouro" TEXT,
ADD COLUMN     "enderecoNumero" TEXT;

-- CreateTable
CREATE TABLE "privacidade_categorias" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "categoria" "CategoriaPrivacidade" NOT NULL,
    "foto" BOOLEAN NOT NULL DEFAULT false,
    "nome" BOOLEAN NOT NULL DEFAULT true,
    "cpf" BOOLEAN NOT NULL DEFAULT false,
    "rg" BOOLEAN NOT NULL DEFAULT false,
    "dataNascimento" BOOLEAN NOT NULL DEFAULT false,
    "telefone" BOOLEAN NOT NULL DEFAULT false,
    "endereco" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "privacidade_categorias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "privacidade_categorias_userId_categoria_key" ON "privacidade_categorias"("userId", "categoria");

-- AddForeignKey
ALTER TABLE "privacidade_categorias" ADD CONSTRAINT "privacidade_categorias_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
