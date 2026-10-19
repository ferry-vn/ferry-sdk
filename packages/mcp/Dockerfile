# syntax=docker/dockerfile:1
# FerryVN MCP server over Streamable HTTP.
#   docker build -f packages/mcp/Dockerfile -t ferryvn-mcp .
#   docker run -p 3333:3333 -e FERRY_API_KEY=... -e FERRY_MCP_HTTP_TOKEN=$(openssl rand -hex 24) ferryvn-mcp
# The server binds 0.0.0.0 inside the container, so FERRY_MCP_HTTP_TOKEN is mandatory
# (it refuses to start without one). Put it behind TLS in production.

FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp/package.json packages/mcp/
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build -w @ferryvn/sdk && npm run build -w @ferryvn/mcp \
  && npx esbuild packages/mcp/dist/index.js --bundle --platform=node --format=cjs --target=node22 \
       --legal-comments=linked --metafile=/tmp/meta.json --outfile=/out/ferry-mcp.cjs \
  && node scripts/third-party-notices.mjs /tmp/meta.json /out/THIRD_PARTY_NOTICES.txt

FROM node:24-alpine
ENV NODE_ENV=production \
    FERRY_MCP_HTTP_HOST=0.0.0.0
WORKDIR /app
COPY --from=build /out/ /app/
COPY LICENSE NOTICE /app/
USER node
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3333/healthz || exit 1
ENTRYPOINT ["node", "/app/ferry-mcp.cjs", "--http", "--port", "3333"]
