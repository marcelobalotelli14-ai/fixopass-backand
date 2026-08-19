import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 20000,
    // Um processo só: os testes compartilham a mesma instância do Prisma
    // Client (mesma pool de conexões) e algumas suítes dependem de estado
    // criado em beforeAll dentro do próprio arquivo — não há necessidade de
    // paralelismo pro tamanho atual da suíte, e evita qualquer disputa por
    // conexão com o Postgres de teste.
    fileParallelism: false,
  },
});
