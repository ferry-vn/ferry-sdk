/**
 * Booking-side commands: booking create/draft/get/list/update/issue/tickets/public,
 * orders, cancel requests.
 *
 * Commands that move money or hold fees (`booking issue`, `cancel request`)
 * need `--yes`, or typing the id back on an interactive terminal.
 */
import {
  type Booking,
  type BookingFilters,
  BookingPaymentStatus,
  BookingStatus,
  type CancelRequestProcessStatus,
  type CancelTicketRequest,
  type CreateBookingInput,
  collect,
  formatIssueTicketError,
  type Order,
  OrderStatus,
  statusLabel,
  ticketFileUrls,
  type UpdateBookingInput,
} from '@ferryvn/sdk';
import type { Command } from 'commander';
import { type CliContext, UsageError } from '../cli-context.js';
import { printTable, vnDateTime, vnd } from '../output.js';
import { registerDraftCommand } from './draft-command.js';
import { parseLimit, requireDate } from './supply-commands.js';

type GetCtx = (cmd: Command) => CliContext;

/** Accepts names ("Booked,Requested") or numbers ("10,2"). */
export function parseStatuses(input: string, enumObj: Record<string, number>, flag: string): number[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (/^\d+$/.test(s) && Object.values(enumObj).includes(Number(s))) return Number(s);
      const hit = Object.entries(enumObj).find(([k]) => k.toLowerCase() === s.toLowerCase());
      if (!hit) throw new UsageError(`${flag}: unknown status "${s}" (valid: ${Object.keys(enumObj).join(', ')})`);
      return hit[1];
    });
}

export function parseJsonFile(raw: string, flag: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new UsageError(`${flag} is not valid JSON: ${(e as Error).message}`);
  }
}

const bookingColumns = [
  { header: 'BOOKING_ID', get: (b: Booking) => b.id },
  { header: 'CREATED', get: (b: Booking) => vnDateTime(b.createdAt) },
  { header: 'ORDERER', get: (b: Booking) => b.orderer_name, max: 22 },
  { header: 'STATUS', get: (b: Booking) => statusLabel(BookingStatus, b.booking_status) },
  { header: 'PAYMENT', get: (b: Booking) => statusLabel(BookingPaymentStatus, b.payment_status) },
  { header: 'TICKETS', get: (b: Booking) => b.no_tickets },
  { header: 'TOTAL', get: (b: Booking) => vnd(b.total_price) },
];

function describeOrder(o: Order | null | undefined, label: string): string[] {
  if (!o) return [];
  const v = o.voyage;
  return [
    `${label}: order ${o.id} — ${statusLabel(OrderStatus, o.order_status)}`,
    v
      ? `  ${v.route?.departure_name ?? ''} → ${v.route?.destination_name ?? ''}  ${v.departure_date?.slice(0, 10)} ${v.depart_time?.slice(0, 5) ?? ''}  ${v.boat_name ?? ''}`
      : '',
    `  tickets: ${o.tickets?.length ?? 0}  total: ${vnd(o.total_price)}${o.total_harbor_fee ? ` (incl. harbor fees ${vnd(o.total_harbor_fee)})` : ''}`,
    o.issue_ticket_error ? `  issue error: ${formatIssueTicketError(o.issue_ticket_error)}` : '',
  ].filter(Boolean);
}

export function printBooking(ctx: CliContext, b: Booking): void {
  ctx.out(
    [
      `Booking ${b.id}`,
      `  status   : ${statusLabel(BookingStatus, b.booking_status)} / payment ${statusLabel(BookingPaymentStatus, b.payment_status)}`,
      `  orderer  : ${b.orderer_name} <${b.contact_email ?? ''}> ${b.phone_number ?? ''}`,
      `  total    : ${vnd(b.total_price)} (${b.no_tickets} ticket(s))${b.total_net_price ? ` · your cost ${vnd(b.total_net_price)}` : ''}`,
      `  pay by   : ${vnDateTime(b.payment_expired_at) || '-'}`,
      ...describeOrder(b.depart_order, 'Depart'),
      ...describeOrder(b.return_order, 'Return'),
    ].join('\n'),
  );
}

