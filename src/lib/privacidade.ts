import { CampoDado } from '@prisma/client';
import { prisma } from './prisma';

// EMAIL não entra aqui de propósito — o controle de privacidade por
// categoria (PrivacidadeCategoria) só cobre foto/nome/cpf/rg/dataNascimento/
// telefone/endereco, conforme especificado. EMAIL continua regulado só pelo
// que a empresa pede + aprovação pontual do usuário, sem essa camada extra.
const MAPA_CAMPO_PARA_CHAVE_PRIVACIDADE: Record<string, string> = {
  FOTO: 'foto',
  NOME: 'nome',
  CPF: 'cpf',
  RG: 'rg',
  DATA_NASCIMENTO: 'dataNascimento',
  TELEFONE: 'telefone',
  ENDERECO: 'endereco',
};

/**
 * Filtra `camposPedidos` (o que a empresa configurou pedir, via
 * PUT /companies/me/campos-solicitados) pelo que o usuário já liberou de
 * antemão pra ESSE TIPO de estabelecimento — antes mesmo da tela de
 * aprovação pontual aparecer. Chamado em POST /auth/request.
 *
 * Prioridade: regra específica da categoria da empresa > regra GERAL > sem
 * regra nenhuma (comportamento anterior a essa feature: não filtra nada além
 * do que a empresa já pediu, pra não quebrar quem nunca configurou isso).
 */
export async function filtrarCamposPorPrivacidade(
  userId: string,
  categoriaEmpresa: string,
  camposPedidos: CampoDado[]
): Promise<CampoDado[]> {
  const regra =
    (await prisma.privacidadeCategoria.findUnique({
      where: { userId_categoria: { userId, categoria: categoriaEmpresa as any } },
    })) ??
    (await prisma.privacidadeCategoria.findUnique({
      where: { userId_categoria: { userId, categoria: 'GERAL' } },
    }));

  if (!regra) return camposPedidos;

  return camposPedidos.filter((campo) => {
    const chave = MAPA_CAMPO_PARA_CHAVE_PRIVACIDADE[campo];
    if (!chave) return true; // EMAIL (fora do controle de privacidade) sempre passa
    return (regra as unknown as Record<string, boolean>)[chave] === true;
  });
}
