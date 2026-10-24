# Mara OS — imagen de ejecución
#
# El bot corre TypeScript directamente con tsx (no hay paso de build), así que
# la imagen instala dependencias una vez y copia el código.
#
# IMPORTANTE: no se define NODE_ENV=production a propósito. El código cambia la
# base de datos a /var/lib/mara/memory/mara.db cuando detecta producción; sin
# esa variable usa /app/data/mara.db, que es lo que se monta como volumen.
#
# Ejemplo:
#   docker build -t mara-os .
#   docker run -d --name mara-os \
#     --env-file .env \
#     -v "$PWD/config:/app/config" \
#     -v "$PWD/data:/app/data" \
#     -p 9001:9001 \
#     mara-os

# syntax=docker/dockerfile:1

# ---------- Dependencias ----------
FROM node:24-bookworm-slim AS deps

# Herramientas de compilación por si better-sqlite3 no trae binario precompilado
# para esta arquitectura/ABI. Solo viven en esta etapa.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@11.21.0

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---------- Runtime ----------
FROM node:24-bookworm-slim AS runtime

# ffmpeg: conversión de audio para TTS/STT (src/audio.ts).
# tini: reaping de procesos hijos MCP y señales correctas con docker stop.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json mcp.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node config ./config

# data/ es el volumen persistente: base de datos, outbox de Hindsight y caché
# de modelos. config/uploads también necesita escritura (fotos de Telegram).
RUN mkdir -p /app/data /app/config/uploads \
    && chown -R node:node /app/data /app/config

USER node

# Bridge WebSocket de Mara UI (MARA_BRAIN_WS_URL). No es un servidor HTTP.
EXPOSE 9001

VOLUME ["/app/data"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--env-file-if-exists=.env", "--import", "tsx", "src/bot.ts"]
