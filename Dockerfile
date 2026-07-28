# FIXO PASS — Backend
# Build multi-stage: compila TypeScript e roda só o necessário em produção.

FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
COPY openapi.yaml ./
RUN npm run build

# ---------- Imagem final ----------
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Reaproveita o node_modules completo do build (inclui o CLI do Prisma,
# necessário para rodar "prisma migrate deploy" na inicialização do container).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/openapi.yaml ./openapi.yaml
COPY package*.json ./
COPY prisma ./prisma

EXPOSE 3000
CMD ["node", "dist/index.js"]
