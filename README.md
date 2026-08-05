# FIXO PASS — Backend (Fase 1: Banco de Dados + Cadastros + API)

Stack: Node.js + TypeScript + Express + PostgreSQL + Prisma.

Cobre os itens **1 (banco), 2 (cadastro usuário), 3 (cadastro empresa), 4 (permissões) e 7 (API)** do seu roadmap de prioridades.

## O que já está implementado

- **Modelo de dados completo** (`prisma/schema.prisma`): usuários, empresas, unidades, campos solicitados por empresa, autorizações (permissões), solicitações de compartilhamento (eventos NFC/QR) e logs de acesso (auditoria).

- **Cadastro e login de usuário** — item 2:
  - `POST /users` — cadastro inicial (todos os campos da especificação).
  - `POST /users/login` — login MVP (retorna `userId` para usar no header `X-USER-ID`).
  - `GET /users/me` / `PUT /users/me` — ver e editar o próprio perfil.
  - `DELETE /users/me` — exclusão definitiva da própria conta (LGPD); remove em cascata autorizações, solicitações e logs de acesso.
  - `GET /users/me/autorizacoes` — tela "Empresas autorizadas" (empresa, dados liberados, data).
  - `DELETE /users/me/autorizacoes/:companyId` — revogar acesso de uma empresa (sem apagar a conta).
  - `PUT /users/me/push-token` — salva o Expo Push Token do dispositivo, usado para avisar o usuário quando o ERP cria uma solicitação sem ele estar com o app aberto.

- **Cadastro e configuração de empresa** — item 3:
  - `POST /companies` — cadastro no painel, retorna a **API Key em texto puro uma única vez** (para configurar no ERP).
  - `POST /companies/login` — login do painel (retorna `companyId` para `X-COMPANY-ID`; **diferente** da API Key do ERP).
  - `GET /companies/me` — dados da empresa, campos solicitados e unidades.
  - `PUT /companies/me/campos-solicitados` — configura quais dados a empresa pede (ex.: pizzaria x hospital).
  - `POST /companies/me/unidades` / `GET /companies/me/unidades` — cria/lista unidades, já gerando o `qrCodeToken` de cada uma.
  - `GET /companies/me/unidades/:id/qrcode` — imagem PNG do QR Code, pronta para imprimir/exibir no balcão.
  - `GET /companies/me/unidades/:id/qrcode-base64` — o mesmo QR, como data URL base64 dentro de JSON (para um painel em React embutir direto num `<img src="...">`).
  - `PUT /companies/me/webhook` — configura a URL que recebe os dados automaticamente quando um cliente aprova (item 8: integração ERP piloto).

- **Entrega dos dados pro ERP** (item 8 do roadmap):
  - **Webhook**: se a empresa configurar `webhookUrl`, o FIXO PASS faz um `POST` automático pra essa URL assim que o cliente aprova, com os dados liberados. Roda em segundo plano — se o ERP estiver fora do ar, não afeta a resposta que o app do usuário recebe.
  - **Polling** (`GET /auth/request/:id`): alternativa pra ERPs que não conseguem expor uma URL pública — consulta o status (`PENDENTE`/`APROVADA`/`NEGADA`) de uma solicitação específica, já com empresa/campos pedidos inclusos (o app usa isso pra abrir a tela de autorização direto ao tocar numa push notification).
  - **Push notification pro usuário**: quando é o fluxo ERP/terminal quem cria a solicitação (identificando o cliente por CPF, sem ele estar escaneando nada), o backend dispara automaticamente uma push notification via Expo Push API pro celular do usuário — senão ele não teria como saber que precisa aprovar.

- **API de compartilhamento** — item 7:
  - `POST /auth/request` — **dois fluxos possíveis**:
    - **App do usuário** (header `X-USER-ID`): o próprio usuário lê o QR Code (envia `qrCodeToken`) ou aproxima o NFC (envia `companyId`). Os `camposPedidos` são sempre os que a empresa configurou em `campos-solicitados` — o app não escolhe isso.
    - **ERP/painel da empresa** (header `X-API-KEY`): usado em terminais como recepção de hospital, onde é a empresa que digita o CPF/telefone do cliente.
  - `POST /customer/share` — usuário aprova/nega a solicitação no app; se aprovar, grava a autorização permanente e devolve somente os campos liberados.
  - `GET /customer/{id}` — empresa consulta os dados já autorizados de um cliente recorrente (sem precisar de novo NFC/QR).

