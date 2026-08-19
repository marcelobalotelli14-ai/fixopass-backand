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

describe('Canal WEB/API — /integrations/* (Pizzaria Balotelli de teste)', () => {
  let companyId: string;
  let panelHeaders: Record<string, string>;
  let integracaoA: { id: string; clientId: string; clientSecret: string };
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

    const integracaoResp = await request(app)
      .post('/companies/me/integracoes')
      .set(panelHeaders)
      .send({ nome: 'Cardápio Online', redirectUris: [REDIRECT_URI] });
    expect(integracaoResp.status).toBe(201);
    expect(integracaoResp.body.clientSecret).toBeTruthy();
    integracaoA = {
      id: integracaoResp.body.id,
      clientId: integracaoResp.body.clientId,
      clientSecret: integracaoResp.body.clientSecret,
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

  it('cria uma solicitação de autorização com credenciais válidas', async () => {
    const resp = await request(app)
      .post('/integrations/authorization-requests')
      .set('Authorization', basicAuthHeader(integracaoA.clientId, integracaoA.clientSecret))
      .send({ purpose: 'Preenchimento dos dados de entrega', redirectUri: REDIRECT_URI });

    expect(resp.status).toBe(201);
    expect(resp.body.requestId).toBeTruthy();
    expect(resp.body.authorizationUrl).toContain(resp.body.requestId);
  });

  it('rejeita credenciais de integração inválidas', async () => {
    const resp = await request(app)
      .post('/integrations/authorization-requests')
      .set('Authorization', basicAuthHeader(integracaoA.clientId, 'secret-errado'))
      .send({ redirectUri: REDIRECT_URI });
    expect(resp.status).toBe(401);
  });

  it('rejeita redirectUri não cadastrada na integração (anti open-redirect)', async () => {
    const resp = await request(app)
      .post('/integrations/authorization-requests')
      .set('Authorization', basicAuthHeader(integracaoA.clientId, integracaoA.clientSecret))
      .send({ redirectUri: 'https://dominio-nao-cadastrado.example.com/callback' });
    expect(resp.status).toBe(400);
  });

  it('rejeita campo que a empresa não configurou (CPF fora do permitido)', async () => {
    const resp = await request(app)
      .post('/integrations/authorization-requests')
      .set('Authorization', basicAuthHeader(integracaoA.clientId, integracaoA.clientSecret))
      .send({ redirectUri: REDIRECT_URI, requestedFields: ['NOME', 'CPF'] });
    expect(resp.status).toBe(400);
  });

  it('exige X-USER-ID para ver/decidir a solicitação', async () => {
    const criar = await request(app)
      .post('/integrations/authorization-requests')
      .set('Authorization', basicAuthHeader(integracaoA.clientId, integracaoA.clientSecret))
      .send({ redirectUri: REDIRECT_URI });

    const semAuth = await request(app).get(`/integrations/authorize/${criar.body.requestId}`);
    expect(semAuth.status).toBe(401);
  });

  it('fluxo completo: cria -> consulta -> aprova -> troca -> só os campos pedidos voltam (nunca CPF/RG)', async () => {
    const criar = await request(app)
      .post('/integrations/authorization-requests')
      .set('Authorization', basicAuthHeader(integracaoA.clientId, integracaoA.clientSecret))
      .send({ purpose: 'Preenchimento dos dados de entrega', redirectUri: REDIRECT_URI });
    const requestId = criar.body.requestId;

    const consulta = await request(app).get(`/integrations/authorize/${requestId}`).set('X-USER-ID', userId);
    expect(consulta.status).toBe(200);
    expect(consulta.body.empresa).toBe('Pizzaria Balotelli de Teste');
    expect([...consulta.body.camposPedidos].sort()).toEqual(['ENDERECO', 'NOME', 'TELEFONE']);
    expect(consulta.body.camposPedidos).not.toContain('CPF');
    expect(consulta.body.camposPedidos).not.toContain('RG');

    const aprovar = await request(app)
      .post(`/integrations/authorize/${requestId}`)
      .set('X-USER-ID', userId)
      .send({ aprovar: true });
    expect(aprovar.status).toBe(200);
    expect(aprovar.body.status).toBe('APROVADA');
    expect(aprovar.body.code).toBeTruthy();
    // O navegador NUNCA recebe os dados — só o code.
    expect(aprovar.body).not.toHaveProperty('dados');
    expect(aprovar.body).not.toHaveProperty('data');
    const code = aprovar.body.code as string;

    const trocar = await request(app)
      .post('/integrations/token')
      .set('Authorization', basicAuthHeader(integracaoA.clientId, integracaoA.clientSecret))
      .send({ code, redirectUri: REDIRECT_URI });
    expect(trocar.status).toBe(200);
    expect(trocar.body.data.nome).toBe('Cliente de Teste');
    expect(trocar.body.data.telefone).toBeTruthy();
    expect(trocar.body.data.endereco).toBeTruthy();
    expect(trocar.body.data).not.toHaveProperty('cpf');
    expect(trocar.body.data).not.toHaveProperty('rg');

    // Replay: o mesmo code não pode ser trocado de novo.
    const reuso = await request(app)
      .post('/integrations/token')
      .set('Authorization', basicAuthHeader(integracaoA.clientId, integracaoA.clientSecret))
      .send({ code, redirectUri: REDIRECT_URI });
    expect(reuso.status).toBe(400);
    expect(reuso.body.error).toMatch(/já utilizado/i);
  });

  it('nega: nenhum code é emitido e a solicitação não pode ser reaberta', async () => {
    const criar = await request(app)
      .post('/integrations/authorization-requests')
      .set('Authorization', basicAuthHeader(integracaoA.clientId, integracaoA.clientSecret))
      .send({ redirectUri: REDIRECT_URI });
    const requestId = criar.body.requestId;

    await request(app).get(`/integrations/authorize/${requestId}`).set('X-USER-ID', userId);

    const negar = await request(app)
      .post(`/integrations/authorize/${requestId}`)
      .set('X-USER-ID', userId)
      .send({ aprovar: false });
    expect(negar.status).toBe(200);
    expect(negar.body.status).toBe('NEGADA');
    expect(negar.body.code).toBeUndefined();

    const tentarDeNovo = await request(app)
      .post(`/integrations/authorize/${requestId}`)
      .set('X-USER-ID', userId)
      .send({ aprovar: true });
    expect(tentarDeNovo.status).toBe(409);
  });

  it('código expirado não pode ser trocado', async () => {
    const criar = await request(app)
      .post('/integrations/authorization-requests')
      .set('Authorization', basicAuthHeader(integracaoA.clientId, integracaoA.clientSecret))
      .send({ redirectUri: REDIRECT_URI });
    const requestId = criar.body.requestId;
    await request(app).get(`/integrations/authorize/${requestId}`).set('X-USER-ID', userId);
    const aprovar = await request(app)
      .post(`/integrations/authorize/${requestId}`)
      .set('X-USER-ID', userId)
      .send({ aprovar: true });
    const code = aprovar.body.code as string;

    // Simula os 2 minutos de validade já tendo passado.
    await prisma.autorizacaoCodigo.updateMany({
      where: { solicitacaoId: requestId },
      data: { expiraEm: new Date(Date.now() - 1000) },
    });

    const trocar = await request(app)
      .post('/integrations/token')
      .set('Authorization', basicAuthHeader(integracaoA.clientId, integracaoA.clientSecret))
      .send({ code, redirectUri: REDIRECT_URI });
    expect(trocar.status).toBe(400);
    expect(trocar.body.error).toMatch(/expirado/i);
  });

  it('solicitação expirada não pode mais ser vista como pendente nem aprovada', async () => {
    const criar = await request(app)
      .post('/integrations/authorization-requests')
      .set('Authorization', basicAuthHeader(integracaoA.clientId, integracaoA.clientSecret))
      .send({ redirectUri: REDIRECT_URI });
    const requestId = criar.body.requestId;

    await prisma.solicitacaoCompartilhamento.update({
      where: { id: requestId },
      data: { expiraEm: new Date(Date.now() - 1000) },
    });

    const consulta = await request(app).get(`/integrations/authorize/${requestId}`).set('X-USER-ID', userId);
    expect(consulta.status).toBe(200);
    expect(consulta.body.status).toBe('EXPIRADA');

    const aprovar = await request(app)
      .post(`/integrations/authorize/${requestId}`)
      .set('X-USER-ID', userId)
      .send({ aprovar: true });
    expect(aprovar.status).toBe(409);
  });

  it('isolamento multi-tenant: a integração de outra empresa não troca um code que não é dela', async () => {
    const cadastroB = await request(app)
      .post('/companies')
      .send({
        nome: 'Concorrente de Teste',
        cnpj: proximoDocumento(14),
        categoria: 'RESTAURANTE',
        emailContato: `concorrente.teste.${Date.now()}@example.com`,
        senha: 'senha123',
      });
    const integracaoBResp = await request(app)
      .post('/companies/me/integracoes')
      .set('X-COMPANY-ID', cadastroB.body.id)
      .send({ nome: 'Sistema B', redirectUris: ['https://outro-cardapio.example.com/callback'] });

    const criar = await request(app)
      .post('/integrations/authorization-requests')
      .set('Authorization', basicAuthHeader(integracaoA.clientId, integracaoA.clientSecret))
      .send({ redirectUri: REDIRECT_URI });
    const requestId = criar.body.requestId;
    await request(app).get(`/integrations/authorize/${requestId}`).set('X-USER-ID', userId);
    const aprovar = await request(app)
      .post(`/integrations/authorize/${requestId}`)
      .set('X-USER-ID', userId)
      .send({ aprovar: true });
    const code = aprovar.body.code as string;

    const trocaCruzada = await request(app)
      .post('/integrations/token')
      .set('Authorization', basicAuthHeader(integracaoBResp.body.clientId, integracaoBResp.body.clientSecret))
      .send({ code, redirectUri: REDIRECT_URI });
    expect(trocaCruzada.status).toBe(403);
  });

  it('integração revogada não consegue mais criar solicitações (deixado por último — muda o estado de integracaoA)', async () => {
    const revogar = await request(app).delete(`/companies/me/integracoes/${integracaoA.id}`).set(panelHeaders);
    expect(revogar.status).toBe(204);

    const tentativa = await request(app)
      .post('/integrations/authorization-requests')
      .set('Authorization', basicAuthHeader(integracaoA.clientId, integracaoA.clientSecret))
      .send({ redirectUri: REDIRECT_URI });
    expect(tentativa.status).toBe(401);
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

  it('QR Code: leitura -> aprovação -> dados liberados direto pro app (sem passar por /integrations)', async () => {
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
