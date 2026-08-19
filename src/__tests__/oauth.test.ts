import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import { prisma } from '../lib/prisma';

function basicAuthHeader(clientId: string, clientSecret: string) {
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

/** CPF/CNPJ únicos por teste — o projeto não valida dígito verificador
 * (ver CHECKLIST-PILOTO.md), só formato/tamanho, então qualquer sequência
 * de dígitos serve; só precisa ser única entre os testes. */
let contador = 0;
function proximoDocumento(digitos: number): string {
  contador += 1;
  return String(Date.now()).slice(-6).padStart(6, '0') + String(contador).padStart(digitos - 6, '0');
}

describe('Canal WEB/API — OAuth2 (/oauth/*) — Pizzaria Balotelli de teste', () => {
  let companyId: string;
  let panelHeaders: Record<string, string>;
  let oauthClientA: { id: string; clientId: string; clientSecret: string };
  let userId: string;
  const REDIRECT_URI = 'https://cardapio-teste.example.com/fixopass/callback';

  beforeAll(async () => {
    const cadastro = await request(app)
      .post('/companies')
      .send({
        nome: 'Pizzaria Balotelli de Teste',
        cnpj: proximoDocumento(14),
        categoria: 'RESTAURANTE',
        emailContato: `pizzaria.teste.${Date.now()}@example.com`,
        senha: 'senha123',
      });
    expect(cadastro.status).toBe(201);
    companyId = cadastro.body.id;
    panelHeaders = { 'X-COMPANY-ID': companyId };

    // Mesmo caso de uso do módulo: nome, telefone e endereço — sem CPF/RG.
    const campos = await request(app)
      .put('/companies/me/campos-solicitados')
      .set(panelHeaders)
      .send({
        campos: [
          { campo: 'NOME', obrigatorio: true },
          { campo: 'TELEFONE', obrigatorio: true },
          { campo: 'ENDERECO', obrigatorio: true },
        ],
      });
    expect(campos.status).toBe(200);

    const clienteResp = await request(app)
      .post('/companies/me/integracoes')
      .set(panelHeaders)
      .send({ nome: 'Cardápio Online', redirectUris: [REDIRECT_URI] });
    expect(clienteResp.status).toBe(201);
    expect(clienteResp.body.clientSecret).toBeTruthy();
    oauthClientA = {
      id: clienteResp.body.id,
      clientId: clienteResp.body.clientId,
      clientSecret: clienteResp.body.clientSecret,
    };

    const usuario = await request(app)
      .post('/users')
      .send({
        nomeCompleto: 'Cliente de Teste',
        telefone: '19999990000',
        email: `cliente.teste.${Date.now()}@example.com`,
        cpf: proximoDocumento(11),
        endereco: 'Rua Exemplo, 123',
        senha: 'senha123',
      });
    expect(usuario.status).toBe(201);
    userId = usuario.body.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('POST /oauth/authorize cria a solicitação com credenciais válidas', async () => {
    const resp = await request(app)
      .post('/oauth/authorize')
      .set('Authorization', basicAuthHeader(oauthClientA.clientId, oauthClientA.clientSecret))
      .send({ response_type: 'code', redirect_uri: REDIRECT_URI, purpose: 'Preenchimento dos dados de entrega' });

    expect(resp.status).toBe(201);
    expect(resp.body.requestId).toBeTruthy();
    expect(resp.body.authorizationUrl).toContain(resp.body.requestId);
  });

  it('rejeita credenciais de client inválidas (invalid_client)', async () => {
    const resp = await request(app)
      .post('/oauth/authorize')
      .set('Authorization', basicAuthHeader(oauthClientA.clientId, 'secret-errado'))
      .send({ response_type: 'code', redirect_uri: REDIRECT_URI });
    expect(resp.status).toBe(401);
    expect(resp.body.error).toBe('invalid_client');
  });

  it('rejeita redirect_uri não cadastrada (anti open-redirect)', async () => {
    const resp = await request(app)
      .post('/oauth/authorize')
      .set('Authorization', basicAuthHeader(oauthClientA.clientId, oauthClientA.clientSecret))
      .send({ response_type: 'code', redirect_uri: 'https://dominio-nao-cadastrado.example.com/callback' });
    expect(resp.status).toBe(400);
    expect(resp.body.error).toBe('invalid_request');
  });

  it('rejeita escopo que a empresa não configurou (CPF fora do permitido)', async () => {
    const resp = await request(app)
      .post('/oauth/authorize')
      .set('Authorization', basicAuthHeader(oauthClientA.clientId, oauthClientA.clientSecret))
      .send({ response_type: 'code', redirect_uri: REDIRECT_URI, scope: 'NOME CPF' });
    expect(resp.status).toBe(400);
    expect(resp.body.error).toBe('invalid_scope');
  });

  it('rejeita escopo desconhecido (não é um CampoDado válido)', async () => {
    const resp = await request(app)
      .post('/oauth/authorize')
      .set('Authorization', basicAuthHeader(oauthClientA.clientId, oauthClientA.clientSecret))
      .send({ response_type: 'code', redirect_uri: REDIRECT_URI, scope: 'NOME PASSAPORTE' });
    expect(resp.status).toBe(400);
    expect(resp.body.error).toBe('invalid_scope');
  });

  it('exige X-USER-ID para ver/decidir a solicitação', async () => {
    const criar = await request(app)
      .post('/oauth/authorize')
      .set('Authorization', basicAuthHeader(oauthClientA.clientId, oauthClientA.clientSecret))
      .send({ response_type: 'code', redirect_uri: REDIRECT_URI });

    const semAuth = await request(app).get(`/oauth/authorize/${criar.body.requestId}`);
    expect(semAuth.status).toBe(401);
  });

  it('fluxo completo: authorize -> consentimento -> code -> token -> userinfo (reutilizável) -> só os campos pedidos (nunca CPF/RG)', async () => {
    const criar = await request(app)
      .post('/oauth/authorize')
      .set('Authorization', basicAuthHeader(oauthClientA.clientId, oauthClientA.clientSecret))
      .send({ response_type: 'code', redirect_uri: REDIRECT_URI, purpose: 'Preenchimento dos dados de entrega' });
    const requestId = criar.body.requestId;

    const consulta = await request(app).get(`/oauth/authorize/${requestId}`).set('X-USER-ID', userId);
    expect(consulta.status).toBe(200);
    expect(consulta.body.empresa).toBe('Pizzaria Balotelli de Teste');
    expect([...consulta.body.camposPedidos].sort()).toEqual(['ENDERECO', 'NOME', 'TELEFONE']);
    expect(consulta.body.camposPedidos).not.toContain('CPF');
    expect(consulta.body.camposPedidos).not.toContain('RG');

    const aprovar = await request(app)
      .post(`/oauth/authorize/${requestId}`)
      .set('X-USER-ID', userId)
      .send({ aprovar: true });
    expect(aprovar.status).toBe(200);
    expect(aprovar.body.status).toBe('APROVADA');
    expect(aprovar.body.code).toBeTruthy();
    // Sem state próprio do client, cai no requestId (compatibilidade).
    expect(aprovar.body.state).toBe(requestId);
    // O navegador NUNCA recebe os dados — só o code.
    expect(aprovar.body).not.toHaveProperty('dados');
    expect(aprovar.body).not.toHaveProperty('data');
    const code = aprovar.body.code as string;

    const trocar = await request(app)
      .post('/oauth/token')
      .set('Authorization', basicAuthHeader(oauthClientA.clientId, oauthClientA.clientSecret))
      .send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
    expect(trocar.status).toBe(200);
    expect(trocar.body.token_type).toBe('Bearer');
    expect(trocar.body.access_token).toBeTruthy();
    expect(typeof trocar.body.expires_in).toBe('number');
    const accessToken = trocar.body.access_token as string;

    // O CODE é de uso único — trocar de novo falha.
    const reusoCode = await request(app)
      .post('/oauth/token')
      .set('Authorization', basicAuthHeader(oauthClientA.clientId, oauthClientA.clientSecret))
      .send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
    expect(reusoCode.status).toBe(400);
    expect(reusoCode.body.error).toBe('invalid_grant');

    // O TOKEN, ao contrário do code, é reutilizável — duas chamadas de
    // userinfo com o mesmo token funcionam (é a diferença real pro canal
    // se comportar como SSO).
    const userinfo1 = await request(app).get('/oauth/userinfo').set('Authorization', `Bearer ${accessToken}`);
    expect(userinfo1.status).toBe(200);
    expect(userinfo1.body.data.nome).toBe('Cliente de Teste');
    expect(userinfo1.body.data.telefone).toBeTruthy();
    expect(userinfo1.body.data.endereco).toBeTruthy();
    expect(userinfo1.body.data).not.toHaveProperty('cpf');
    expect(userinfo1.body.data).not.toHaveProperty('rg');

    const userinfo2 = await request(app).get('/oauth/userinfo').set('Authorization', `Bearer ${accessToken}`);
    expect(userinfo2.status).toBe(200);
    expect(userinfo2.body.data.nome).toBe('Cliente de Teste');
  });

  it('state próprio do client é ecoado de volta exatamente como enviado', async () => {
    const criar = await request(app)
      .post('/oauth/authorize')
      .set('Authorization', basicAuthHeader(oauthClientA.clientId, oauthClientA.clientSecret))
      .send({ response_type: 'code', redirect_uri: REDIRECT_URI, state: 'csrf-nonce-do-cliente-123' });
    const requestId = criar.body.requestId;

    await request(app).get(`/oauth/authorize/${requestId}`).set('X-USER-ID', userId);
    const aprovar = await request(app)
      .post(`/oauth/authorize/${requestId}`)
      .set('X-USER-ID', userId)
      .send({ aprovar: true });
    expect(aprovar.body.state).toBe('csrf-nonce-do-cliente-123');
  });

  it('nega: nenhum code é emitido e a solicitação não pode ser reaberta', async () => {
    const criar = await request(app)
      .post('/oauth/authorize')
      .set('Authorization', basicAuthHeader(oauthClientA.clientId, oauthClientA.clientSecret))
      .send({ response_type: 'code', redirect_uri: REDIRECT_URI });
    const requestId = criar.body.requestId;

    await request(app).get(`/oauth/authorize/${requestId}`).set('X-USER-ID', userId);

    const negar = await request(app)
      .post(`/oauth/authorize/${requestId}`)
      .set('X-USER-ID', userId)
      .send({ aprovar: false });
    expect(negar.status).toBe(200);
    expect(negar.body.status).toBe('NEGADA');
    expect(negar.body.code).toBeUndefined();

    const tentarDeNovo = await request(app)
      .post(`/oauth/authorize/${requestId}`)
      .set('X-USER-ID', userId)
      .send({ aprovar: true });
    expect(tentarDeNovo.status).toBe(409);
  });

  it('código expirado não pode ser trocado', async () => {
    const criar = await request(app)
      .post('/oauth/authorize')
      .set('Authorization', basicAuthHeader(oauthClientA.clientId, oauthClientA.clientSecret))
      .send({ response_type: 'code', redirect_uri: REDIRECT_URI });
    const requestId = criar.body.requestId;
    await request(app).get(`/oauth/authorize/${requestId}`).set('X-USER-ID', userId);
    const aprovar = await request(app)
      .post(`/oauth/authorize/${requestId}`)
      .set('X-USER-ID', userId)
      .send({ aprovar: true });
    const code = aprovar.body.code as string;

    // Simula os 2 minutos de validade do code já tendo passado.
    await prisma.oAuthCode.updateMany({
      where: { requestId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const trocar = await request(app)
      .post('/oauth/token')
      .set('Authorization', basicAuthHeader(oauthClientA.clientId, oauthClientA.clientSecret))
      .send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
    expect(trocar.status).toBe(400);
    expect(trocar.body.error).toBe('invalid_grant');
    expect(trocar.body.error_description).toMatch(/expirado/i);
  });

  it('token expirado não pode ser usado em userinfo', async () => {
    const criar = await request(app)
      .post('/oauth/authorize')
      .set('Authorization', basicAuthHeader(oauthClientA.clientId, oauthClientA.clientSecret))
      .send({ response_type: 'code', redirect_uri: REDIRECT_URI });
    const requestId = criar.body.requestId;
    await request(app).get(`/oauth/authorize/${requestId}`).set('X-USER-ID', userId);
    const aprovar = await request(app)
      .post(`/oauth/authorize/${requestId}`)
      .set('X-USER-ID', userId)
      .send({ aprovar: true });
    const trocar = await request(app)
      .post('/oauth/token')
      .set('Authorization', basicAuthHeader(oauthClientA.clientId, oauthClientA.clientSecret))
      .send({ grant_type: 'authorization_code', code: aprovar.body.code, redirect_uri: REDIRECT_URI });
    const accessToken = trocar.body.access_token as string;

    await prisma.oAuthToken.updateMany({
      where: { oauthCodeId: (await prisma.oAuthCode.findUniqueOrThrow({ where: { requestId } })).id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const userinfo = await request(app).get('/oauth/userinfo').set('Authorization', `Bearer ${accessToken}`);
    expect(userinfo.status).toBe(401);
    expect(userinfo.body.error).toBe('invalid_token');
  });

  it('userinfo sem Bearer -> 401', async () => {
    const resp = await request(app).get('/oauth/userinfo');
    expect(resp.status).toBe(401);
    expect(resp.body.error).toBe('invalid_token');
  });

  it('solicitação expirada não pode mais ser vista como pendente nem aprovada', async () => {
    const criar = await request(app)
      .post('/oauth/authorize')
      .set('Authorization', basicAuthHeader(oauthClientA.clientId, oauthClientA.clientSecret))
      .send({ response_type: 'code', redirect_uri: REDIRECT_URI });
    const requestId = criar.body.requestId;

    await prisma.solicitacaoCompartilhamento.update({
      where: { id: requestId },
      data: { expiraEm: new Date(Date.now() - 1000) },
    });

    const consulta = await request(app).get(`/oauth/authorize/${requestId}`).set('X-USER-ID', userId);
    expect(consulta.status).toBe(200);
    expect(consulta.body.status).toBe('EXPIRADA');

    const aprovar = await request(app)
      .post(`/oauth/authorize/${requestId}`)
      .set('X-USER-ID', userId)
      .send({ aprovar: true });
    expect(aprovar.status).toBe(409);
  });

  it('isolamento multi-tenant: o client de outra empresa não troca um code que não é dele', async () => {
    const cadastroB = await request(app)
      .post('/companies')
      .send({
        nome: 'Concorrente de Teste',
        cnpj: proximoDocumento(14),
        categoria: 'RESTAURANTE',
        emailContato: `concorrente.teste.${Date.now()}@example.com`,
        senha: 'senha123',
      });
    const clienteBResp = await request(app)
      .post('/companies/me/integracoes')
      .set('X-COMPANY-ID', cadastroB.body.id)
      .send({ nome: 'Sistema B', redirectUris: ['https://outro-cardapio.example.com/callback'] });

    const criar = await request(app)
      .post('/oauth/authorize')
      .set('Authorization', basicAuthHeader(oauthClientA.clientId, oauthClientA.clientSecret))
      .send({ response_type: 'code', redirect_uri: REDIRECT_URI });
    const requestId = criar.body.requestId;
    await request(app).get(`/oauth/authorize/${requestId}`).set('X-USER-ID', userId);
    const aprovar = await request(app)
      .post(`/oauth/authorize/${requestId}`)
      .set('X-USER-ID', userId)
      .send({ aprovar: true });
    const code = aprovar.body.code as string;

    const trocaCruzada = await request(app)
      .post('/oauth/token')
      .set('Authorization', basicAuthHeader(clienteBResp.body.clientId, clienteBResp.body.clientSecret))
      .send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
    expect(trocaCruzada.status).toBe(403);
    expect(trocaCruzada.body.error).toBe('invalid_grant');
  });

  it('client revogado não consegue mais criar solicitações (deixado por último — muda o estado de oauthClientA)', async () => {
    const revogar = await request(app).delete(`/companies/me/integracoes/${oauthClientA.id}`).set(panelHeaders);
    expect(revogar.status).toBe(204);

    const tentativa = await request(app)
      .post('/oauth/authorize')
      .set('Authorization', basicAuthHeader(oauthClientA.clientId, oauthClientA.clientSecret))
      .send({ response_type: 'code', redirect_uri: REDIRECT_URI });
    expect(tentativa.status).toBe(401);
    expect(tentativa.body.error).toBe('invalid_client');
  });
});

describe('Regressão — NFC e QR Code continuam funcionando sem alteração de comportamento', () => {
  let companyId: string;
  let unidadeId: string;
  let qrCodeToken: string;
  let userId: string;

  beforeAll(async () => {
    const cadastro = await request(app)
      .post('/companies')
      .send({
        nome: 'Condomínio de Teste',
        cnpj: proximoDocumento(14),
        categoria: 'CONDOMINIO',
        emailContato: `condominio.teste.${Date.now()}@example.com`,
        senha: 'senha123',
      });
    companyId = cadastro.body.id;

    await request(app)
      .put('/companies/me/campos-solicitados')
      .set('X-COMPANY-ID', companyId)
      .send({
        campos: [
          { campo: 'NOME', obrigatorio: true },
          { campo: 'TELEFONE', obrigatorio: true },
        ],
      });

    const unidade = await request(app)
      .post('/companies/me/unidades')
      .set('X-COMPANY-ID', companyId)
      .send({ nome: 'Portaria Principal' });
    unidadeId = unidade.body.id;
    qrCodeToken = unidade.body.qrCodeToken;

    const usuario = await request(app)
      .post('/users')
      .send({
        nomeCompleto: 'Morador de Teste',
        telefone: '19988880000',
        email: `morador.teste.${Date.now()}@example.com`,
        cpf: proximoDocumento(11),
        senha: 'senha123',
      });
    userId = usuario.body.id;
  });

  it('QR Code: leitura -> aprovação -> dados liberados direto pro app (sem passar por /oauth)', async () => {
    const solicitar = await request(app).post('/auth/request').set('X-USER-ID', userId).send({ metodo: 'QRCODE', qrCodeToken });
    expect(solicitar.status).toBe(201);

    const aprovar = await request(app)
      .post('/customer/share')
      .set('X-USER-ID', userId)
      .send({ solicitacaoId: solicitar.body.solicitacaoId, aprovar: true });
    expect(aprovar.status).toBe(200);
    expect(aprovar.body.status).toBe('APROVADA');
    expect(aprovar.body.dados.nome).toBe('Morador de Teste');
  });

  it('NFC: leitura (companyId + unidadeId) -> aprovação -> dados liberados', async () => {
    const solicitar = await request(app)
      .post('/auth/request')
      .set('X-USER-ID', userId)
      .send({ metodo: 'NFC', companyId, unidadeId });
    expect(solicitar.status).toBe(201);

    const aprovar = await request(app)
      .post('/customer/share')
      .set('X-USER-ID', userId)
      .send({ solicitacaoId: solicitar.body.solicitacaoId, aprovar: true });
    expect(aprovar.status).toBe(200);
    expect(aprovar.body.status).toBe('APROVADA');
    expect(aprovar.body.dados.telefone).toBeTruthy();
  });
});
