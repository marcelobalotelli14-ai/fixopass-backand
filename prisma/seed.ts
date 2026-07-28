import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const senhaHash = await bcrypt.hash('senha123', 10);
  const apiKeyPizzaria = 'fixopass_live_pizzaria_demo';
  const apiKeyHash = await bcrypt.hash(apiKeyPizzaria, 10);

  const user = await prisma.user.upsert({
    where: { cpf: '12345678900' },
    update: {},
    create: {
      nomeCompleto: 'Maria Silva',
      telefone: '+55 19 99999-0000',
      email: 'maria@example.com',
      cpf: '12345678900',
      rg: '12.345.678-9',
      dataNascimento: new Date('1990-05-10'),
      endereco: 'Rua das Flores, 123 - Limeira/SP',
      senhaHash,
    },
  });

  const company = await prisma.company.upsert({
    where: { cnpj: '00000000000191' },
    update: {},
    create: {
      nome: 'Bella Pizza',
      cnpj: '00000000000191',
      categoria: 'RESTAURANTE',
      emailContato: 'contato@bellapizza.example.com',
      senhaHash: await bcrypt.hash('senha123', 10),
      apiKeyHash,
      camposSolicitados: {
        create: [
          { campo: 'NOME', obrigatorio: true },
          { campo: 'TELEFONE', obrigatorio: true },
          { campo: 'ENDERECO', obrigatorio: true },
        ],
      },
      unidades: {
        create: [{ nome: 'Bella Pizza - Centro' }],
      },
    },
  });

  console.log('Seed concluído.');
  console.log('Usuário de teste:', user.id, user.cpf);
  console.log('Empresa de teste:', company.id, '- API Key:', apiKeyPizzaria);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
