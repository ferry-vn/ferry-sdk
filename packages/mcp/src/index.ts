#!/usr/bin/env node
/**
 * `ferry-mcp` — FerryVN MCP server.
 *
 *   ferry-mcp                       stdio transport (Claude Desktop / Claude Code)
 *   ferry-mcp --http [--port 3333]  Streamable HTTP, stateless, 127.0.0.1 by default
 *
 * Env: FERRY_API_KEY, FERRY_BASE_URL | FERRY_ENV=production|uat, FERRY_LANG, FERRY_TIMEOUT_MS,
 *      FERRY_MCP_ENABLE_WRITES=true (opt-in write tools), FERRY_MCP_MAX_WRITES (default 20),
 *      FERRY_MCP_AUDIT_FILE (append write audit lines to a file), FERRY_MCP_DISABLED_TOOLS,
 *      FERRY_MCP_HTTP_HOST, FERRY_MCP_HTTP_TOKEN, FERRY_MCP_HTTP_ALLOW_WRITES,
 *      FERRY_MCP_ALLOWED_HOSTS, FERRY_MCP_ALLOWED_ORIGINS.
 * Logs go to stderr only — stdout is the JSON-RPC channel in stdio mode.
 */
import fs from 'node:fs';
import { FerryClient } from '@ferryvn/sdk';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createFerryHttpServer } from './http-server.js';
import { configFromEnv, createFerryMcpServer, selectTools, writesFor } from './server.js';
import { createWriteGuard } from './tool-helpers.js';
import { MCP_SERVER_VERSION } from './version.js';

const log = (msg: string) => process.stderr.write(`[ferry-mcp] ${msg}\n`);

const HELP = `ferry-mcp ${MCP_SERVER_VERSION} — FerryVN MCP server

Usage: ferry-mcp [--http] [--port <n>] [--version]

Environment:
  FERRY_API_KEY                partner API key (required except for locations/routes)
  FERRY_ENV                    production (default) | uat
  FERRY_BASE_URL               explicit API origin, e.g. http://localhost:3000
  FERRY_MCP_ENABLE_WRITES      "true" to expose create_customer / create_booking / request_cancellation
  FERRY_MCP_MAX_WRITES         write calls allowed per process (default 20)
  FERRY_MCP_AUDIT_FILE         also append write audit lines (JSON) to this file
  FERRY_MCP_DISABLED_TOOLS     tools to leave out (comma-separated names, e.g. list_bookings)
  FERRY_MCP_HTTP_HOST          --http bind address (default 127.0.0.1)
  FERRY_MCP_HTTP_TOKEN         bearer token for --http (mandatory unless only loopback can reach it)
  FERRY_MCP_HTTP_ALLOW_WRITES  "true" to also serve write tools over --http (no confirmation dialog there)
  FERRY_MCP_ALLOWED_HOSTS      extra accepted Host headers for --http (comma-separated host:port)
  FERRY_MCP_ALLOWED_ORIGINS    accepted browser Origins for --http (comma-separated)
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${MCP_SERVER_VERSION}\n`);
    return;
  }
  const cfg = configFromEnv();
  cfg.warnings.forEach(log);
  const client = new FerryClient(cfg.clientOptions);
  const auditFile = process.env.FERRY_MCP_AUDIT_FILE;
  const writes = createWriteGuard(cfg.maxWrites, (line) => {
    process.stderr.write(`${line}\n`);
    if (auditFile) fs.appendFileSync(auditFile, `${line}\n`, { mode: 0o600 });
  });
  const http = argv.includes('--http');
  const { enableWrites, warning } = writesFor(cfg, http ? 'http' : 'stdio');
  if (warning) log(warning);
  const serverConfig = { client, enableWrites, writes, disabledTools: cfg.disabledTools };
  const tools = selectTools(enableWrites, cfg.disabledTools).map((t) => t.name);
  log(
    `v${MCP_SERVER_VERSION}; endpoint ${client.baseUrl}; writes ${enableWrites ? `ENABLED (max ${cfg.maxWrites})` : 'disabled'}; tools: ${tools.join(', ')}`,
  );

  if (!http) {
    await createFerryMcpServer(serverConfig).connect(new StdioServerTransport());
    return;
  }

  const i = argv.indexOf('--port');
  const port = i >= 0 ? Number(argv[i + 1]) : 3333;
  const server = createFerryHttpServer({
    host: cfg.http.host,
    port,
    token: cfg.http.token,
    allowedHosts: cfg.http.allowedHosts,
    allowedOrigins: cfg.http.allowedOrigins,
    createMcpServer: () => createFerryMcpServer(serverConfig),
    log,
  });
  server.listen(port, cfg.http.host, () =>
    log(
      `Streamable HTTP listening on http://${cfg.http.host}:${port}/mcp${cfg.http.token ? ' (bearer token required)' : ''}`,
    ),
  );
}

main().catch((e: unknown) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
