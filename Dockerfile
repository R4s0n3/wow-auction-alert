# Server für Coolify (Build Pack: Dockerfile). Bun führt TypeScript direkt aus,
# einen Build-Schritt gibt es nicht.
FROM oven/bun:1.3.14-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY knowledge ./knowledge
COPY src ./src

# SQLite liegt hier, in Coolify als Persistent Storage (Volume) einhängen.
# Als normaler Nutzer statt root, das Verzeichnis gehört ihm schon im Image,
# damit ein neues Volume die Rechte übernimmt.
RUN mkdir -p /app/data && chown -R bun:bun /app/data
USER bun
VOLUME /app/data

ENV PORT=3000 DB_PATH=/app/data/wahp.sqlite
EXPOSE 3000

# Coolify nimmt diesen Healthcheck statt seines eigenen (der bräuchte curl/wget im Image)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/health`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["bun", "src/index.ts"]