- **Documentação Swagger/OpenAPI** em `openapi.yaml`, servida em `/docs`.
- **Segurança básica**: senhas e API Key sempre em hash (bcrypt), log de todo acesso, nunca envia campo que não esteja na lista autorizada.

### Duas credenciais diferentes para a empresa — atenção a isso

- **API Key** (`X-API-KEY`): usada pelo **ERP** da empresa para chamar `/auth/request` e `/customer/*`. Máquina-a-máquina.
- **Login do painel** (`X-COMPANY-ID`, via `/companies/login`): usado por uma **pessoa** logando no painel web para configurar campos e unidades.

## O que falta (próximos passos do seu roadmap)

- Trocar os headers `X-USER-ID` / `X-COMPANY-ID` por JWT real (hoje são simplificações de MVP para já poder testar a API).
- ~~Geração do QR Code~~ — feito (`GET /companies/me/unidades/:id/qrcode`). Falta a **leitura** (item 5/6): implementar o scanner de câmera no app mobile e a leitura de NFC.
- ~~Frontend do painel web da empresa~~ — feito, ver pasta `fixopass-painel-web`.
- ~~Entrega automática pro ERP~~ — feito (webhook + polling, item 8).
- ~~Push notification~~ — feito no backend (Expo Push API) e no app (`fixopass-app`). Falta só testar em dispositivo físico, já que push não funciona em emulador.
- Tela de logs/auditoria no painel (o backend já grava tudo em `LogAcesso`, falta só expor um `GET` e a tela).
- Rate limiting e rotação de API Key por empresa.
- Item 9 do roadmap (teste com empresas reais): falta decidir onde hospedar (backend + Postgres) para dar acesso a uma empresa piloto de verdade.

> **Atenção**: o schema mudou nesta versão (campo `webhookUrl` em `Company`, `expoPushToken` em `User`, e o valor `CONSULTA_API` adicionado ao enum `MetodoIdentificacao`). Se você já tinha rodado `prisma migrate dev` antes, rode de novo: `npx prisma migrate dev --name add_webhook_push_token_and_consulta_api`.

## Como rodar localmente

```bash
# 1. Instalar dependências
npm install

# 2. Configurar variáveis de ambiente
cp .env.example .env
# edite o DATABASE_URL se necessário

# 3. Subir um Postgres local (exemplo via Docker)
docker run --name fixopass-db -e POSTGRES_USER=fixopass -e POSTGRES_PASSWORD=fixopass -e POSTGRES_DB=fixopass -p 5432:5432 -d postgres:16

# 4. Rodar as migrations
npx prisma migrate dev --name init

# 5. Popular com dados de teste (opcional, já cadastra usuário e empresa de exemplo)
npx ts-node prisma/seed.ts

# 6. Subir a API
npm run dev
```

A API sobe em `http://localhost:3000` e a documentação interativa em `http://localhost:3000/docs`.

## Rodando com Docker (recomendado para deploy/piloto)

```bash
cp .env.example .env
docker compose up -d --build
```

Isso sobe a API **e** o Postgres juntos, aplicando as migrations automaticamente. Veja
[`CHECKLIST-PILOTO.md`](./CHECKLIST-PILOTO.md) antes de dar acesso a uma empresa real —
tem os bloqueadores de segurança que precisam ser resolvidos primeiro (autenticação real,
HTTPS, backup, rate limiting).

## Testando o fluxo completo (cadastro → autorização → compartilhamento)

1. Cadastrar um usuário:

```bash
curl -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -d '{
    "nomeCompleto": "Maria Silva",
    "telefone": "+55 19 99999-0000",
    "email": "maria@example.com",
    "cpf": "12345678900",
    "endereco": "Rua das Flores, 123 - Limeira/SP",
    "senha": "senha123"
  }'
```

2. Cadastrar uma empresa (guarde a `apiKey` retornada — só aparece uma vez):

```bash
curl -X POST http://localhost:3000/companies \
  -H "Content-Type: application/json" \
  -d '{
    "nome": "Bella Pizza",
    "cnpj": "00000000000191",
    "categoria": "RESTAURANTE",
    "emailContato": "contato@bellapizza.example.com",
    "senha": "senha123"
  }'
```

3. Logar no painel da empresa e criar uma unidade (gera o `qrCodeToken`):

