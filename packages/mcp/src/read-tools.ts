/**
 * Read-only MCP tools. Always registered.
 */
import {
  addDays,
  type BookingFilters,
  BookingPaymentStatus,
  BookingStatus,
  flattenSeatMap,
  isVehicleSeatType,
  seatRef,
  todayInVietnam,
  type VoyageWithAdditions,
  voyageHarborFee,
  voyageUnbookableReason,
} from '@ferryvn/sdk';
import { z } from 'zod';
import { bookingInputShape, prepareDraft, quoteOf } from './booking-schemas.js';
import {
  defineTool,
  resolveLocation,
  summarizeBooking,
  summarizeBookingBrief,
  ToolInputError,
} from './tool-helpers.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const time = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use HH:mm');
const cursor = z.string().optional().describe('next_cursor from a previous call, to fetch the next page');
const sec = (t: string) => (t.length === 5 ? `${t}:00` : t);

const bookingStatusNames = Object.keys(BookingStatus) as [string, ...string[]];
const paymentStatusNames = Object.keys(BookingPaymentStatus) as [string, ...string[]];

const hhmm = (t: string | null | undefined) => t?.slice(0, 5);
const unbookable = (v: VoyageWithAdditions) => (v.voyage ? voyageUnbookableReason(v.voyage) : 'disabled');

function compactVoyage(v: VoyageWithAdditions, withStatus = false) {
  const voyage = v.voyage;
  return {
    voyage_id: voyage?.id,
    date: voyage?.departure_date?.slice(0, 10),
    depart_time: hhmm(voyage?.depart_time),
    arrive_time: hhmm(voyage?.arrive_time),
    route: voyage?.route ? `${voyage.route.departure_name} → ${voyage.route.destination_name}` : undefined,
    operator: voyage?.operator?.operator_name,
    operator_id: voyage?.operator_id,
    boat: voyage?.boat_name,
    seats_left: voyage?.no_remain,
    from_price_vnd: voyage?.ticket_prices?.default_ticket_price,
    ...(withStatus ? { status: unbookable(v) ?? 'bookable' } : {}),
  };
}

export const searchLocations = defineTool({
  name: 'search_locations',
  title: 'Search ferry locations',
  description:
    'Find ports/islands served by FerryVN (e.g. "Phú Quốc", "Rạch Giá", "Côn Đảo"). Matching is accent-insensitive on name and abbreviation. Omit `query` to list every location. Use the returned `id` (or the exact name) as `from`/`to` in search_voyages.',
  inputSchema: {
    query: z.string().optional().describe('Name or abbreviation, e.g. "phu quoc" or "PQ". Omit to list all.'),
  },
  annotations: { ...READ_ONLY, title: 'Search ferry locations' },
  write: false,
  handler: async ({ sdk }, { query }) => {
    const rows = query ? await sdk.locations.find(query) : await sdk.locations.list();
    return {
      locations: rows.map((l) => ({
        id: l.id,
        name: l.location_name,
        abbreviation: l.abbreviation,
        disabled: l.disable,
      })),
    };
  },
});

export const listRoutes = defineTool({
  name: 'list_routes',
  title: 'List ferry routes',
  description:
    'List ferry routes (tuyến), optionally between two locations, with the operators (hãng tàu) serving each. Paginated: pass `cursor` = previous `next_cursor`.',
  inputSchema: {
    from: z.string().optional().describe('Departure location id or name'),
    to: z.string().optional().describe('Destination location id or name'),
    limit: z.number().int().min(1).max(100).optional().describe('Page size, default 10'),
    cursor,
  },
  annotations: { ...READ_ONLY, title: 'List ferry routes' },
  write: false,
  handler: async ({ sdk }, args) => {
    const filters: { departure_id?: string; destination_id?: string } = {};
    if (args.from) filters.departure_id = (await resolveLocation(sdk, args.from, 'from')).id;
    if (args.to) filters.destination_id = (await resolveLocation(sdk, args.to, 'to')).id;
    const page = await sdk.routes.list({ filters, limit: args.limit, cursor: args.cursor });
    return {
      routes: page.data.map((r) => ({
        route_id: r.id,
        from: r.departure_name,
        to: r.destination_name,
        disabled: r.disable,
        operators: (r.operators ?? []).map((o) => ({
          operator_id: o.operator_id,
          name: o.operator?.operator_name,
          travel_time: o.estimate_travel_time,
        })),
      })),
      next_cursor: page.next_cursor,
    };
  },
});

