/**
 * Write tools — registered ONLY when FERRY_MCP_ENABLE_WRITES=true.
 *
 * Scope is deliberately narrow:
 *  - create_customer       adds a customer record (needed as customer_id).
 *  - create_booking        creates a Requested/NotPaid booking. No money moves,
 *                          no seat is held, no ticket is issued.
 *  - request_cancellation  files a cancel request; the backend holds the
 *                          cancellation fee and routes it for approval.
 *
 * Never exposed (money-moving / admin): bookings/confirmToIssue (charges
 * balance + issues tickets), payments, transactions, withdrawals, top-ups,
 * balance/credit adjustments, debt ledgers, vouchers & price-addition CRUD,
 * organization / user / API-key / webhook settings.
 *
 * Every call needs a human confirmation (MCP elicitation dialog when the
 * client supports it, otherwise `user_confirmed: true` after asking in chat),
 * counts against FERRY_MCP_MAX_WRITES and is written to the audit log.
 */
import { z } from 'zod';
import { bookingInputShape, describeDraft, prepareDraft } from './booking-schemas.js';
import { confirmWrite, defineTool, summarizeBooking, summarizeOrder, ToolInputError } from './tool-helpers.js';

const userConfirmed = z
  .boolean()
  .optional()
  .describe(
    'Set to true only after the human explicitly confirmed this exact action in the conversation. Ignored when the client shows its own confirmation dialog.',
  );

const WRITE = { readOnlyHint: false, idempotentHint: false, openWorldHint: true } as const;

export const createCustomer = defineTool({
  name: 'create_customer',
  title: 'Create customer (write)',
  description:
    'Add a customer (khách hàng) to the organization — needed when find_customers finds nobody, because bookings reference a customer id. Ask the user for the details; confirm before calling.',
  inputSchema: {
    first_name: z.string().min(1).describe('Given name'),
    last_name: z.string().optional().describe('Family name'),
    phone: z.string().optional().describe('Mobile number, e.g. 0901234567'),
    email: z.string().email().optional(),
    user_confirmed: userConfirmed,
  },
  annotations: { ...WRITE, destructiveHint: false, title: 'Create customer (write)' },
  write: true,
  handler: async (ctx, args) => {
    const name = [args.last_name, args.first_name].filter(Boolean).join(' ');
    await confirmWrite(
      ctx,
      args,
      `Create customer "${name}"${args.phone ? `, phone ${args.phone}` : ''}${args.email ? `, ${args.email}` : ''}?`,
    );
    ctx.writes.reserve('create_customer');
    let c: Awaited<ReturnType<typeof ctx.sdk.customers.create>>;
    try {
      c = await ctx.sdk.customers.create({
        first_name: args.first_name,
        ...(args.last_name ? { last_name: args.last_name } : {}),
        ...(args.phone ? { phone: args.phone, phone_country_code: 'VN' } : {}),
        ...(args.email ? { email: args.email } : {}),
      } as Parameters<typeof ctx.sdk.customers.create>[0]);
    } catch (e) {
      ctx.writes.audit({ tool: 'create_customer', ok: false, summary: { error: (e as Error).message } });
      throw e;
    }
    ctx.writes.audit({ tool: 'create_customer', ok: true, summary: { customer_id: c.id } });
    return { created: true, customer_id: c.id, name };
  },
});

export const createBooking = defineTool({
  name: 'create_booking',
  title: 'Create booking (write)',
  description: [
    'Create a ferry booking (one outbound voyage and an optional return) for an existing customer (find_customers / create_customer).',
    'Give seats from get_seat_map (or omit them to auto-pick adjacent seats) and passenger details; ticket types are chosen from the passengers’ ages and nationality and prices are matched automatically. Everything is validated before anything is sent — call quote_booking first to check and price it without writing.',
    'Effect: the booking is created as Requested / NotPaid with a payment deadline. It does NOT charge money, hold seats or issue tickets — a human issues tickets in the FerryVN dashboard or CLI.',
    'Not idempotent: if the call errors or times out, check list_bookings before retrying.',
  ].join(' '),
  inputSchema: { ...bookingInputShape, user_confirmed: userConfirmed },
  annotations: { ...WRITE, destructiveHint: false, title: 'Create booking (write)' },
  write: true,
  handler: async (ctx, args) => {
    const { draft, passengers } = await prepareDraft(ctx.sdk, args);
    await confirmWrite(
      ctx,
      args,
      `Create booking for ${args.orderer_name} — ${describeDraft(draft)} No money is charged now.`,
    );
    ctx.writes.reserve('create_booking');
    let created: Awaited<ReturnType<typeof ctx.sdk.bookings.create>>;
    try {
      created = await ctx.sdk.bookings.create(draft.input);
    } catch (e) {
      ctx.writes.audit({ tool: 'create_booking', ok: false, summary: { error: (e as Error).message } });
      throw e;
    }
    ctx.writes.audit({
      tool: 'create_booking',
      ok: true,
      summary: {
        booking_id: created.id,
        voyages: [args.depart.voyage_id, args.return?.voyage_id].filter(Boolean),
        tickets: passengers.length,
      },
    });
    // The create response is not populated; fetch the full booking for the summary (best effort).
    const full = await ctx.sdk.bookings.get(created.id).catch(() => created);
    return {
      created: true,
      note: 'Booking is Requested/NotPaid. Payment and ticket issuance happen outside this assistant.',
      warnings: draft.warnings,
      booking: summarizeBooking(full),
    };
  },
});

