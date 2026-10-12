# Bun executa o TypeScript direto (sem bundle): `bun build --compile` quebra o Reflector do NestJS.
FROM oven/bun:1.4.2-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
# tsconfig.json é necessário em runtime: o Bun lê dele as flags de decorators do NestJS.
COPY package.json tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
USER bun
EXPOSE 3000
# Forma exec: o SIGTERM do `docker stop` chega direto ao processo do Bun (PID 1).
ENTRYPOINT ["bun", "src/main.ts"]
