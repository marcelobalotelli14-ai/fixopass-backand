import bcrypt from 'bcrypt';

/**
 * Hash bcrypt "canário" — nunca corresponde a senha nenhuma de verdade,
 * existe só para o bcrypt.compare ter o que fazer quando o e-mail não
 * existe no banco. Calculado uma única vez (bcrypt.hashSync tem o mesmo
 * custo de uma verificação real) e reaproveitado depois, em vez de gerar um
 * novo a cada tentativa de login à toa.
 */
let hashDummy: string | null = null;
function getHashDummy(): string {
  if (!hashDummy) {
    hashDummy = bcrypt.hashSync('senha-que-nunca-corresponde-a-nenhuma-conta-real', 10);
  }
  return hashDummy;
}

/**
 * Compara a senha informada contra o hash real de quem logou — OU, se essa
 * pessoa/empresa não existir (`hashReal` undefined/null), contra o hash
 * canário acima, com o MESMO custo bcrypt. Usado em POST /companies/login e
 * POST /users/login.
 *
 * MITIGAÇÃO DE TIMING ATTACK: sem isso, um código como
 * `!entidade || !(await bcrypt.compare(...))` faz curto-circuito no `||` —
 * quando a entidade não existe, bcrypt.compare NUNCA roda, e a resposta
 * volta quase instantânea; quando existe, bcrypt.compare custa ~50-100ms.
 * Essa diferença de tempo é observável de fora e permite enumerar e-mails
 * cadastrados só medindo quanto tempo o login demora para responder — mesmo
 * a mensagem de erro sendo idêntica nos dois casos. Chamando esta função
 * incondicionalmente (sempre awaited, sempre pagando o custo do bcrypt,
 * real ou canário) antes de checar se a entidade existe, o tempo de
 * resposta fica igual nos dois cenários.
 */
export async function senhaConfere(senhaInformada: string, hashReal: string | undefined | null): Promise<boolean> {
  const bateu = await bcrypt.compare(senhaInformada, hashReal || getHashDummy());
  // Reforça o resultado: mesmo na hipótese astronomicamente improvável de
  // `senhaInformada` bater com o hash canário, isso nunca deve autenticar
  // ninguém — só retorna true quando havia de fato um hashReal e ele bateu.
  return Boolean(hashReal) && bateu;
}
