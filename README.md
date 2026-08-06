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
  - `PUT /users/me/senha` — troca de senha exigindo a senha atual (diferente do fluxo de "esqueci a senha" por e-mail).
  - `POST /users/me/foto` — envia (ou substitui) a foto de perfil, mesmo padrão de upload de `POST /companies/me/logo`.
  - `GET /users/me/privacidade` / `PUT /users/me/privacidade` — controle de compartilhamento **por categoria de estabelecimento** (Restaurante, Condomínio, Hospital, Hotel, Loja, Outros, Geral): liga/desliga foto, nome, cpf, rg, dataNascimento, telefone e endereco por categoria. `email` fica de fora desse controle de propósito — continua regulado só pelo que a empresa pede + aprovação pontual. Aplicado em `POST /auth/request`: os `camposPedidos` da empresa passam por esse filtro (regra da categoria dela, senão a regra `GERAL`, senão sem filtro extra) antes da pessoa nem ver a tela de aprovação — nos dois fluxos (app do usuário lendo QR/NFC, ou ERP identificando por CPF/telefone).
  - `GET /users/me/autorizacoes` — tela "Empresas autorizadas" (companyId, empresa, dados liberados, data, `accessCount`/`lastAccessedAt` — contador de pareamentos). `companyId` vai junto pra tela conseguir montar o botão de revogar sem precisar de outra chamada.
  - `DELETE /users/me/autorizacoes/:companyId` — revogar acesso de uma empresa (sem apagar a conta).
  - `PUT /users/me/push-token` — salva o Expo Push Token do dispositivo, usado para avisar o usuário quando o ERP cria uma solicitação sem ele estar com o app aberto.

- **Cadastro e configuração de empresa** — item 3:
  - `POST /companies` — cadastro no painel, retorna a **API Key em texto puro uma única vez** (para configurar no ERP).
  - `POST /companies/login` — login do painel (retorna `companyId` para `X-COMPANY-ID`; **diferente** da API Key do ERP).
  - `GET /companies/me` / `PUT /companies/me` — ver e editar os dados cadastrais da empresa.
  - `DELETE /companies/me` — encerra a conta (**soft delete**: `ativa = false`). Diferente de `DELETE /users/me` (exclusão definitiva/LGPD), aqui nada é apagado — API Key e sessão do painel param de autenticar, as tags NFC/QR Code das unidades param de funcionar, login futuro é bloqueado, mas unidades/autorizações/solicitações e principalmente os logs de auditoria (`LogAcesso`) continuam no banco.
  - `PUT /companies/me/campos-solicitados` — configura quais dados a empresa pede (ex.: pizzaria x hospital).
  - `POST /companies/me/unidades` / `GET /companies/me/unidades` — cria/lista unidades, já gerando o `qrCodeToken` de cada uma.
  - `GET /companies/me/unidades/:id/qrcode` — imagem PNG do QR Code, pronta para imprimir/exibir no balcão.
  - `GET /companies/me/unidades/:id/qrcode-base64` — o mesmo QR, como data URL base64 dentro de JSON (para um painel em React embutir direto num `<img src="...">`).
  - `GET /companies/me/compartilhamentos` — histórico de compartilhamentos recebidos (LogAcesso) com os dados atuais do cliente já resolvidos pros campos liberados em cada evento, foto incluída quando FOTO estiver entre eles, e o contador de pareamentos (`accessCount`/`lastAccessedAt`) daquele cliente com a empresa. É a "tela do lojista" mostrando o que apareceu ao aproximar o NFC ou ler o QR Code.

- **Contador de pareamentos** — `Autorizacao.accessCount`/`lastAccessedAt`, incrementado a cada `POST /customer/share` aprovado (cliente lendo o QR/NFC de novo). *Não* incrementa em `GET /customer/:id` — isso é consulta direta do ERP pra um cliente já autorizado, não um evento de NFC/QR de verdade (mesmo critério que já separava os métodos em `LogAcesso`). Devolvido em `GET /users/me/autorizacoes`, na resposta de `POST /customer/share`, em `GET /customer/:id` e no payload do webhook.
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

### Trial de 15 dias, bloqueio automático e cobrança (`src/lib/assinatura.ts`)

- `Company.status` (`TRIAL` / `ACTIVE` / `EXPIRED` / `BLOCKED`) é uma dimensão **independente** de `Company.ativa` — `ativa` é "a empresa encerrou a própria conta" (soft delete, ver acima); `status` é "a mensalidade está em dia". As duas são checadas separadamente em `POST /auth/request`.
- **Cadastro** (`POST /companies`): toda empresa nova nasce com `status: 'TRIAL'` e `trialEndsAt = agora + 15 dias`. `GET /companies/me` e o retorno de `POST /companies` incluem `daysLeftInTrial` (calculado, não armazenado) e `precoMensalCentavos` (customizado pelo admin ou o padrão R$29,90).
- **Empresas que já existiam antes desta versão**: a migration `20260805210000_add_assinatura_empresa` deu a elas `trialEndsAt = data da migration + 15 dias` — **não** a partir da data de cadastro original. Decisão deliberada: aplicar o trial retroativo a partir do `createdAt` bloquearia sem aviso qualquer empresa com mais de 15 dias de conta assim que este deploy fosse ao ar. Assim, ninguém é bloqueado de surpresa — o relógio de todo mundo começa a contar a partir do deploy.
- **Bloqueio autônomo** (`verificarAssinatura()`, chamado em `POST /auth/request` — os dois fluxos, app do usuário e ERP): se a empresa está em `TRIAL` e `trialEndsAt` já passou, o status é automaticamente transicionado para `EXPIRED` (sem cron — calculado na hora, sob demanda). Empresas `EXPIRED` ou `BLOCKED` têm o pareamento recusado com **`402 Payment Required`** e a mensagem "Período de teste/mensalidade expirado. Efetue a renovação para continuar.". O mesmo vale para `ACTIVE` cujo `nextDueDate` já passou — vira `EXPIRED` também. Ciclo completo: `TRIAL` →(trialEndsAt vence)→ `EXPIRED` →(webhook de pagamento confirma)→ `ACTIVE` →(nextDueDate vence)→ `EXPIRED` → ...
  - **Importante**: só `POST /auth/request` é bloqueado. Login no painel (`companyPanelAuth`) e a API Key em geral (`companyAuth`) continuam funcionando mesmo `EXPIRED`/`BLOCKED` — a empresa precisa conseguir entrar no próprio painel pra ver o aviso e renovar. `GET /customer/:id` também não é afetado, pelo mesmo motivo que não incrementa o contador de pareamentos: não é um evento de NFC/QR de verdade.