export const searchVoyages = defineTool({
  name: 'search_voyages',
  title: 'Search voyages',
  description:
    'Search scheduled ferry voyages (chuyến tàu) between two locations on a date (Vietnam time), or a date range with `until`. Returns departure/arrival times, operator, boat, seats left and an indicative starting price in VND (it can lag the operator’s live price — quote_booking / get_seat_map give the price that is charged). Voyages that cannot be sold (disabled by the operator, sold out, departed) are left out unless include_unavailable=true. Data is pre-synced from operators (not real-time): confirm availability with get_seat_map before booking.',
  inputSchema: {
    from: z.string().describe('Departure location id or name, e.g. "Rạch Giá"'),
    to: z.string().describe('Destination location id or name, e.g. "Phú Quốc"'),
    date: date.describe('Departure date YYYY-MM-DD (Vietnam time)'),
    until: date.optional().describe('Optional end date (inclusive) to search a date range'),
    depart_after: time.optional().describe('Earliest departure time HH:mm'),
    depart_before: time.optional().describe('Latest departure time HH:mm'),
    operator_ids: z.array(z.string()).optional().describe('Only these operators (operator_id from list_routes)'),
    include_unavailable: z
      .boolean()
      .optional()
      .describe('Also return voyages that cannot be sold, with a `status` (default false)'),
    limit: z.number().int().min(1).max(50).optional().describe('Page size, default 10'),
    cursor,
  },
  annotations: { ...READ_ONLY, title: 'Search voyages' },
  write: false,
  handler: async ({ sdk }, args) => {
    if (args.until && args.until < args.date) throw new ToolInputError('`until` must not be before `date`');
    const [from, to] = await Promise.all([
      resolveLocation(sdk, args.from, 'from'),
      resolveLocation(sdk, args.to, 'to'),
    ]);
    const common = {
      departureId: from.id,
      destinationId: to.id,
      limit: args.limit,
      cursor: args.cursor,
      filters: {
        ...(args.depart_after ? { min_depart_time: sec(args.depart_after) } : {}),
        ...(args.depart_before ? { max_depart_time: sec(args.depart_before) } : {}),
        ...(args.operator_ids?.length ? { operator_ids: args.operator_ids } : {}),
      },
    };
    const page = args.until
      ? await sdk.voyages.searchRange({ ...common, from: args.date, to: args.until })
      : await sdk.voyages.search({ ...common, date: args.date });
    const shown = args.include_unavailable ? page.data : page.data.filter((v) => !unbookable(v));
    return {
      from: { id: from.id, name: from.location_name },
      to: { id: to.id, name: to.location_name },
      voyages: shown.map((v) => compactVoyage(v, args.include_unavailable)),
      ...(shown.length < page.data.length ? { hidden_unavailable: page.data.length - shown.length } : {}),
      next_cursor: page.next_cursor,
    };
  },
});

const MAX_PRICE_RANGE_DAYS = 7;