export function registerBookingCommands(program: Command, getCtx: GetCtx): void {
  const booking = program.command('booking').description('Booking (đơn đặt vé) commands');

  booking
    .command('create')
    .description('Create a booking from a JSON file (CreateBookingDto). Does not charge money or issue tickets.')
    .requiredOption('--file <path>', 'JSON payload file, or "-" for stdin (see `ferry booking draft`)')
    .option('--dry-run', 'validate JSON locally and print it without calling the API')
    .action(async (opts: { file: string; dryRun?: boolean }, cmd: Command) => {
      const ctx = getCtx(cmd);
      const raw = opts.file === '-' ? await ctx.deps.readStdin() : ctx.deps.readFile(opts.file);
      const payload = parseJsonFile(raw, '--file') as CreateBookingInput;
      if (!payload || typeof payload !== 'object') throw new UsageError('--file must contain a JSON object');
      const missing = (['customer_id', 'orderer_name', 'contact_email', 'depart_order'] as const).filter(
        (k) => payload[k] === undefined || payload[k] === null || payload[k] === '',
      );
      if (missing.length) throw new UsageError(`payload is missing: ${missing.join(', ')}`);
      if (opts.dryRun) return ctx.emit({ dryRun: true, payload }, () => ctx.out(JSON.stringify(payload, null, 2)));
      const created = await ctx.sdk().bookings.create(payload);
      ctx.emit(created, () => {
        printBooking(ctx, created);
        ctx.out(`\nNext: collect payment, then \`ferry booking issue ${created.id}\` to issue tickets.`);
      });
    });

  registerDraftCommand(booking, getCtx);

  booking
    .command('get')
    .description('Show a booking')
    .argument('<id>', 'booking id')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const b = await ctx.sdk().bookings.get(id);
      ctx.emit(b, () => printBooking(ctx, b));
    });

  booking
    .command('public')
    .description('Anonymous booking summary (works without an API key)')
    .argument('<id>', 'booking id')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const b = await ctx.sdk(false).bookings.getPublic(id);
      ctx.emit(b, () =>
        ctx.out(
          `Booking ${b.id}: ${b.departure_location_name} → ${b.destination_location_name}  ${b.departure_date?.slice(0, 10)} ${b.depart_time}  ${b.operator_name ?? ''}  (${b.orderer_name})`,
        ),
      );
    });

  booking
    .command('list')
    .description("List the organization's bookings (newest first)")
    .option('--status <list>', `booking statuses, comma-separated (${Object.keys(BookingStatus).join(', ')})`)
    .option('--payment <list>', `payment statuses (${Object.keys(BookingPaymentStatus).join(', ')})`)
    .option('--search <text>', 'match orderer name / phone / email')
    .option('--customer <id>', 'filter by customer id')
    .option('--from-date <YYYY-MM-DD>', 'created from')
    .option('--to-date <YYYY-MM-DD>', 'created to')
    .option('--depart-from <YYYY-MM-DD>', 'departing from')
    .option('--depart-to <YYYY-MM-DD>', 'departing until')
    .option('--oldest-first', 'oldest bookings first')
    .option('--limit <n>', 'page size (max 50)')
    .option('--cursor <cursor>', 'page cursor')
    .option('--all', 'follow cursors and fetch every page')
    .action(
      async (
        opts: {
          status?: string;
          payment?: string;
          search?: string;
          customer?: string;
          fromDate?: string;
          toDate?: string;
          departFrom?: string;
          departTo?: string;
          oldestFirst?: boolean;
          limit?: string;
          cursor?: string;
          all?: boolean;
        },
        cmd: Command,
      ) => {
        const ctx = getCtx(cmd);
        const customerId = opts.customer === undefined ? undefined : Number(opts.customer);
        if (customerId !== undefined && !Number.isInteger(customerId))
          throw new UsageError('--customer must be a number');
        const filters: BookingFilters = {
          ...(opts.status
            ? { booking_statuses: parseStatuses(opts.status, BookingStatus, '--status') as BookingStatus[] }
            : {}),
          ...(opts.payment
            ? {
                payment_statuses: parseStatuses(
                  opts.payment,
                  BookingPaymentStatus,
                  '--payment',
                ) as BookingPaymentStatus[],
              }
            : {}),
          ...(opts.search ? { namePhoneEmail: opts.search } : {}),
          ...(customerId !== undefined ? { customer_id: customerId } : {}),
          ...(opts.fromDate ? { createdAtFrom: requireDate(opts.fromDate, '--from-date') } : {}),
          ...(opts.toDate ? { createdAtTo: requireDate(opts.toDate, '--to-date') } : {}),
          ...(opts.departFrom ? { depart_date_from: requireDate(opts.departFrom, '--depart-from') } : {}),
          ...(opts.departTo ? { depart_date_to: requireDate(opts.departTo, '--depart-to') } : {}),
        };
        const sdk = ctx.sdk();
        const limit = parseLimit(opts.limit, 50);
        const order = opts.oldestFirst ? ('asc' as const) : undefined;
        if (opts.all) {
          const rows = await collect(sdk.bookings.iterate({ limit: limit ?? 50, filters, order }));
          return ctx.emitList(rows, bookingColumns);
        }
        const page = await sdk.bookings.list({ cursor: opts.cursor, limit, filters, order });
        ctx.emitList(page.data, bookingColumns, { nextCursor: page.next_cursor });
      },
    );

  booking
    .command('update')
    .description('Update contact / VAT invoice fields of a booking (UpdateBookingDto JSON)')
    .argument('<id>', 'booking id')
    .requiredOption('--file <path>', 'JSON file with the fields to change, or "-" for stdin')
    .action(async (id: string, opts: { file: string }, cmd: Command) => {
      const ctx = getCtx(cmd);
      const raw = opts.file === '-' ? await ctx.deps.readStdin() : ctx.deps.readFile(opts.file);
      const input = parseJsonFile(raw, '--file') as UpdateBookingInput;
      const b = await ctx.sdk().bookings.update(id, input);
      ctx.emit(b, () => printBooking(ctx, b));
    });

  booking
    .command('issue')
    .description('Pay from balance/credit and issue tickets with the operator (MOVES MONEY)')
    .argument('<id>', 'booking id')
    .option('--yes', 'confirm without the interactive prompt (charges balance/credit, places the real order)')
    .action(async (id: string, opts: { yes?: boolean }, cmd: Command) => {
      const ctx = getCtx(cmd);
      const sdk = ctx.sdk();
      let message = `\`booking issue\` charges balance/credit and books real seats with the operator (booking ${id}).`;
      if (!opts.yes && ctx.deps.stdinIsTTY && !ctx.json) {
        // Show what is about to be paid before asking.
        const [b, credit] = await Promise.all([
          sdk.bookings.get(id),
          sdk.organization.reservableCredit().catch(() => undefined),
        ]);
        printBooking(ctx, b);
        message = `\nIssue ${b.no_tickets} ticket(s) for ${vnd(b.total_price)}${credit !== undefined ? ` (reservable credit ${vnd(credit)})` : ''}?`;
      }
      await ctx.confirm({ yes: opts.yes, expected: id, message, flagHint: '--yes' });
      if (!ctx.json) ctx.err('Issuing tickets with the operator — this can take a few minutes…');
      await sdk.bookings.confirmToIssue(id);
      const after = await sdk.bookings.get(id);
      ctx.emit(after, () => {
        printBooking(ctx, after);
        if (after.booking_status === BookingStatus.Booked)
          ctx.out(`\nTickets issued. Files: \`ferry booking tickets ${id}\``);
        else
          ctx.out('\nNot issued yet (manual operators issue later; see the order status / issue_ticket_error above).');
      });
    });

  booking
    .command('tickets')
    .description('Show the ticket file URLs of an issued booking (--refresh re-fetches them from the operator first)')
    .argument('<id>', 'booking id')
    .option('--refresh', 'ask the backend to re-download the files from the operator')
    .action(async (id: string, opts: { refresh?: boolean }, cmd: Command) => {
      const ctx = getCtx(cmd);
      const sdk = ctx.sdk();
      if (opts.refresh) await sdk.bookings.refreshTicketFiles(id);
      const urls = ticketFileUrls(await sdk.bookings.get(id));
      ctx.emit(urls, () => {
        if (!urls.depart && !urls.return)
          ctx.out('No ticket files yet (tickets are attached once the booking is issued).');
        for (const [leg, u] of Object.entries(urls)) {
          if (u?.tickets) ctx.out(`${leg} tickets   : ${u.tickets}`);
          if (u?.harborFee) ctx.out(`${leg} harbor fee: ${u.harborFee}`);
        }
      });
    });

  const orders = program.command('orders').description('Order (one voyage of a booking) commands');
  const orderColumns = [
    { header: 'ORDER_ID', get: (o: Order) => o.id },
    { header: 'BOOKING', get: (o: Order) => o.booking_id },
    { header: 'STATUS', get: (o: Order) => statusLabel(OrderStatus, o.order_status) },
    {
      header: 'VOYAGE',
      get: (o: Order) =>
        o.voyage
          ? `${o.voyage.departure_date?.slice(0, 10)} ${o.voyage.depart_time} ${o.voyage.route?.departure_name ?? ''}→${o.voyage.route?.destination_name ?? ''}`
          : o.voyage_id,
      max: 40,
    },
    { header: 'TICKETS', get: (o: Order) => o.tickets?.length ?? 0 },
    { header: 'TOTAL', get: (o: Order) => vnd(o.total_price) },
  ];
  orders
    .command('list')
    .description('List orders')
    .option('--status <list>', `order statuses (${Object.keys(OrderStatus).join(', ')})`)
    .option('--depart-from <YYYY-MM-DD>', 'voyage departing from')
    .option('--depart-to <YYYY-MM-DD>', 'voyage departing until')
    .option('--limit <n>', 'page size (max 50)')
    .option('--cursor <cursor>', 'page cursor')
    .action(
      async (
        opts: { status?: string; departFrom?: string; departTo?: string; limit?: string; cursor?: string },
        cmd: Command,
      ) => {
        const ctx = getCtx(cmd);
        const page = await ctx.sdk().orders.list({
          limit: parseLimit(opts.limit, 50),
          cursor: opts.cursor,
          filters: {
            ...(opts.status
              ? { order_statuses: parseStatuses(opts.status, OrderStatus, '--status') as OrderStatus[] }
              : {}),
            ...(opts.departFrom ? { voyageDepartDateFrom: requireDate(opts.departFrom, '--depart-from') } : {}),
            ...(opts.departTo ? { voyageDepartDateTo: requireDate(opts.departTo, '--depart-to') } : {}),
          },
        });
        ctx.emitList(page.data, orderColumns, { nextCursor: page.next_cursor });
      },
    );
  orders
    .command('get')
    .argument('<id>', 'order id')
    .description('Show an order with its tickets')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const o = await ctx.sdk().orders.get(id);
      ctx.emit(o, () => {
        ctx.out(describeOrder(o, 'Order').join('\n'));
        printTable(ctx.deps.stdout, o.tickets ?? [], [
          { header: 'NAME', get: (t) => t.name },
          { header: 'SEAT', get: (t) => t.seat_name },
          { header: 'POSITION_ID', get: (t) => t.position_id },
          { header: 'TYPE', get: (t) => t.ticket_type_id },
          { header: 'CANCELLED', get: (t) => (t.is_cancelled ? 'yes' : '') },
        ]);
      });
    });

  const cancel = program.command('cancel').description('Cancel-ticket requests (yêu cầu huỷ vé)');
  cancel
    .command('request')
    .description('Request cancellation of tickets in an order (holds the cancellation fee)')
    .requiredOption('--order <orderId>', 'order id')
    .requiredOption('--positions <list>', 'comma-separated ticket position ids to cancel (see `ferry orders get`)')
    .requiredOption('--reason <text>', 'cancellation reason')
    .option('--allow-post-departure', 'allow cancelling after departure (if your org permits)')
    .option('--yes', 'confirm without the interactive prompt (a cancellation fee is held immediately)')
    .action(
      async (
        opts: { order: string; positions: string; reason: string; allowPostDeparture?: boolean; yes?: boolean },
        cmd: Command,
      ) => {
        const ctx = getCtx(cmd);
        const positions = opts.positions
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (!positions.length) throw new UsageError('--positions must list at least one position id');
        await ctx.confirm({
          yes: opts.yes,
          expected: opts.order,
          message: `This requests cancellation of ${positions.length} ticket(s) in order ${opts.order}; the backend holds the cancellation fee immediately.`,
          flagHint: '--yes',
        });
        const res = await ctx.sdk().cancelTicketRequests.create({
          order_id: opts.order,
          cancel_ticket_by_positions: positions,
          cancel_reason: opts.reason,
          ...(opts.allowPostDeparture ? { allow_post_departure_cancel: true } : {}),
        });
        ctx.emit(res, () =>
          ctx.out(`Cancel request ${res.id} created — status ${res.process_status ?? 'processing'}.`),
        );
      },
    );

  const cancelColumns = [
    { header: 'REQUEST_ID', get: (c: CancelTicketRequest) => c.id },
    { header: 'CREATED', get: (c: CancelTicketRequest) => vnDateTime(c.createdAt) },
    { header: 'ORDER', get: (c: CancelTicketRequest) => c.order_id },
    { header: 'BOOKING', get: (c: CancelTicketRequest) => c.booking_id },
    { header: 'POSITIONS', get: (c: CancelTicketRequest) => c.cancel_ticket_by_positions?.join(',') },
    { header: 'STATUS', get: (c: CancelTicketRequest) => c.process_status },
    { header: 'REASON', get: (c: CancelTicketRequest) => c.cancel_reason, max: 30 },
  ];
  const CANCEL_STATUSES: readonly CancelRequestProcessStatus[] = [
    'processing',
    'accept',
    'reject',
    'recall',
    'refunded',
  ];

  cancel
    .command('list')
    .description('List cancel requests of your organization (and its descendants)')
    .option('--order <orderId>', 'filter by order id')
    .option('--booking <bookingId>', 'filter by booking id')
    .option('--status <list>', CANCEL_STATUSES.join(','))
    .option('--limit <n>', 'page size (max 50)')
    .option('--cursor <cursor>', 'page cursor')
    .action(
      async (
        opts: { order?: string; booking?: string; status?: string; limit?: string; cursor?: string },
        cmd: Command,
      ) => {
        const ctx = getCtx(cmd);
        const statuses = opts.status?.split(',').map((s) => s.trim()) ?? [];
        const bad = statuses.filter((s) => !(CANCEL_STATUSES as readonly string[]).includes(s));
        if (bad.length)
          throw new UsageError(`--status: unknown ${bad.join(', ')} (valid: ${CANCEL_STATUSES.join(', ')})`);
        const page = await ctx.sdk().cancelTicketRequests.list({
          cursor: opts.cursor,
          limit: parseLimit(opts.limit, 50),
          filters: {
            ...(opts.order ? { order_id: opts.order } : {}),
            ...(opts.booking ? { booking_id: opts.booking } : {}),
            ...(statuses.length ? { process_statuses: statuses as CancelRequestProcessStatus[] } : {}),
          },
        });
        ctx.emitList(page.data, cancelColumns, { nextCursor: page.next_cursor });
      },
    );

  cancel
    .command('get')
    .description('Show one cancel request')
    .argument('<id>', 'cancel request id')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      // Throws FerryNotFoundError (exit 4) for an unknown id.
      const res = await ctx.sdk().cancelTicketRequests.get(id);
      ctx.emit(res, () => ctx.emitList([res], cancelColumns));
    });
}
