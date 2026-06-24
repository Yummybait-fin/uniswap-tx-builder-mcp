# uniswap-tx-builder MCP — PUBLIC, KEYLESS Model Context Protocol server.
#
# Build (context = this dir):
#   docker build -t uniswap-tx-builder-mcp:local .
# Run (stdio transport — -i keeps stdin open, --rm tears down on disconnect):
#   docker run -i --rm uniswap-tx-builder-mcp:local
#
# Holds no keys and never signs. Reads public RPCs by default; override per
# chain via RPC_* env vars (see src/config.ts).

FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=builder /app/dist ./dist

# stdio by default; set MCP_HTTP_PORT to serve streamable HTTP (e.g. as a
# docker-compose service a local agent connects to).
EXPOSE 8102
ENTRYPOINT ["node", "dist/mcp.js"]