export const getRoutePrices = defineTool({
  name: 'get_route_prices',
  title: 'Route prices',
  description: [
    'Selling prices of a route on a date (or a range of up to 7 days): for every voyage, the price per seat type and ticket type (adult, child, elderly…) incl. VAT, with the per-ticket harbor fee and the age rules of each ticket type.',
    'These are the prices the organization’s customers pay (never the organization’s cost). By default they come from synced voyage data and can lag the operator; set live (≤5) to re-price the first voyages from their live seat map — each live voyage may query the operator, so keep it small.',
    'Vehicle places are left out unless include_vehicles; ticket types the API cannot book (zero price, or not covered by the operator’s rules) are always left out. Use quote_booking for the exact total of a given group of passengers.',
  ].join(' '),
  inputSchema: {
    from: z.string().describe('Departure location id or name, e.g. "Rạch Giá"'),
    to: z.string().describe('Destination location id or name, e.g. "Phú Quốc"'),
    date: date.describe('Departure date YYYY-MM-DD (Vietnam time)'),
    until: date.optional().describe('Optional end date (inclusive), at most 6 days after `date`'),
    operator_ids: z.array(z.string()).optional().describe('Only these operators'),
    live: z
      .number()
      .int()
      .min(0)
      .max(5)
      .optional()
      .describe('Re-price the first n voyages from live seat maps (default 0)'),
    include_vehicles: z.boolean().optional().describe('Also list motorbike/car places (default false)'),
    max_voyages: z.number().int().min(1).max(30).optional().describe('Cap on voyages returned (default 10)'),
  },
  annotations: { ...READ_ONLY, title: 'Route prices' },
  write: false,
  handler: async ({ sdk }, args) => {
    if (args.until) {
      const days = (Date.parse(args.until) - Date.parse(args.date)) / 86_400_000;
      if (days < 0) throw new ToolInputError('`until` must not be before `date`');
      if (days >= MAX_PRICE_RANGE_DAYS) {
        throw new ToolInputError(`A price table covers at most ${MAX_PRICE_RANGE_DAYS} days: call again per week.`);
      }
    }
    const [from, to] = await Promise.all([
      resolveLocation(sdk, args.from, 'from'),
      resolveLocation(sdk, args.to, 'to'),
    ]);
    const result = await sdk.prices.forRoute({
      departureId: from.id,
      destinationId: to.id,
      ...(args.until ? { from: args.date, to: args.until } : { date: args.date }),
      ...(args.operator_ids?.length ? { filters: { operator_ids: args.operator_ids } } : {}),
      live: args.live ?? 0,
      includeVehicles: args.include_vehicles,
    });
    const cap = args.max_voyages ?? 10;
    return {
      from: from.location_name,
      to: to.location_name,
      voyages: result.voyages.slice(0, cap).map((v) => {
        // Ticket types (name + age rules) once per voyage; price rows only reference them.
        const ticketTypes = new Map<number, { id: number; name: string; rules?: string }>();
        for (const p of v.prices) {
          const known = ticketTypes.get(p.ticketTypeId);
          if (!known)
            ticketTypes.set(p.ticketTypeId, {
              id: p.ticketTypeId,
              name: p.ticketType,
              ...(p.rules ? { rules: p.rules } : {}),
            });
          else if (!known.rules && p.rules) known.rules = p.rules;
        }
        return {
          voyage_id: v.voyageId,
          departure: v.departure,
          operator: v.operatorName,
          boat: v.boat,
          seats_left: v.seatsLeft,
          harbor_fee_per_ticket_vnd: v.harborFeeVnd,
          source: v.source === 'seat-map' ? 'live seat map' : 'synced (indicative)',
          ...(v.liveError ? { live_error: v.liveError } : {}),
          default_from_vnd: v.defaultFromVnd,
          from_vnd: v.fromVnd,
          ticket_types: [...ticketTypes.values()].sort((a, b) => a.id - b.id),
          prices: v.prices.map((p) => ({
            seat_type: p.seatType,
            ...(p.vehicle ? { vehicle_place: true } : {}),
            ticket_type_id: p.ticketTypeId,
            price_vnd: p.priceVnd,
          })),
        };
      }),
      ...(result.voyages.length > cap ? { more_voyages: result.voyages.length - cap } : {}),
      ...(result.hiddenUnavailable ? { hidden_unavailable: result.hiddenUnavailable } : {}),
    };
  },
});

export const getVoyageCalendar = defineTool({
  name: 'get_voyage_calendar',
  title: 'Voyage calendar',
  description:
    'How many voyages (and how many still bookable) run each day between two locations — use it to suggest alternative dates when a day is sold out.',
  inputSchema: {
    from: z.string().describe('Departure location id or name'),
    to: z.string().describe('Destination location id or name'),
    start_date: date.optional().describe('First day YYYY-MM-DD (default today, Vietnam time)'),
    days: z.number().int().min(1).max(62).optional().describe('Number of days, default 14'),
  },
  annotations: { ...READ_ONLY, title: 'Voyage calendar' },
  write: false,
  handler: async ({ sdk }, args) => {
    const [from, to] = await Promise.all([
      resolveLocation(sdk, args.from, 'from'),
      resolveLocation(sdk, args.to, 'to'),
    ]);
    const start = args.start_date ?? todayInVietnam();
    const rows = await sdk.voyageCounts.list({
      departureId: from.id,
      destinationId: to.id,
      from: start,
      to: addDays(start, (args.days ?? 14) - 1),
    });
    return {
      from: from.location_name,
      to: to.location_name,
      days: rows.map((r) => ({
        date: r.departure_date?.slice(0, 10),
        voyages: r.total_voyage,
        available: r.total_available_voyage,
      })),
    };
  },
});

