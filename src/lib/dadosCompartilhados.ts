/**
 * Monta o payload de dados contendo SOMENTE os campos autorizados/liberados,
 * conforme o exemplo da especificação:
 * { nome: "", telefone: "", endereco: "", cpf: "" }
 *
 * Extraído de customer.ts para ser reaproveitado também por
 * GET /companies/me/compartilhamentos (histórico visível no painel da
 * empresa) — os dois lugares precisam resolver os mesmos campos pros
 * mesmos valores atuais do usuário, incluindo a foto (FOTO -> fotoUrl).
 */
export function montarPayloadDados(user: any, campos: string[]) {
  const map: Record<string, unknown> = {
    NOME: user.nomeCompleto,
    TELEFONE: user.telefone,
    EMAIL: user.email,
    CPF: user.cpf,
    RG: user.rg,
    DATA_NASCIMENTO: user.dataNascimento,
    ENDERECO: user.endereco,
    FOTO: user.fotoUrl,
  };

  const payload: Record<string, unknown> = {};
  for (const campo of campos) {
    const chave = campo.toLowerCase();
    payload[chave] = map[campo];
  }
  return payload;
}
