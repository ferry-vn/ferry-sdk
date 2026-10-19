/**
 * FerryVN MCP server factory.
 *
 * `createFerryMcpServer` registers the read-only tools always and the write
 * tools only when `enableWrites` is true (env FERRY_MCP_ENABLE_WRITES=true),
 * minus any `disabledTools`, plus two prompts and a locations resource.
 */
import {
  FERRY_ENVIRONMENTS,
  type FerryClient,
  type FerryClientOptions,
  type FerryEnvironment,
  SDK_VERSION,
} from '@ferryvn/sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { READ_TOOLS } from './read-tools.js';
import { createWriteGuard, type FerryTool, ok, type ToolContext, toolError, type WriteGuard } from './tool-helpers.js';
import { MCP_SERVER_VERSION } from './version.js';
import { WRITE_TOOLS } from './write-tools.js';

export { MCP_SERVER_VERSION };

export interface FerryMcpConfig {
  client: FerryClient;
  enableWrites: boolean;
  /** Shared across servers of one process (HTTP mode creates one server per request). */
  writes?: WriteGuard | undefined;
  /** Tool names to leave out (FERRY_MCP_DISABLED_TOOLS). */
  disabledTools?: readonly string[] | undefined;
}

export const SERVER_INSTRUCTIONS = `FerryVN ferry-ticket platform (Vietnam high-speed ferries to Phú Quốc, Côn Đảo, Nam Du, Lý Sơn, Cát Bà…).
Typical flow: search_locations → search_voyages (get_route_prices for a price table) (date YYYY-MM-DD, Vietnam time; get_voyage_calendar for other days) → get_seat_map (live seats, prices, harbor fee, ticket-type rules) → find_customers → quote_booking (validates passengers and prices the booking, no write) → create_booking (if enabled) → get_booking.
Prices are VND. Voyage data is pre-synced, not real-time; seats are not held until tickets are issued.
Write tools (create_customer, create_booking, request_cancellation) exist only when the operator enabled them; always show the user exactly what will happen and get an explicit yes first. Payment, top-ups and ticket issuance are intentionally NOT available here; the only money effect is the cancellation fee request_cancellation may hold.
Booking data contains personal information (names, ID numbers, phones): only share it with the person it belongs to or who manages it.`;

const ALL_TOOL_NAMES = [...READ_TOOLS, ...WRITE_TOOLS].map((t) => t.name);

/** Tools that will be exposed for a given configuration. */
export function selectTools(enableWrites: boolean, disabledTools: readonly string[] = []): FerryTool[] {
  const tools = [...READ_TOOLS, ...(enableWrites ? WRITE_TOOLS : [])] as unknown as FerryTool[];
  return tools.filter((t) => !disabledTools.includes(t.name));
}

/**
 * Whether write tools are served in a transport mode. Over HTTP the server is
 * stateless, so the client's confirmation dialog (elicitation) is unavailable and
 * a write is confirmed only by the model's `user_confirmed` flag; HTTP writes
 * therefore need a second opt-in (FERRY_MCP_HTTP_ALLOW_WRITES=true).
 */
export function writesFor(cfg: Pick<McpEnvConfig, 'enableWrites' | 'http'>, mode: 'stdio' | 'http') {
  if (mode === 'http' && cfg.enableWrites && !cfg.http.allowWrites) {
    return {
      enableWrites: false,
      warning:
        'write tools are disabled over --http (no confirmation dialog in stateless HTTP); set FERRY_MCP_HTTP_ALLOW_WRITES=true to serve them anyway',
    };
  }
  return { enableWrites: cfg.enableWrites, warning: undefined };
}

/** Run one tool handler with error mapping (exported for tests). */
export async function callTool(tool: FerryTool, ctx: ToolContext, args: unknown) {
  try {
    return ok(await tool.handler(ctx, args as never));
  } catch (e) {
    return toolError(e);
  }
}