export const getSeatMap = defineTool({
  name: 'get_seat_map',
  title: 'Get seat map',
  description:
    'Get the latest seat map (sơ đồ ghế) of a voyage: free seats grouped by seat type, prices per seat type and ticket type (incl. VAT), the per-ticket harbor fee, and the ticket-type rules (age, nationality). Pass the seat strings exactly as listed to create_booking / quote_booking (a few boats repeat seat names; those are listed as NAME#POSITION_ID). Vehicle places (motorbike/car slots some operators sell as seat types) are flagged. Each call may query the operator live (cached ~5 min): do not call it for many voyages in a row. There is no seat hold: seats are only secured when tickets are issued.',
  inputSchema: {
    voyage_id: z.string().describe('voyage_id from search_voyages'),
    include_unavailable: z
      .boolean()
      .optional()
      .describe('Also list every seat with its status (larger output; default false)'),
    max_seats: z.number().int().min(1).max(500).optional().describe('Cap on seats listed per seat type (default 60)'),
  },
  annotations: { ...READ_ONLY, title: 'Get seat map' },
  write: false,
  handler: async ({ sdk }, args) => {
    const [layout, voyage] = await Promise.all([
      sdk.boatLayouts.latestByVoyageId(args.voyage_id),
      sdk.voyages.get(args.voyage_id),
    ]);
    const map = flattenSeatMap(layout);
    const cap = args.max_seats ?? 60;
    const nameCount = new Map<string, number>();
    for (const s of map.seats) nameCount.set(s.seatName ?? '', (nameCount.get(s.seatName ?? '') ?? 0) + 1);
    const label = (s: (typeof map.seats)[number]) =>
      (nameCount.get(s.seatName ?? '') ?? 0) > 1 ? seatRef(s) : (s.seatName ?? seatRef(s));
    const bl = layout.boatLayout;
    const seatTypes = [...new Set(map.seats.map((s) => s.seatType ?? ''))];
    const rules = new Map<number, { ticket_type_id: number; ticket_type: string; rules: string[] }>();
    for (const c of bl?.ticket_type_configs ?? []) {
      const entry = rules.get(c.ticket_type_id) ?? {
        ticket_type_id: c.ticket_type_id,
        ticket_type: c.ticket_type_label,
        rules: [],
      };
      entry.rules.push(`${c.key_config} ${c.value_config}`);
      rules.set(c.ticket_type_id, entry);
    }
    return {
      voyage_id: args.voyage_id,
      departure: `${voyage.departure_date?.slice(0, 10)} ${hhmm(voyage.depart_time) ?? ''}`.trim(),
      operator: voyage.operator?.operator_name,
      total_seats: map.total,
      available_seats: map.available,
      harbor_fee_per_ticket_vnd: voyageHarborFee(voyage),
      seat_types: seatTypes.map((type) => {
        const free = map.seats.filter((s) => s.available && (s.seatType ?? '') === type);
        return {
          seat_type: type,
          ...(isVehicleSeatType(type) ? { vehicle_place: true } : {}),
          free_count: free.length,
          free_seats: free.slice(0, cap).map(label),
          ...(free.length > cap ? { more_free_seats: free.length - cap } : {}),
          prices: (bl?.prices ?? [])
            .filter((p) => p.seat_type === type)
            .map((p) => ({
              ticket_type_id: p.ticket_type_id,
              ticket_type: p.ticket_type_label,
              price_vnd: p.price_with_VAT,
            })),
        };
      }),
      ticket_types: [...rules.values()].map((r) => ({ ...r, rules: r.rules.join(', ') })),
      ...(args.include_unavailable
        ? {
            seats: map.seats.slice(0, cap * Math.max(1, seatTypes.length)).map((s) => ({
              seat: label(s),
              seat_type: s.seatType,
              floor: s.floorName ?? s.floorId,
              vip: s.isVip,
              available: s.available,
            })),
          }
        : {}),
      ...(map.floors.length > 1
        ? { floors: map.floors.map((f) => ({ floor: f.floorName ?? f.floorId, free: f.available, total: f.total })) }
        : {}),
    };
  },
});

export const quoteBooking = defineTool({
  name: 'quote_booking',
  title: 'Quote booking',
  description: [
    'Check and price a booking WITHOUT creating it: same input as create_booking.',
    'Validates seats, passengers (age → ticket type, nationality, ID/home-town length rules of the operator) and voucher codes, auto-picks adjacent seats when none are given, and returns the seats, ticket types and the estimated total (tickets + harbor fees − vouchers) the server will charge.',
    'Use it before asking the user to confirm a booking; errors list every problem to fix.',
  ].join(' '),
  inputSchema: bookingInputShape,
  annotations: { ...READ_ONLY, title: 'Quote booking' },
  write: false,
  handler: async ({ sdk }, args) => quoteOf((await prepareDraft(sdk, args)).draft),
});