- **Webhook genérico**: `POST /webhooks/payment` — corpo `{ companyId, ... }`, autenticado por segredo compartilhado no header `X-WEBHOOK-SECRET` (env var `PAYMENT_WEBHOOK_SECRET`). Em caso de sucesso, marca `status: 'ACTIVE'` e soma 30 dias a `nextDueDate`. Fica de pé como caminho manual/genérico (ex. Asaas, ou confirmação manual pelo admin) — não é verificação de assinatura oficial de gateway nenhum, só a proteção mínima de um segredo compartilhado.
- Sem `PAYMENT_WEBHOOK_SECRET` configurado no ambiente, a rota recusa tudo com `503` (fail closed) — nunca fica aberta por engano.

### Checkout PIX automático — integração real com Mercado Pago (`src/lib/mercadopago.ts`)

Fluxo de ponta a ponta, sem intervenção manual:

1. `POST /companies/me/pix` (empresa logada no painel) chama a API de Pagamentos do Mercado Pago de verdade (`POST /v1/payments`, `payment_method_id: 'pix'`, `external_reference: companyId`) e devolve o QR Code (`qrCodeBase64`) e o código "copia e cola" (`qrCode`) — a cobrança existe de verdade do lado do Mercado Pago, com 30 minutos de validade (`date_of_expiration`).
2. A empresa paga o PIX pelo app do banco dela, normalmente.
3. O Mercado Pago notifica `POST /webhooks/mercadopago` (`{ type: 'payment', data: { id } }` no corpo, ou `?topic=payment&id=...` no IPN legado). A rota **não confia em nada do corpo** — ela consulta o pagamento de verdade em `GET /v1/payments/:id` usando o `MERCADOPAGO_ACCESS_TOKEN` do próprio servidor antes de ativar qualquer coisa (é essa consulta, não a notificação em si, que decide `approved` ou não — segue a recomendação oficial do Mercado Pago de sempre reconsultar em vez de confiar no payload). Se `status === 'approved'`, marca `status: 'ACTIVE'` e soma 30 dias a `nextDueDate`.
4. Idempotente: `Company.ultimoPagamentoIdProcessado` guarda o id do último pagamento já aplicado, então reenvios da mesma notificação (comportamento normal do Mercado Pago) não somam 30 dias duas vezes.

Sem `MERCADOPAGO_ACCESS_TOKEN` configurado no ambiente, **as duas rotas recusam com `503`** (fail closed) — em vez de inventar um QR Code que ninguém conseguiria pagar de verdade. Pra ligar de verdade: gerar o Access Token de produção em https://www.mercadopago.com.br/developers/panel e configurar a env var no Railway (ver comentário completo em `.env.example` e `src/lib/mercadopago.ts`).

### Painel Super Admin (`src/routes/admin.ts`)

- Autenticado por segredo compartilhado no header `X-ADMIN-SECRET` (env var `ADMIN_SECRET`, checado em `src/middleware/isAdmin.ts`) — mesmo padrão MVP do resto do backend (sem JWT), mas com acesso de leitura/escrita a **todas** as empresas do sistema. Sem `ADMIN_SECRET` configurado, as rotas recusam tudo com `503` (fail closed).
- `GET /admin/companies` — lista todas as empresas (inclusive as encerradas) com status, `daysLeftInTrial`, `nextDueDate` e preço mensal.
- `PUT /admin/companies/:id` — editor único e opcional pra três coisas: `precoMensalCentavos` (preço customizado, `null` volta pro padrão), `diasExtras` (soma/subtrai dias de `trialEndsAt`; se o resultado cair no futuro e `status` não vier junto no mesmo PUT, o status volta pra `TRIAL` sozinho — é o que o botão "+15 Dias de Teste" espera, sem precisar de um segundo clique) e `status` (troca manual direta entre `ACTIVE`/`TRIAL`/`EXPIRED`/`BLOCKED`).
- `DELETE /admin/companies/:id` — **mesmo soft-delete de sempre** (`ativa:false` + `encerradaEm`), só que acionável pelo admin em nome de qualquer empresa. Decisão deliberada: manter consistente com o resto do sistema — nunca apaga unidades/logs/histórico de verdade de uma empresa, mesmo via admin.
- `GET /admin/dashboard-stats` — métricas globais: total de empresas, ativas, em teste, inadimplentes (`EXPIRED`/`BLOCKED`), encerradas, faturamento estimado (soma do preço mensal das `ACTIVE`) e volume total de pareamentos.

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
