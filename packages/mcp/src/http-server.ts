/**
 * Streamable HTTP front-end for `ferry-mcp --http`.
 *
 * Security model (the MCP transport spec requires Origin validation):
 *  - DNS-rebinding protection: the `Host` header must be one of `allowedHosts`
 *    (defaults to the loopback names when bound to loopback) and a browser
 *    `Origin`, when present, must be one of `allowedOrigins`.
 *  - Optional bearer token (`FERRY_MCP_HTTP_TOKEN`), compared in constant time.
 *    It is mandatory when anything but loopback can reach the server: a
 *    non-loopback bind, or a non-loopback allowed Host (reverse proxy) or Origin.
 *  - POST only (stateless mode), JSON bodies up to `maxBodyBytes`.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface HttpServerOptions {
  host: string;
  port: number;
  /** Required bearer token; mandatory when `host` is not a loopback address. */
  token?: string | undefined;
  /** Extra accepted `Host` header values (`name:port`), on top of the loopback names for a loopback bind. */
  allowedHosts?: string[] | undefined;
  /** Extra accepted browser `Origin` values, on top of the loopback origins. */
  allowedOrigins?: string[] | undefined;
  maxBodyBytes?: number | undefined;
  createMcpServer: () => McpServer;
  log?: ((message: string) => void) | undefined;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
export const isLoopbackHost = (host: string): boolean => LOOPBACK.has(host) || host.startsWith('127.');

/** Host name of a `Host` header value (`name:port`, `[v6]:port`) or an Origin URL. */
function hostName(value: string): string {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return value;
  }
}

/** Validate options and compute the effective allow-lists. Throws on an unsafe configuration. */
export function resolveHttpSecurity(
  opts: Pick<HttpServerOptions, 'host' | 'port' | 'token' | 'allowedHosts' | 'allowedOrigins'>,
) {
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    throw new Error(`invalid port: ${opts.port}`);
  }
  const loopback = isLoopbackHost(opts.host);
  const extraHosts = opts.allowedHosts?.filter(Boolean) ?? [];
  const extraOrigins = opts.allowedOrigins?.filter(Boolean) ?? [];
  if (!opts.token) {
    // The server acts with the Ferry API key: anything reachable beyond loopback needs authentication.
    if (!loopback) {
      throw new Error(
        `refusing to listen on ${opts.host} without FERRY_MCP_HTTP_TOKEN: the server acts with your Ferry API key, so a non-loopback bind needs authentication`,
      );
    }
    const exposed = [...extraHosts, ...extraOrigins].filter((v) => !isLoopbackHost(hostName(v)));
    if (exposed.length) {
      throw new Error(
        `FERRY_MCP_HTTP_TOKEN is required when non-loopback hosts or origins are allowed (${exposed.join(', ')}): they reach the server through a proxy or a web page`,
      );
    }
  }
  if (opts.token !== undefined && opts.token.length < 16) {
    throw new Error('FERRY_MCP_HTTP_TOKEN must be at least 16 characters');
  }
  const names = ['127.0.0.1', 'localhost', '[::1]'];
  // Configured values extend the loopback defaults. A non-loopback bind without
  // explicit hosts accepts any Host (the bearer token is mandatory there).
  const loopbackHosts = loopback ? names.map((n) => `${n}:${opts.port}`) : [];
  const allowedHosts = loopback || extraHosts.length ? [...loopbackHosts, ...extraHosts] : undefined;
  const allowedOrigins = [...names.map((n) => `http://${n}:${opts.port}`), ...extraOrigins];
  return { allowedHosts, allowedOrigins, token: opts.token };
}

function digest(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

/** Constant-time bearer check. */
export function checkBearer(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!m?.[1]) return false;
  return timingSafeEqual(digest(m[1].trim()), digest(token));
}

function deny(res: ServerResponse, status: number, message: string, extraHeaders: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(Object.assign(new Error('payload too large'), { status: 413 }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** Build the request handler (exported for tests). */
export function createHttpHandler(opts: HttpServerOptions) {
  const sec = resolveHttpSecurity(opts);
  const maxBodyBytes = opts.maxBodyBytes ?? 1_000_000;
  const log = opts.log ?? (() => {});

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = new URL(req.url ?? '/', 'http://placeholder').pathname;
    if (pathname === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (pathname !== '/mcp') {
      deny(res, 404, 'not found');
      return;
    }
    const host = req.headers.host ?? '';
    if (sec.allowedHosts && !sec.allowedHosts.includes(host)) {
      log(`rejected Host "${host}"`);
      deny(res, 403, 'forbidden host');
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !sec.allowedOrigins.includes(origin)) {
      log(`rejected Origin "${origin}"`);
      deny(res, 403, 'forbidden origin');
      return;
    }
    if (sec.token && !checkBearer(req.headers.authorization, sec.token)) {
      deny(res, 401, 'missing or invalid bearer token', { 'www-authenticate': 'Bearer' });
      return;
    }
    if (req.method !== 'POST') {
      deny(res, 405, 'method not allowed (stateless server: POST only)', { allow: 'POST' });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req, maxBodyBytes);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 400;
      deny(res, status, (e as Error).message);
      return;
    }

    // Stateless mode: a fresh server + transport per request.
    const server = opts.createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log(`request failed: ${e instanceof Error ? e.message : String(e)}`);
      deny(res, 500, 'internal error');
    }
  };
}

/** Create (but do not start) the HTTP server. */
export function createFerryHttpServer(opts: HttpServerOptions): Server {
  const handler = createHttpHandler(opts);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  return server;
}