export const requestCancellation = defineTool({
  name: 'request_cancellation',
  title: 'Request ticket cancellation (write)',
  description: [
    'File a cancellation request for some or all tickets of a Booked order (tickets identified by position_id, see get_booking).',
    'A cancellation service fee may be held immediately from the customer’s wallet (fails with errorCode 160105 when the wallet cannot cover it), the tickets are marked cancelled at once, and the request then needs approval up the organization chain; refunds follow approval. It cannot be undone through this assistant.',
  ].join(' '),
  inputSchema: {
    order_id: z.string().min(1).describe('order_id of the depart or return order (from get_booking)'),
    positions: z
      .array(z.union([z.string().min(1), z.number()]).transform((v) => String(v)))
      .min(1)
      .describe('position_id of each ticket to cancel'),
    reason: z.string().min(3).max(500).describe('Cancellation reason as stated by the user'),
    user_confirmed: userConfirmed,
  },
  annotations: { ...WRITE, destructiveHint: true, title: 'Request ticket cancellation (write)' },
  write: true,
  handler: async (ctx, args) => {
    // Show the human what they cancel (voyage + passengers), not just opaque ids.
    const order = await ctx.sdk.orders.get(args.order_id, { signal: ctx.signal });
    const tickets = order.tickets ?? [];
    const picked = args.positions.map((pos) => {
      const t = tickets.find((x) => String(x.position_id) === String(pos));
      if (!t) {
        const valid = tickets.filter((x) => !x.is_cancelled).map((x) => x.position_id);
        throw new ToolInputError(
          `Order ${args.order_id} has no ticket at position ${pos}. Valid positions: ${valid.join(', ') || 'none'} (see get_booking).`,
        );
      }
      if (t.is_cancelled) throw new ToolInputError(`The ticket at position ${pos} (${t.name}) is already cancelled.`);
      return t;
    });
    const leg = summarizeOrder(order);
    const what = picked.map((t) => `${t.name}${t.seat_name ? ` (seat ${t.seat_name})` : ''}`).join(', ');
    await confirmWrite(
      ctx,
      args,
      `Cancel ${picked.length} of ${tickets.length} ticket(s) of order ${args.order_id}${leg?.route ? ` — ${leg.route}` : ''}${leg?.departure ? `, ${leg.departure}` : ''}: ${what}? A cancellation fee may be held from the wallet immediately, the tickets are cancelled at once and this cannot be undone here.`,
    );
    ctx.writes.reserve('request_cancellation');
    let res: Awaited<ReturnType<typeof ctx.sdk.cancelTicketRequests.create>>;
    try {
      res = await ctx.sdk.cancelTicketRequests.create({
        order_id: args.order_id,
        cancel_ticket_by_positions: args.positions,
        cancel_reason: args.reason,
      });
    } catch (e) {
      ctx.writes.audit({
        tool: 'request_cancellation',
        ok: false,
        summary: { order_id: args.order_id, error: (e as Error).message },
      });
      throw e;
    }
    ctx.writes.audit({
      tool: 'request_cancellation',
      ok: true,
      summary: { cancel_request_id: res.id, order_id: res.order_id, positions: res.cancel_ticket_by_positions },
    });
    return {
      created: true,
      cancel_request_id: res.id,
      status: res.process_status,
      order_id: res.order_id,
      positions: res.cancel_ticket_by_positions,
    };
  },
});

export const WRITE_TOOLS = [createCustomer, createBooking, requestCancellation];
