/**
 * Monta uma linha de endereço legível a partir dos campos estruturados
 * (preenchidos pela web em Meus dados). Cai pro texto livre (`endereco`,
 * o que o mobile-app sempre enviou) quando a pessoa não preencheu os
 * campos estruturados — nunca os dois juntos, pra não duplicar informação.
 */
function formatarEndereco(user: any): string | null {
  const { enderecoLogradouro, enderecoNumero, enderecoComplemento, enderecoBairro, enderecoCidade, enderecoEstado, enderecoCep } = user;
  const temEstruturado = [enderecoLogradouro, enderecoNumero, enderecoBairro, enderecoCidade, enderecoEstado].some(Boolean);
  if (!temEstruturado) return user.endereco ?? null;

  const linha1 = [enderecoLogradouro, enderecoNumero].filter(Boolean).join(', ') + (enderecoComplemento ? ` - ${enderecoComplemento}` : '');
  const linha2 = [enderecoBairro, enderecoCidade && enderecoEstado ? `${enderecoCidade}/${enderecoEstado}` : enderecoCidade || enderecoEstado, enderecoCep]
    .filter(Boolean)
    .join(', ');
  return [linha1, linha2].filter(Boolean).join(' - ');
}

/**
 * Monta o payload de dados contendo SOMENTE os campos autorizados/liberados,
 * conforme o exemplo da especificação:
 * { nome: "", telefone: "", endereco: "", cpf: "" }
 *
 * Extraído de customer.ts para ser reaproveitado também por
 * GET /companies/me/compartilhamentos (histórico visível no painel da
 * empresa) — os dois lugares precisam resolver os mesmos campos pros
 * mesmos valores atuais do usuário, incluindo a foto (FOTO -> fotoUrl).
 *
 * ENDERECO continua devolvendo `endereco` (string formatada, compatível com
 * quem já consome só esse campo) e ADICIONALMENTE os pedaços estruturados
 * (enderecoLogradouro/Numero/Complemento/Bairro/Cidade/Estado/Cep), quando
 * a pessoa preencheu o endereço estruturado (Meus dados, na web) — null
 * quando ela só tem o texto livre antigo do app (formatarEndereco explica
 * o motivo de nunca ter os dois "cheios" ao mesmo tempo). Puramente
 * aditivo: quem já lia só `endereco` como string continua funcionando
 * igual, sem quebra de contrato.
 */
export function montarPayloadDados(user: any, campos: string[]) {
  const map: Record<string, unknown> = {
    NOME: user.nomeCompleto,
    TELEFONE: user.telefone,
    EMAIL: user.email,
    CPF: user.cpf,
    RG: user.rg,
    DATA_NASCIMENTO: user.dataNascimento,
    ENDERECO: formatarEndereco(user),
    FOTO: user.fotoUrl,
  };

  const payload: Record<string, unknown> = {};
  for (const campo of campos) {
    const chave = campo.toLowerCase();
    payload[chave] = map[campo];
    if (campo === 'ENDERECO') {
      payload.enderecoLogradouro = user.enderecoLogradouro ?? null;
      payload.enderecoNumero = user.enderecoNumero ?? null;
      payload.enderecoComplemento = user.enderecoComplemento ?? null;
      payload.enderecoBairro = user.enderecoBairro ?? null;
      payload.enderecoCidade = user.enderecoCidade ?? null;
      payload.enderecoEstado = user.enderecoEstado ?? null;
      payload.enderecoCep = user.enderecoCep ?? null;
    }
  }
  return payload;
}
