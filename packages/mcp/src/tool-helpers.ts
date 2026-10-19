/**
 * Shared types and helpers for MCP tool definitions.
 */
import {
  type Booking,
  BookingPaymentStatus,
  BookingStatus,
  FerryApiError,
  type FerryClient,
  FerryError,
  type Location,
  type Order,
  OrderStatus,
  parseIssueTicketError,
  statusLabel,
} from '@ferryvn/sdk';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

/** Per-process guard for write tools: budget + audit trail. */
export interface WriteGuard {
  /** Throws `ToolInputError` once the budget is spent; call before every write. */
  reserve(tool: string): void;
  /** Record a write attempt (no passenger personal data). */
  audit(entry: { tool: string; ok: boolean; summary: Record<string, unknown> }): void;
  readonly remaining: number;
}

export interface ToolContext {
  sdk: FerryClient;
  mcp: McpServer;
  writes: WriteGuard;
  signal?: AbortSignal | undefined;
}

export interface FerryTool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  annotations: ToolAnnotations;
  /** Write tools are only registered when FERRY_MCP_ENABLE_WRITES=true. */
  write: boolean;
  handler: (ctx: ToolContext, args: z.infer<z.ZodObject<Shape>>) => Promise<Record<string, unknown>>;
}

/** Helper preserving the zod shape type for `handler` args. */
export function defineTool<Shape extends z.ZodRawShape>(tool: FerryTool<Shape>): FerryTool<Shape> {
  return tool;
}

/** Error the model can act on (bad input, ambiguous location, declined confirmation, ...). */
export class ToolInputError extends Error {}

/** Compact JSON text (pretty-printing wastes model tokens) + structured content. */
export function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

