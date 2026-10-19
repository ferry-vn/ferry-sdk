/**
 * Helpers for receiving FerryVN outbound webhooks.
 *
 * How the backend delivers them (verified in backend v3.2.16):
 *  - `POST <your webhook_url>` with `Content-Type: application/json` and
 *    `x-event-type: <event>`; 2 s timeout, redirects refused.
 *  - **Not signed** (no secret, signature or timestamp header) and delivered
 *    **at most once** (no retries, no event id). Protect your endpoint with an
 *    unguessable secret in the URL (compare it with `safeEqual`) and/or an IP
 *    allow-list, answer within 2 s, and reconcile with polling
 *    (`bookings.list`, `disruptions.list({ updatedSince })`) for missed events.
 *  - The body is the raw entity re-read at dispatch time (no envelope), except
 *    disruption events which use `{ event, organization_id, occurred_at, data }`.
 *  - Webhooks are configured per organization in the FerryVN dashboard
 *    (Settings → Integrations → Webhooks: URL, triggers, optional condition).
 */
import { FerryError } from './errors.js';
import type { Booking, CancelTicketRequest, Customer, Order, PublicDisruption, Voyage } from './types.js';

/** Event types that are actually delivered by webhook, grouped by payload shape. */
export const WEBHOOK_EVENTS = {
  booking: ['booking.created', 'booking.updated', 'booking.issuedTicket', 'booking.issuedTicketError'],
  order: [
    'order.issuedTicket',
    'order.childOrgIssuedTicket',
    'order.childOrgIssuedTicketError',
    'order.newManualIssueOrder',
    'order.canceled',
    'order.cancelTicket',
  ],
  cancelTicketRequest: [
    'cancel_ticket_request.created',
    'cancel_ticket_request.child_org_created',
    'cancel_ticket_request.accepted',
    'cancel_ticket_request.accepted_refunded',
    'cancel_ticket_request.refunded',
    'cancel_ticket_request.rejected',
    'cancel_ticket_request.recalled',
    'cancel_ticket_request.release_ticket',
  ],
  customer: ['customer.created', 'customer.updated', 'customer.deleted'],
  disruption: ['disruption.created', 'disruption.updated', 'disruption.closed'],
  voyage: ['voyage.created', 'voyage.updated', 'voyage.disabled'],
} as const;

type Values<T> = T[keyof T];
type EventsOf<K extends keyof typeof WEBHOOK_EVENTS> = (typeof WEBHOOK_EVENTS)[K][number];
export type KnownWebhookEventType = Values<{ [K in keyof typeof WEBHOOK_EVENTS]: EventsOf<K> }>;

export interface DisruptionWebhookPayload {
  event: EventsOf<'disruption'>;
  organization_id: string;
  /** ISO-8601 UTC. */
  occurred_at: string;
  data: PublicDisruption;
}

/** Order events carry the order plus its VAT invoice (null for most events). */
export interface OrderWebhookPayload {
  order: Order;
  vat_invoice: Record<string, unknown> | null;
}

export type FerryWebhookEvent =
  | { type: EventsOf<'booking'>; category: 'booking'; data: Booking }
  | { type: EventsOf<'order'>; category: 'order'; data: OrderWebhookPayload }
  | {
      type: EventsOf<'cancelTicketRequest'>;
      category: 'cancelTicketRequest';
      data: { cancel_ticket_request: CancelTicketRequest };
    }
  | { type: EventsOf<'customer'>; category: 'customer'; data: Customer }
  | { type: EventsOf<'disruption'>; category: 'disruption'; data: DisruptionWebhookPayload }
  | {
      type: EventsOf<'voyage'>;
      category: 'voyage';
      /** `voyage.updated` sends `{ id, data, oldData }`; the others send the voyage. */
      data: Voyage | { id: string; data: Partial<Voyage>; oldData: Partial<Voyage> };
    }
  | { type: string; category: 'other'; data: unknown };

type HeaderBag = Headers | Record<string, string | string[] | undefined>;

function header(headers: HeaderBag, name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const bag = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(bag).find((k) => k.toLowerCase() === name);
  const v = key === undefined ? undefined : bag[key];
  return Array.isArray(v) ? v[0] : v;
}

const CATEGORY_BY_EVENT = new Map<string, keyof typeof WEBHOOK_EVENTS>(
  (Object.keys(WEBHOOK_EVENTS) as Array<keyof typeof WEBHOOK_EVENTS>).flatMap((c) =>
    WEBHOOK_EVENTS[c].map((e) => [e, c] as const),
  ),
);

/**
 * Turn an incoming webhook request into a typed event.
 * `body` may be the raw string/Buffer-decoded text or the already-parsed JSON.
 *
 * @example
 *   app.post('/ferry/webhook/:secret', express.json(), (req, res) => {
 *     if (!safeEqual(req.params.secret, process.env.FERRY_WEBHOOK_SECRET!)) return res.sendStatus(404);
 *     res.sendStatus(204); // answer fast: the backend waits 2 s at most
 *     const event = parseWebhook({ headers: req.headers, body: req.body });
 *     if (event.category === 'booking') queue.push(event.data.id);
 *   });
 */
export function parseWebhook(input: { headers: HeaderBag; body: unknown }): FerryWebhookEvent {
  const type = header(input.headers, 'x-event-type');
  if (!type) throw new FerryError('not a FerryVN webhook: missing x-event-type header');
  let data: unknown = input.body;
  if (typeof input.body === 'string') {
    try {
      data = JSON.parse(input.body);
    } catch (e) {
      throw new FerryError('FerryVN webhook body is not JSON', { cause: e });
    }
  }
  const category = CATEGORY_BY_EVENT.get(type) ?? 'other';
  return { type, category, data } as FerryWebhookEvent;
}

/** Constant-time string comparison (for webhook URL secrets and tokens). */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
