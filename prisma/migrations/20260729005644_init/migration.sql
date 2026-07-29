-- CreateEnum
CREATE TYPE "CampoDado" AS ENUM ('NOME', 'TELEFONE', 'EMAIL', 'CPF', 'RG', 'DATA_NASCIMENTO', 'ENDERECO', 'FOTO');

-- CreateEnum
CREATE TYPE "CategoriaEmpresa" AS ENUM ('RESTAURANTE', 'CONDOMINIO', 'HOSPITAL', 'HOTEL', 'LOJA', 'OUTROS');

-- CreateEnum
CREATE TYPE "StatusSolicitacao" AS ENUM ('PENDENTE', 'APROVADA', 'NEGADA', 'EXPIRADA');

-- CreateEnum
CREATE TYPE "MetodoIdentificacao" AS ENUM ('NFC', 'QRCODE', 'CONSULTA_API');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "nomeCompleto" TEXT NOT NULL,
    "telefone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "cpf" TEXT NOT NULL,
    "rg" TEXT,
    "dataNascimento" TIMESTAMP(3),
    "endereco" TEXT,
    "fotoUrl" TEXT,
    "expoPushToken" TEXT,
    "senhaHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "cnpj" TEXT NOT NULL,
    "categoria" "CategoriaEmpresa" NOT NULL,
    "emailContato" TEXT NOT NULL,
    "senhaHash" TEXT NOT NULL,
    "apiKeyHash" TEXT NOT NULL,
    "webhookUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unidades" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "endereco" TEXT,
    "qrCodeToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unidades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campos_solicitados_empresa" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "campo" "CampoDado" NOT NULL,
    "obrigatorio" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "campos_solicitados_empresa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "autorizacoes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "camposLiberados" "CampoDado"[],
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "dataAutorizacao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataRevogacao" TIMESTAMP(3),

    CONSTRAINT "autorizacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "solicitacoes_compartilhamento" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "unidadeId" TEXT,
    "metodo" "MetodoIdentificacao" NOT NULL,
    "camposPedidos" "CampoDado"[],
    "status" "StatusSolicitacao" NOT NULL DEFAULT 'PENDENTE',
    "criadaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvidaEm" TIMESTAMP(3),

    CONSTRAINT "solicitacoes_compartilhamento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "logs_acesso" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "camposEnviados" "CampoDado"[],
    "metodo" "MetodoIdentificacao" NOT NULL,
    "ipOrigem" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "logs_acesso_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_cpf_key" ON "users"("cpf");

-- CreateIndex
CREATE UNIQUE INDEX "companies_cnpj_key" ON "companies"("cnpj");

-- CreateIndex
CREATE UNIQUE INDEX "companies_emailContato_key" ON "companies"("emailContato");

-- CreateIndex
CREATE UNIQUE INDEX "companies_apiKeyHash_key" ON "companies"("apiKeyHash");

-- CreateIndex
CREATE UNIQUE INDEX "unidades_qrCodeToken_key" ON "unidades"("qrCodeToken");

-- CreateIndex
CREATE UNIQUE INDEX "campos_solicitados_empresa_companyId_campo_key" ON "campos_solicitados_empresa"("companyId", "campo");

-- CreateIndex
CREATE UNIQUE INDEX "autorizacoes_userId_companyId_key" ON "autorizacoes"("userId", "companyId");

-- AddForeignKey
ALTER TABLE "unidades" ADD CONSTRAINT "unidades_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campos_solicitados_empresa" ADD CONSTRAINT "campos_solicitados_empresa_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autorizacoes" ADD CONSTRAINT "autorizacoes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autorizacoes" ADD CONSTRAINT "autorizacoes_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solicitacoes_compartilhamento" ADD CONSTRAINT "solicitacoes_compartilhamento_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solicitacoes_compartilhamento" ADD CONSTRAINT "solicitacoes_compartilhamento_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solicitacoes_compartilhamento" ADD CONSTRAINT "solicitacoes_compartilhamento_unidadeId_fkey" FOREIGN KEY ("unidadeId") REFERENCES "unidades"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logs_acesso" ADD CONSTRAINT "logs_acesso_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logs_acesso" ADD CONSTRAINT "logs_acesso_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

