FROM node:20-alpine AS build
WORKDIR /app
# Instala OpenSSL para a geração do Prisma Client no build
RUN apk add --no-cache openssl
COPY package*.json ./
RUN npm install
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
COPY openapi.yaml ./
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# Instala OpenSSL no ambiente de execução do contêiner
RUN apk add --no-cache openssl
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/openapi.yaml ./openapi.yaml
COPY package*.json ./
COPY prisma ./prisma

EXPOSE 3000
# Migração do banco NÃO roda mais aqui — é o preDeployCommand do
# railway.json (npx prisma migrate deploy) que cuida disso antes do deploy
# trocar de versão. Isso evita que uma falha de conexão/timeout no boot do
# container derrube a API inteira (o "&&" antigo impedia o node de subir se
# a migração falhasse) e permite o healthcheck/restart policy do Railway
# agirem sobre o processo da aplicação de verdade.
CMD ["node", "dist/index.js"]