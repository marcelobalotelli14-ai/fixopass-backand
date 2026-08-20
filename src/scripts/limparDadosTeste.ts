/**
 * Script de linha de comando pra limpar cadastros FAKE/TESTE do banco
 * (empresas e usuários) — mesma heurística e mesma proteção ao Admin Master
 * da rota administrativa GET/DELETE /admin/dados-teste (ver
 * src/lib/limpezaDados.ts pra detalhes de como cada um decide o que é
 * "teste").
 *
 * Rodar contra o Railway: aponte DATABASE_URL pra connection string de
 * produção (ex.: variável já configurada no ambiente, ou um .env local
 * temporário) e, se quiser proteger uma conta específica além da
 * heurística, configure ADMIN_MASTER_EMAIL e/ou ADMIN_MASTER_CPF antes de
 * rodar.
 *
 * A empresa "Pizzaria Balotelli" é SEMPRE protegida (casada pelo nome, ver
 * EMPRESA_PROTEGIDA_NOME em src/lib/limpezaDados.ts) — não precisa de env
 * var pra isso. Se quiser reforçar por CNPJ/e-mail, ou proteger o usuário
 * dono dela (caso não seja a mesma pessoa do Admin Master), configure
 * também EMPRESA_PROTEGIDA_CNPJ, EMPRESA_PROTEGIDA_EMAIL,
 * USUARIO_PROTEGIDO_CPF e/ou USUARIO_PROTEGIDO_EMAIL antes de rodar.
 *
 * Uso:
 *   npx ts-node src/scripts/limparDadosTeste.ts            # dry-run — só lista, não apaga nada
 *   npx ts-node src/scripts/limparDadosTeste.ts --confirmar # apaga de verdade os listados no dry-run
 *
 * (ou via npm run, ver package.json: "npm run limpar:teste" / "npm run limpar:teste -- --confirmar")
 */
import 'dotenv/config';
import { listarCandidatosLimpeza, apagarCandidatosLimpeza } from '../lib/limpezaDados';
import { prisma } from '../lib/prisma';

async function main() {
  const confirmar = process.argv.includes('--confirmar');

  const candidatos = await listarCandidatosLimpeza();

  if (candidatos.length === 0) {
    console.log('Nenhum cadastro com cara de FAKE/TESTE encontrado. Nada a fazer.');
    return;
  }

  console.log(`Encontrados ${candidatos.length} cadastro(s) com cara de FAKE/TESTE:\n`);
  for (const c of candidatos) {
    console.log(`  [${c.tipo}] ${c.identificador} — ${c.motivo} (id: ${c.id})`);
  }

  if (!confirmar) {
    console.log('\nDRY-RUN: nada foi apagado. Revise a lista acima e rode de novo com --confirmar para apagar de verdade.');
    return;
  }

  const companyIds = candidatos.filter((c) => c.tipo === 'company').map((c) => c.id);
  const userIds = candidatos.filter((c) => c.tipo === 'user').map((c) => c.id);

  const resultado = await apagarCandidatosLimpeza(companyIds, userIds);
  console.log(
    `\nApagado(s): ${resultado.companiesApagadas} empresa(s), ${resultado.usersApagados} usuário(s).` +
      (resultado.ignorados.length > 0 ? ` Ignorado(s) (não batiam mais na heurística): ${resultado.ignorados.join(', ')}.` : '')
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
