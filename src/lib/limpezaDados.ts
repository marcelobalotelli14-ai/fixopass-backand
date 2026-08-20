import { prisma } from './prisma';

/**
 * Limpeza de dados FAKE/TESTE (empresas e usuários) do banco de produção —
 * usada tanto pela rota administrativa (GET/DELETE /admin/dados-teste)
 * quanto pelo script de linha de comando (src/scripts/limparDadosTeste.ts).
 * Fica num único lugar pra rota e script nunca divergirem sobre "o que
 * conta como fake/teste".
 *
 * O schema não tem uma flag "isFake" — precisa inferir por heurística:
 *  - domínios de e-mail claramente de teste (example.com, test.com, etc.)
 *  - palavras-chave em nome/e-mail (teste, test, fake, demo, dummy, exemplo)
 *  - os valores exatos plantados por prisma/seed.ts (CPF/CNPJ/e-mail de seed)
 *
 * SEMPRE protegida, mesmo que bata na heurística acima: a conta do Admin
 * Master — identificada pelas env vars ADMIN_MASTER_EMAIL (compara com
 * Company.emailContato e/ou User.email) e ADMIN_MASTER_CPF (User.cpf).
 * Configure-as com os dados reais da conta que deve sobreviver à limpeza
 * ANTES de rodar isso contra o banco de produção — sem nenhuma delas
 * configurada, nada fica automaticamente protegido além do que a própria
 * heurística já deixa de fora.
 *
 * TAMBÉM SEMPRE protegida: a empresa "Pizzaria Balotelli" (conta real, não
 * teste) — casada pelo nome (comparação case-insensitive, ver
 * EMPRESA_PROTEGIDA_NOME) e, se configurado, também por
 * EMPRESA_PROTEGIDA_CNPJ/EMPRESA_PROTEGIDA_EMAIL (mais preciso que o nome,
 * útil caso ele mude no banco). O usuário associado a ela (dono/operador da
 * pizzaria, se for uma conta de User separada da própria conta da empresa)
 * pode ser protegido via USUARIO_PROTEGIDO_CPF/USUARIO_PROTEGIDO_EMAIL —
 * configure com os dados reais dessa pessoa se ela não for a mesma do Admin
 * Master.
 */

const DOMINIOS_TESTE = ['example.com', 'example.org', 'test.com', 'teste.com', 'fake.com', 'mailinator.com', 'yopmail.com', 'tempmail.com'];
const PALAVRAS_CHAVE = ['teste', 'test', 'fake', 'demo', 'dummy', 'exemplo'];

// Valores exatos plantados por prisma/seed.ts — sempre tratados como
// fake/teste, mesmo que alguém edite nome/e-mail depois e a heurística
// acima deixe de bater.
const SEED_CPFS = ['12345678900'];
const SEED_CNPJS = ['00000000000191'];
const SEED_EMAILS = ['maria@example.com', 'contato@bellapizza.example.com'];

function pareceTeste(...campos: (string | null | undefined)[]): boolean {
  for (const campo of campos) {
    if (!campo) continue;
    const valor = campo.toLowerCase();
    if (DOMINIOS_TESTE.some((dominio) => valor.includes(`@${dominio}`))) return true;
    if (PALAVRAS_CHAVE.some((palavra) => valor.includes(palavra))) return true;
  }
  return false;
}

function ehAdminMaster(campo: { email?: string | null; cpf?: string | null }): boolean {
  const emailMaster = process.env.ADMIN_MASTER_EMAIL?.toLowerCase();
  const cpfMaster = process.env.ADMIN_MASTER_CPF?.replace(/\D/g, '');
  if (emailMaster && campo.email?.toLowerCase() === emailMaster) return true;
  if (cpfMaster && campo.cpf && campo.cpf.replace(/\D/g, '') === cpfMaster) return true;
  return false;
}

// Empresa protegida por regra de negócio própria — nunca deve ser apagada
// pela limpeza, mesmo que o nome/e-mail/CNPJ dela bata na heurística de
// teste (não deveria bater, mas a proteção aqui é incondicional, igual à do
// Admin Master, então não depende disso).
const EMPRESA_PROTEGIDA_NOME = 'pizzaria balotelli';

function ehEmpresaProtegida(campo: { nome?: string | null; cnpj?: string | null; emailContato?: string | null }): boolean {
  if (campo.nome && campo.nome.toLowerCase().trim() === EMPRESA_PROTEGIDA_NOME) return true;
  const cnpjProtegido = process.env.EMPRESA_PROTEGIDA_CNPJ?.replace(/\D/g, '');
  if (cnpjProtegido && campo.cnpj && campo.cnpj.replace(/\D/g, '') === cnpjProtegido) return true;
  const emailProtegido = process.env.EMPRESA_PROTEGIDA_EMAIL?.toLowerCase();
  if (emailProtegido && campo.emailContato?.toLowerCase() === emailProtegido) return true;
  return false;
}

