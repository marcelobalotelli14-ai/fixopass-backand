# FIXO PASS — Checklist antes do piloto com empresa real (item 9 do roadmap)

Este projeto está funcionalmente completo no backend + painel web. Antes de dar acesso a uma
empresa de verdade — que vai lidar com CPF, RG e dados de saúde de clientes reais — feche
os pontos abaixo. Estão em ordem de prioridade.

## 🔴 Bloqueadores (não pilotar sem isso)

- [ ] **HTTPS obrigatório** em produção (a API não deve rodar em HTTP puro fora do localhost).
- [ ] **Trocar `X-USER-ID` / `X-COMPANY-ID` por autenticação real** (JWT assinado, expiração,
      refresh). Hoje qualquer um que souber um `userId` pode se passar por esse usuário.
- [ ] **Segredos fora do repositório**: `JWT_SECRET`, `DATABASE_URL` e credenciais do Postgres
      devem vir de variáveis de ambiente/secret manager, nunca commitados (o `.env.example`
      já existe pra isso — só falta o `.env` real nunca ir pro Git, que o `.gitignore` já cobre).
- [ ] **Backup automático do Postgres** (o banco tem CPF/RG/dados de saúde — perda de dados
      aqui não é só um bug, é um problema de compliance).
- [ ] **Rate limiting** em `/auth/request`, `/customer/share` e nos endpoints de login
      (hoje não existe — um script pode tentar CPFs em sequência). O canal WEB/API novo
      (`/oauth/*`) já nasceu com rate limiting (`express-rate-limit`) — falta
      estender o mesmo tratamento pras rotas mais antigas.

## 🟡 Importante antes de escalar além do primeiro piloto

- [ ] Rotação de API Key por empresa (hoje, se a empresa perder a key, não tem como gerar
      outra sem mexer direto no banco).
- [ ] Expor endpoint de leitura de `LogAcesso` + tela no painel (auditoria — já é gravado,
      só falta mostrar).
- [ ] Validação de CNPJ/CPF com dígito verificador (hoje só valida tamanho da string).
- [ ] Monitoramento básico: alerta se a API cair, alerta se `dispararWebhook` falhar
      repetidamente pra uma empresa.
- [ ] Termos de uso / política de privacidade — a essência do produto é LGPD na veia
      (consentimento explícito, revogável, com histórico). O código já reflete isso
      (nunca envia campo não autorizado, tudo logado, revogação disponível), mas falta
      o texto jurídico formal pro usuário aceitar no cadastro.

## 🟢 Pode esperar o piloto rodar um tempo

- [ ] Paginação nas listas do painel (unidades, campos).
- [ ] Internacionalização (se algum dia sair do Brasil).
- [ ] Testes automatizados (unitários/integração) — o canal WEB/API já tem cobertura
      (`src/__tests__/oauth.test.ts`, inclui uma regressão de
      `/auth/request` → `/customer/share`), mas os fluxos mais antigos (NFC/QR sem
      passar pelo canal WEB/API, painel de empresa, admin, PIX) ainda não têm testes
      próprios.

## Onde hospedar (sugestões, não é uma decisão técnica fechada)

Para um piloto com 1 empresa e poucas unidades, qualquer uma dessas resolve sem custo alto:

- **Railway** ou **Render**: sobem o `docker-compose.yml` (ou o Dockerfile direto) com
  Postgres gerenciado incluso, sem precisar mexer em servidor.
- **Fly.io**: bom se quiser manter tudo em containers e ter controle fino de região
  (importante se o piloto for numa cidade específica, por latência).
- **VPS simples (ex.: DigitalOcean, Hetzner) + Docker Compose**: mais barato, mas exige
  você mesmo cuidar de backup, HTTPS (Let's Encrypt/Caddy) e monitoramento.

## Como rodar em produção com Docker (depois dos bloqueadores acima resolvidos)

```bash
# 1. Configure o .env com os valores reais de produção
cp .env.example .env

# 2. Suba tudo (API + Postgres) com um único comando
docker compose up -d --build

# As migrations rodam automaticamente na subida do container da API.
```