export const findCustomers = defineTool({
  name: 'find_customers',
  title: 'Find customers',
  description:
    "Search the organization's customers (khách hàng) by phone, email or name. create_booking needs the numeric customer id; if nobody matches, create_customer can add one (when writes are enabled).",
  inputSchema: {
    query: z.string().min(2).describe('Phone (e.g. 0901234567), email or part of the name'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results, default 10'),
  },
  annotations: { ...READ_ONLY, title: 'Find customers' },
  write: false,
  handler: async ({ sdk }, args) => {
    const rows = await sdk.customers.search(args.query, { limit: args.limit ?? 10 });
    return {
      customers: rows.map((c) => ({
        customer_id: c.id,
        name: [c.last_name, c.first_name].filter(Boolean).join(' '),
        phone: c.phone,
        email: c.email,
      })),
    };
  },
});

export const getBooking = defineTool({
  name: 'get_booking',
  title: 'Get booking',
  description:
    "Get one booking (đơn đặt vé) of the API key's organization: status, payment status and deadline, orderer contact, depart/return orders with voyage and tickets (passenger name, seat, position_id).",
  inputSchema: { booking_id: z.string().describe('Booking id, 8 characters, e.g. "XJQN1JDC"') },
  annotations: { ...READ_ONLY, title: 'Get booking' },
  write: false,
  handler: async ({ sdk }, { booking_id }) => summarizeBooking(await sdk.bookings.get(booking_id)),
});

export const listBookings = defineTool({
  name: 'list_bookings',
  title: 'List bookings',
  description:
    "List bookings of the API key's organization, newest first, with optional filters: one brief row per booking (status, payment, orderer, route, departure, total). Use get_booking for the passengers and tickets. Paginated with `cursor`.",
  inputSchema: {
    statuses: z.array(z.enum(bookingStatusNames)).optional().describe('Booking statuses to include'),
    payment_statuses: z.array(z.enum(paymentStatusNames)).optional().describe('Payment statuses to include'),
    search: z.string().optional().describe('Match orderer name, phone or email'),
    created_from: date.optional().describe('Created on/after YYYY-MM-DD'),
    created_to: date.optional().describe('Created on/before YYYY-MM-DD'),
    depart_from: date.optional().describe('Departing on/after YYYY-MM-DD'),
    depart_to: date.optional().describe('Departing on/before YYYY-MM-DD'),
    limit: z.number().int().min(1).max(50).optional().describe('Page size, default 10'),
    cursor,
  },
  annotations: { ...READ_ONLY, title: 'List bookings' },
  write: false,
  handler: async ({ sdk }, args) => {
    const filters: BookingFilters = {
      ...(args.statuses?.length
        ? { booking_statuses: args.statuses.map((s) => BookingStatus[s as keyof typeof BookingStatus]) }
        : {}),
      ...(args.payment_statuses?.length
        ? {
            payment_statuses: args.payment_statuses.map(
              (s) => BookingPaymentStatus[s as keyof typeof BookingPaymentStatus],
            ),
          }
        : {}),
      ...(args.search ? { namePhoneEmail: args.search } : {}),
      ...(args.created_from ? { createdAtFrom: args.created_from } : {}),
      ...(args.created_to ? { createdAtTo: args.created_to } : {}),
      ...(args.depart_from ? { depart_date_from: args.depart_from } : {}),
      ...(args.depart_to ? { depart_date_to: args.depart_to } : {}),
    };
    const page = await sdk.bookings.list({ filters, limit: args.limit ?? 10, cursor: args.cursor });
    // Brief rows (no passenger list): use get_booking for one booking's tickets.
    return { bookings: page.data.map(summarizeBookingBrief), next_cursor: page.next_cursor };
  },
});

export const listCancelRequests = defineTool({
  name: 'list_cancel_requests',
  title: 'List cancellation requests',
  description:
    'List ticket-cancellation requests of the organization (status processing → accept → refunded, or reject/recall). Filter by order or booking id.',
  inputSchema: {
    order_id: z.string().optional(),
    booking_id: z.string().optional(),
    statuses: z.array(z.enum(['processing', 'accept', 'reject', 'recall', 'refunded'])).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    cursor,
  },
  annotations: { ...READ_ONLY, title: 'List cancellation requests' },
  write: false,
  handler: async ({ sdk }, args) => {
    const page = await sdk.cancelTicketRequests.list({
      limit: args.limit,
      cursor: args.cursor,
      filters: {
        ...(args.order_id ? { order_id: args.order_id } : {}),
        ...(args.booking_id ? { booking_id: args.booking_id } : {}),
        ...(args.statuses?.length ? { process_statuses: args.statuses } : {}),
      },
    });
    return {
      requests: page.data.map((c) => ({
        id: c.id,
        order_id: c.order_id,
        booking_id: c.booking_id,
        positions: c.cancel_ticket_by_positions,
        status: c.process_status,
        reason: c.cancel_reason,
        created_at: c.createdAt,
      })),
      next_cursor: page.next_cursor,
    };
  },
});

export const getDisruptions = defineTool({
  name: 'get_disruptions',
  title: 'Get disruptions',
  description:
    'Weather/operational disruptions (delays, cancellations) affecting the organization’s bookings: original and revised departure, reason, affected bookings. Filter by booking or state; poll with updated_since.',
  inputSchema: {
    booking_id: z.string().optional().describe('Only disruptions affecting this booking'),
    state: z.enum(['building', 'active', 'closing', 'closed']).optional(),
    updated_since: z.string().optional().describe('ISO timestamp; only incidents updated since then'),
    limit: z.number().int().min(1).max(50).optional(),
    cursor,
  },
  annotations: { ...READ_ONLY, title: 'Get disruptions' },
  write: false,
  handler: async ({ sdk }, args) => {
    const page = args.booking_id
      ? await sdk.disruptions.forBooking(args.booking_id)
      : await sdk.disruptions.list({
          state: args.state,
          updatedSince: args.updated_since,
          limit: args.limit,
          cursor: args.cursor,
        });
    return {
      disruptions: page.data.map((d) => ({
        id: d.id,
        kind: d.kind,
        state: d.state,
        route: `${d.voyage?.route?.departure_name ?? ''} → ${d.voyage?.route?.destination_name ?? ''}`,
        operator: d.voyage?.operator_name,
        original_departure_at: d.original_departure_at,
        revised_departure_at: d.revised_departure_at,
        reason: d.public_reason,
        affected_bookings: d.affected_bookings?.map((b) => ({ booking_id: b.booking_id, tickets: b.ticket_count })),
      })),
      next_cursor: page.next_cursor ?? null,
    };
  },
});

/** Balances are computed with percentages server-side and carry float noise. */
const vndInt = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : v);

