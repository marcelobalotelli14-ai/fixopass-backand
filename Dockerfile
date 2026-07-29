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
# Executa as migrações do banco antes de iniciar a aplicação
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]