```bash
curl -X POST http://localhost:3000/companies/login \
  -H "Content-Type: application/json" \
  -d '{ "emailContato": "contato@bellapizza.example.com", "senha": "senha123" }'

curl -X POST http://localhost:3000/companies/me/unidades \
  -H "Content-Type: application/json" \
  -H "X-COMPANY-ID: <companyId-retornado-no-login>" \
  -d '{ "nome": "Bella Pizza - Centro" }'
```

4. A solicitação pode ser criada de dois jeitos — escolha um:

**4a. Fluxo real do app (usuário escaneou o QR Code da unidade):**

```bash
curl -X POST http://localhost:3000/auth/request \
  -H "Content-Type: application/json" \
  -H "X-USER-ID: <userId-retornado-no-login-do-usuario>" \
  -d '{
    "metodo": "QRCODE",
    "qrCodeToken": "<qrCodeToken-retornado-no-passo-3>"
  }'
```

**4b. Fluxo ERP/terminal da empresa (ex.: recepção digitando o CPF):**

```bash
curl -X POST http://localhost:3000/auth/request \
  -H "Content-Type: application/json" \
  -H "X-API-KEY: <apiKey-retornada-no-cadastro-da-empresa>" \
  -d '{
    "identificador": { "cpf": "12345678900" },
    "metodo": "QRCODE"
  }'
```

Em ambos os casos, se a empresa já tiver configurado `campos-solicitados`, os `camposPedidos` são preenchidos automaticamente a partir dessa configuração.

5. O usuário aprova (no app, aqui simulado via curl com o `solicitacaoId` retornado):

```bash
curl -X POST http://localhost:3000/customer/share \
  -H "Content-Type: application/json" \
  -H "X-USER-ID: <userId-retornado-no-login-do-usuario>" \
  -d '{ "solicitacaoId": "<id-retornado-no-passo-4>", "aprovar": true }'
```

6. A empresa pode depois consultar diretamente (cliente recorrente):

```bash
curl http://localhost:3000/customer/<userId> \
  -H "X-API-KEY: <apiKey-da-empresa>"
```

## Changelog da auditoria de código

Correções aplicadas numa revisão completa do projeto:

- **Crítico**: `index.ts` tinha imports e registros de rota duplicados (`usersRouter`, `companiesRouter`) — quebraria a compilação TypeScript.
- **Segurança**: `POST /customer/share` aceitava `camposLiberados` sem checar se eram um subconjunto do que a empresa pediu — agora é sempre filtrado.
- **Robustez**: nenhuma rota tinha tratamento de erro — uma exceção do Prisma (ID malformado, violação de unicidade) travava a requisição sem resposta. Adicionado `asyncHandler` + middleware de erro global em todas as 20 rotas.
- **Autenticação**: `X-USER-ID`/`X-COMPANY-ID` eram aceitos sem verificar se o registro existe no banco — agora validam existência antes de seguir.
- **Integridade**: `unidadeId` era aceito em `/auth/request` sem checar se pertence à empresa correta — agora valida.
- **Auditoria**: `GET /customer/:id` gravava o log de acesso como `metodo: 'QRCODE'` mesmo sem nenhum evento de QR/NFC — adicionado `CONSULTA_API` ao enum.
- Removida pasta fantasma `{prisma,src` (resíduo de um comando de shell antigo).

## Estrutura de pastas

```
prisma/
  schema.prisma   → modelo do banco
  seed.ts         → dados de teste
src/
  index.ts        → servidor Express + Swagger
  lib/
    prisma.ts     → cliente Prisma
    apiKey.ts     → geração de API Key para o ERP
  middleware/
    companyAuth.ts      → valida API Key da empresa (ERP) — usado em GET /customer/:id
    companyPanelAuth.ts → valida sessão do painel web da empresa (MVP)
    userAuth.ts          → identifica o usuário logado no app (MVP)
    identifyActor.ts     → aceita X-USER-ID OU X-API-KEY em /auth/request (dois fluxos)
  routes/
    users.ts      → POST /users, /users/login, /users/me, /users/me/autorizacoes
    companies.ts  → POST /companies, /companies/login, /companies/me, campos-solicitados, unidades
    auth.ts       → POST /auth/request
    customer.ts   → POST /customer/share, GET /customer/:id
openapi.yaml      → documentação Swagger/OpenAPI
```