export function toolError(e: unknown): CallToolResult {
  let text: string;
  if (e instanceof FerryApiError) {
    const code = e.errorCode !== undefined ? `, errorCode ${e.errorCode}` : '';
    const fields = e.fieldErrors ? `\nfield errors: ${JSON.stringify(e.fieldErrors)}` : '';
    text = `Ferry API error (HTTP ${e.status}${code}): ${e.message}${fields}`;
    if (e.status === 401) text += '\nThe configured FERRY_API_KEY was rejected.';
    if (e.status === 403) {
      text += '\nAccess denied: the id may belong to another organization or not exist (FerryVN answers 403 for both).';
    }
    if (e.status === 429) text += '\nRate limited: wait before retrying; do not loop.';
    if (e.fieldErrors?.boatLayout === 'CanNotGetBoatVoyage') {
      text += "\nThe operator's live seat map is unavailable right now: retry later or offer another voyage.";
    }
    if (e.fieldErrors?.['voyage.id'] === 'CannotFindBoatLayoutFromVoyage') {
      text += '\nNo stored seat map yet: call get_seat_map for this voyage first, then retry.';
    }
    if (e.fieldErrors?.voyage === 'VoyageIsDisabled') {
      text += '\nThe operator disabled this voyage: it cannot be sold. Offer another voyage (search_voyages).';
    }
  } else if (e instanceof ToolInputError || e instanceof FerryError) {
    text = e.message;
  } else {
    text = `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
  }
  return { isError: true, content: [{ type: 'text', text }] };
}

/** Resolve a location by id, abbreviation or accent-insensitive name; errors list candidates. */
export async function resolveLocation(sdk: FerryClient, query: string, label: string): Promise<Location> {
  const matches = await sdk.locations.find(query);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new ToolInputError(`${label}: no location matches "${query}". Call search_locations to see valid names.`);
  }
  const list = matches.map((l) => `${l.location_name} (id ${l.id})`).join('; ');
  throw new ToolInputError(`${label}: "${query}" matches several locations — pass one id: ${list}`);
}

export function summarizeOrder(o: Order | null | undefined) {
  if (!o) return null;
  const v = o.voyage;
  return {
    order_id: o.id,
    status: statusLabel(OrderStatus, o.order_status),
    voyage_id: o.voyage_id,
    route: v?.route ? `${v.route.departure_name} → ${v.route.destination_name}` : undefined,
    departure: v ? `${v.departure_date?.slice(0, 10)} ${v.depart_time?.slice(0, 5) ?? ''}`.trim() : undefined,
    boat: v?.boat_name,
    total_price_vnd: o.total_price,
    ...(o.total_harbor_fee ? { harbor_fee_vnd: o.total_harbor_fee } : {}),
    issue_ticket_error: parseIssueTicketError(o.issue_ticket_error),
    tickets: (o.tickets ?? []).map((t) => ({
      name: t.name,
      seat_name: t.seat_name,
      position_id: t.position_id,
      ticket_type_id: t.ticket_type_id,
      ticket_status: t.ticket_status,
      is_cancelled: t.is_cancelled ?? false,
    })),
  };
}

/** One line per booking for lists: no passenger data. */
export function summarizeBookingBrief(b: Booking) {
  const leg = (o: Order | null | undefined) =>
    o?.voyage
      ? `${o.voyage.route?.departure_name ?? ''} → ${o.voyage.route?.destination_name ?? ''} ${o.voyage.departure_date?.slice(0, 10)} ${o.voyage.depart_time?.slice(0, 5) ?? ''}`.trim()
      : (o?.voyage_id ?? undefined);
  const error = parseIssueTicketError(b.depart_order?.issue_ticket_error ?? b.return_order?.issue_ticket_error);
  return {
    booking_id: b.id,
    booking_status: statusLabel(BookingStatus, b.booking_status),
    payment_status: statusLabel(BookingPaymentStatus, b.payment_status),
    created_at: b.createdAt,
    orderer: b.orderer_name,
    no_tickets: b.no_tickets,
    total_price_vnd: b.total_price,
    depart: leg(b.depart_order),
    ...(b.return_order ? { return: leg(b.return_order) } : {}),
    ...(error ? { issue_ticket_error: error } : {}),
  };
}

export function summarizeBooking(b: Booking) {
  return {
    booking_id: b.id,
    booking_status: statusLabel(BookingStatus, b.booking_status),
    payment_status: statusLabel(BookingPaymentStatus, b.payment_status),
    created_at: b.createdAt,
    payment_expired_at: b.payment_expired_at,
    customer_id: b.customer_id,
    orderer: { name: b.orderer_name, email: b.contact_email, phone: b.phone_number },
    no_tickets: b.no_tickets,
    total_price_vnd: b.total_price,
    depart_order: summarizeOrder(b.depart_order),
    return_order: summarizeOrder(b.return_order),
  };
}

/**
 * Ask the human to confirm a write. Uses MCP form elicitation when the client
 * supports it (a real confirmation dialog the model cannot answer for the user);
 * otherwise requires the model to pass `user_confirmed: true` after asking in chat.
 */
export async function confirmWrite(
  ctx: ToolContext,
  args: { user_confirmed?: boolean | undefined },
  message: string,
): Promise<'elicited' | 'flag'> {
  const caps = ctx.mcp.server.getClientCapabilities();
  if (caps?.elicitation?.form) {
    const res = await ctx.mcp.server.elicitInput(
      {
        message,
        requestedSchema: {
          type: 'object',
          properties: {
            confirm: { type: 'boolean', title: 'Confirm', description: 'Check to perform this action' },
          },
          required: ['confirm'],
        },
      },
      { signal: ctx.signal },
    );
    if (res.action !== 'accept' || res.content?.confirm !== true) {
      throw new ToolInputError('The user did not confirm. Nothing was done.');
    }
    return 'elicited';
  }
  if (args.user_confirmed !== true) {
    throw new ToolInputError(
      `Confirmation required. Show the user exactly this and ask for an explicit yes, then call again with user_confirmed=true:\n${message}`,
    );
  }
  return 'flag';
}

/** Default write guard: `maxWrites` per process, audit lines to `sink` (stderr by default). */
export function createWriteGuard(maxWrites: number, sink: (line: string) => void): WriteGuard {
  let used = 0;
  return {
    reserve(tool: string) {
      if (used >= maxWrites) {
        throw new ToolInputError(
          `Write budget exhausted (${maxWrites} write calls per server process, FERRY_MCP_MAX_WRITES). ${tool} was not executed; ask the user to continue in the FerryVN dashboard or restart the server.`,
        );
      }
      used++;
    },
    audit(entry) {
      const line = JSON.stringify({ ts: new Date().toISOString(), audit: 'ferry-mcp-write', ...entry });
      try {
        sink(line);
      } catch (e) {
        // An unwritable audit file must never turn a completed write into a reported failure
        // (the model would retry and create duplicates); keep the line on stderr instead.
        process.stderr.write(`[ferry-mcp] audit sink failed (${(e as Error).message}): ${line}\n`);
      }
    },
    get remaining() {
      return Math.max(0, maxWrites - used);
    },
  };
}
