import { PrismaClient } from '@prisma/client';

// Instância única do Prisma Client, reaproveitada em toda a aplicação
export const prisma = new PrismaClient();