export function createFerryMcpServer(config: FerryMcpConfig): McpServer {
  const server = new McpServer(
    { name: 'ferryvn', title: 'FerryVN', version: MCP_SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const writes = config.writes ?? createWriteGuard(20, (line) => process.stderr.write(`${line}\n`));

  for (const tool of selectTools(config.enableWrites, config.disabledTools)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // Strict: a misspelt optional field (e.g. a nationality) is an error, never silently dropped.
        inputSchema: z.strictObject(tool.inputSchema),
        annotations: tool.annotations,
      },
      // The MCP SDK validates args against inputSchema before calling us.
      (args: unknown, extra: { signal?: AbortSignal }) =>
        callTool(tool, { sdk: config.client, mcp: server, writes, signal: extra?.signal }, args),
    );
  }

  server.registerPrompt(
    'plan_ferry_trip',
    {
      title: 'Plan a ferry trip',
      description: 'Find voyages, compare times and prices, and check seats for a trip.',
      argsSchema: {
        from: z.string().describe('Departure, e.g. "Rạch Giá"'),
        to: z.string().describe('Destination, e.g. "Phú Quốc"'),
        date: z.string().describe('Travel date YYYY-MM-DD'),
        passengers: z.string().optional().describe('Number and ages of passengers, e.g. "2 adults, 1 child (8)"'),
      },
    },
    ({ from, to, date, passengers }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Plan a ferry trip from ${from} to ${to} on ${date}${passengers ? ` for ${passengers}` : ''}. Use search_voyages (and get_voyage_calendar if that day is full), compare departure times, operators and starting prices, then check get_seat_map for the best 1–2 options and summarise seats, ticket types for the passengers' ages and the total in VND (quote_booking gives the exact total once passenger details are known). Do not create a booking unless I ask.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'check_booking',
    {
      title: 'Check a booking',
      description: 'Explain the status of a booking, its tickets and any disruptions.',
      argsSchema: { booking_id: z.string().describe('8-character booking id') },
    },
    ({ booking_id }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Check booking ${booking_id}: call get_booking and get_disruptions (booking_id ${booking_id}), then explain in plain language its status, payment deadline, voyages, passengers/seats, any delays or cancellations, and what (if anything) needs to happen next.`,
          },
        },
      ],
    }),
  );

  server.registerResource(
    'locations',
    'ferry://locations',
    {
      title: 'FerryVN locations',
      description: 'All ports and islands with their ids and abbreviations',
      mimeType: 'application/json',
    },
    async (uri) => {
      const rows = await config.client.locations.list();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(rows.map((l) => ({ id: l.id, name: l.location_name, abbreviation: l.abbreviation }))),
          },
        ],
      };
    },
  );

  return server;
}

export interface McpEnvConfig {
  clientOptions: FerryClientOptions;
  enableWrites: boolean;
  maxWrites: number;
  disabledTools: string[];
  http: {
    host: string;
    /** FERRY_MCP_HTTP_ALLOW_WRITES=true: also serve write tools over --http (see `writesFor`). */
    allowWrites: boolean;
    token?: string | undefined;
    allowedHosts?: string[] | undefined;
    allowedOrigins?: string[] | undefined;
  };
  warnings: string[];
}

const list = (v: string | undefined) =>
  v
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Parse env vars into client options, write flag and HTTP settings. Throws on invalid values. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): McpEnvConfig {
  const warnings: string[] = [];
  const environment = env.FERRY_ENV || undefined;
  if (environment && !(environment in FERRY_ENVIRONMENTS)) {
    throw new Error(`FERRY_ENV must be one of ${Object.keys(FERRY_ENVIRONMENTS).join(', ')} (got "${environment}")`);
  }
  const timeoutMs = env.FERRY_TIMEOUT_MS ? Number(env.FERRY_TIMEOUT_MS) : undefined;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`FERRY_TIMEOUT_MS must be a positive number of milliseconds (got "${env.FERRY_TIMEOUT_MS}")`);
  }
  const maxWrites = env.FERRY_MCP_MAX_WRITES ? Number(env.FERRY_MCP_MAX_WRITES) : 20;
  if (!Number.isInteger(maxWrites) || maxWrites < 0) {
    throw new Error(`FERRY_MCP_MAX_WRITES must be a non-negative integer (got "${env.FERRY_MCP_MAX_WRITES}")`);
  }
  const disabledTools = list(env.FERRY_MCP_DISABLED_TOOLS) ?? [];
  const unknown = disabledTools.filter((t) => !ALL_TOOL_NAMES.includes(t));
  if (unknown.length) {
    throw new Error(
      `FERRY_MCP_DISABLED_TOOLS: unknown tool ${unknown.join(', ')} (tools: ${ALL_TOOL_NAMES.join(', ')})`,
    );
  }
  if (!env.FERRY_API_KEY) {
    warnings.push('FERRY_API_KEY is not set: only anonymous tools (search_locations, list_routes) will work.');
  }
  return {
    clientOptions: {
      apiKey: env.FERRY_API_KEY || undefined,
      baseUrl: env.FERRY_BASE_URL || undefined,
      environment: environment as FerryEnvironment | undefined,
      timeoutMs,
      language: env.FERRY_LANG || undefined,
      userAgent: `ferryvn-mcp/${MCP_SERVER_VERSION} (sdk ${SDK_VERSION})`,
    },
    // Exact opt-in string only; anything else keeps the server read-only.
    enableWrites: env.FERRY_MCP_ENABLE_WRITES === 'true',
    maxWrites,
    disabledTools,
    http: {
      host: env.FERRY_MCP_HTTP_HOST || '127.0.0.1',
      allowWrites: env.FERRY_MCP_HTTP_ALLOW_WRITES === 'true',
      token: env.FERRY_MCP_HTTP_TOKEN || undefined,
      allowedHosts: list(env.FERRY_MCP_ALLOWED_HOSTS),
      allowedOrigins: list(env.FERRY_MCP_ALLOWED_ORIGINS),
    },
    warnings,
  };
}

export { createFerryHttpServer, createHttpHandler, resolveHttpSecurity } from './http-server.js';
export type { FerryTool, ToolContext, WriteGuard };
export { createWriteGuard, READ_TOOLS, WRITE_TOOLS };