export const getAccount = defineTool({
  name: 'get_account',
  title: 'Get account',
  description:
    "The API key's organization: name, balances, credit and the credit still reservable for issuing tickets (VND).",
  inputSchema: {},
  annotations: { ...READ_ONLY, title: 'Get account' },
  write: false,
  handler: async ({ sdk }) => {
    const [org, reservable] = await Promise.all([sdk.organization.me(), sdk.organization.reservableCredit()]);
    return {
      organization: { id: org.id, name: org.name, slug: org.slug },
      credit_vnd: vndInt(org.credit),
      upward_balance_vnd: vndInt(org.upward_balance),
      downward_balance_vnd: vndInt(org.downward_balance),
      reservable_credit_vnd: vndInt(reservable),
      payment_expire_in_hours: (org.setting as { bookings?: { payment_expire_in?: number } } | undefined)?.bookings
        ?.payment_expire_in,
    };
  },
});

export const listVouchers = defineTool({
  name: 'list_vouchers',
  title: 'List vouchers',
  description:
    "The organization's voucher codes with amount, validity and usage — codes can be passed to create_booking.",
  inputSchema: { limit: z.number().int().min(1).max(50).optional(), cursor },
  annotations: { ...READ_ONLY, title: 'List vouchers' },
  write: false,
  handler: async ({ sdk }, args) => {
    const page = await sdk.vouchers.list({ limit: args.limit, cursor: args.cursor });
    return {
      vouchers: page.data.map((v) => ({
        code: v.voucher_code,
        title: v.title,
        amount: v.amount,
        amount_type: v.amount_type,
        valid_from: v.effectiveFrom,
        valid_to: v.effectiveTo,
        used: v.usage_count,
        limit: v.usage_limit,
      })),
      next_cursor: page.next_cursor,
    };
  },
});

export const READ_TOOLS = [
  searchLocations,
  listRoutes,
  searchVoyages,
  getRoutePrices,
  getVoyageCalendar,
  getSeatMap,
  quoteBooking,
  findCustomers,
  getBooking,
  listBookings,
  listCancelRequests,
  getDisruptions,
  getAccount,
  listVouchers,
];