// Usuário associado à empresa protegida acima (se for uma pessoa diferente
// do Admin Master) — só protegido se USUARIO_PROTEGIDO_CPF/_EMAIL forem
// configurados; sem eles, nenhum User extra fica protegido por essa regra.
function ehUsuarioProtegido(campo: { email?: string | null; cpf?: string | null }): boolean {
  const emailProtegido = process.env.USUARIO_PROTEGIDO_EMAIL?.toLowerCase();
  const cpfProtegido = process.env.USUARIO_PROTEGIDO_CPF?.replace(/\D/g, '');
  if (emailProtegido && campo.email?.toLowerCase() === emailProtegido) return true;
  if (cpfProtegido && campo.cpf && campo.cpf.replace(/\D/g, '') === cpfProtegido) return true;
  return false;
}

export interface CandidatoLimpeza {
  id: string;
  tipo: 'company' | 'user';
  identificador: string; // nome + e-mail, só pra facilitar conferência humana antes de confirmar
  motivo: string;
}

/**
 * Varre companies e users e devolve só os que batem na heurística de
 * fake/teste — NÃO apaga nada. Use isso pra sempre revisar a lista antes de
 * chamar apagarCandidatosLimpeza.
 */
export async function listarCandidatosLimpeza(): Promise<CandidatoLimpeza[]> {
  const [companies, users] = await Promise.all([
    prisma.company.findMany({ select: { id: true, nome: true, cnpj: true, emailContato: true } }),
    prisma.user.findMany({ select: { id: true, nomeCompleto: true, cpf: true, email: true } }),
  ]);

  const candidatos: CandidatoLimpeza[] = [];

  for (const c of companies) {
    if (ehAdminMaster({ email: c.emailContato })) continue;
    if (ehEmpresaProtegida({ nome: c.nome, cnpj: c.cnpj, emailContato: c.emailContato })) continue;
    const seed = SEED_CNPJS.includes(c.cnpj) || SEED_EMAILS.includes(c.emailContato.toLowerCase());
    if (seed || pareceTeste(c.nome, c.emailContato, c.cnpj)) {
      candidatos.push({
        id: c.id,
        tipo: 'company',
        identificador: `${c.nome} <${c.emailContato}>`,
        motivo: seed ? 'dado plantado por prisma/seed.ts' : 'nome/e-mail/cnpj parece de teste',
      });
    }
  }

  for (const u of users) {
    if (ehAdminMaster({ email: u.email, cpf: u.cpf })) continue;
    if (ehUsuarioProtegido({ email: u.email, cpf: u.cpf })) continue;
    const seed = SEED_CPFS.includes(u.cpf) || SEED_EMAILS.includes(u.email.toLowerCase());
    if (seed || pareceTeste(u.nomeCompleto, u.email)) {
      candidatos.push({
        id: u.id,
        tipo: 'user',
        identificador: `${u.nomeCompleto} <${u.email}>`,
        motivo: seed ? 'dado plantado por prisma/seed.ts' : 'nome/e-mail parece de teste',
      });
    }
  }

  return candidatos;
}

export interface ResultadoLimpeza {
  companiesApagadas: number;
  usersApagados: number;
  ignorados: string[]; // ids pedidos que não batiam mais na heurística (ou eram o Admin Master/Pizzaria Balotelli/usuário protegido) — não apagados por segurança
}

/**
 * Apaga companyIds/userIds — mas SÓ os que ainda batem na heurística de
 * listarCandidatosLimpeza() no momento da chamada (segunda checagem
 * server-side, pra um id aprovado na tela de preview não valer "pra
 * sempre" caso o cadastro tenha sido editado nesse meio-tempo) e nunca a
 * conta do Admin Master, a empresa "Pizzaria Balotelli" ou o usuário
 * protegido associado a ela, mesmo que o chamador tenha mandado o id de um
 * deles por engano — listarCandidatosLimpeza() já os exclui da lista de
 * candidatos, então eles nunca batem nas checagens abaixo. Hard delete de
 * verdade (não é o soft-delete de
 * DELETE /companies/me) — cascade do schema (onDelete: Cascade) já remove
 * junto unidades, campos solicitados, autorizações, solicitações, logs de
 * acesso e OAuthClients/codes/tokens ligados.
 */
export async function apagarCandidatosLimpeza(companyIds: string[], userIds: string[]): Promise<ResultadoLimpeza> {
  const candidatos = await listarCandidatosLimpeza();
  const idsValidosCompany = new Set(candidatos.filter((c) => c.tipo === 'company').map((c) => c.id));
  const idsValidosUser = new Set(candidatos.filter((c) => c.tipo === 'user').map((c) => c.id));

  const ignorados: string[] = [];
  const companyIdsValidos = companyIds.filter((id) => {
    if (idsValidosCompany.has(id)) return true;
    ignorados.push(id);
    return false;
  });
  const userIdsValidos = userIds.filter((id) => {
    if (idsValidosUser.has(id)) return true;
    ignorados.push(id);
    return false;
  });

  const [companiesApagadas, usersApagados] = await prisma.$transaction([
    prisma.company.deleteMany({ where: { id: { in: companyIdsValidos } } }),
    prisma.user.deleteMany({ where: { id: { in: userIdsValidos } } }),
  ]);

  return {
    companiesApagadas: companiesApagadas.count,
    usersApagados: usersApagados.count,
    ignorados,
  };
}
