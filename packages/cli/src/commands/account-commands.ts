/**
 * Organization-side commands: account, customers, transactions, debts,
 * vouchers, disruptions. All read-only except `customers create/update`.
 */
import { type CreateCustomerInput, type Customer, type CustomerFilters, collect, type Transaction } from '@ferryvn/sdk';
import type { Command } from 'commander';
import { type CliContext, UsageError } from '../cli-context.js';
import { vnDateTime, vnd } from '../output.js';
import { parseLimit, requireDate } from './supply-commands.js';

type GetCtx = (cmd: Command) => CliContext;

function parseJsonInput(raw: string, flag: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected a JSON object');
    return v as Record<string, unknown>;
  } catch (e) {
    throw new UsageError(`${flag} is not a valid JSON object: ${(e as Error).message}`);
  }
}

const customerColumns = [
  { header: 'ID', get: (c: Customer) => c.id },
  { header: 'NAME', get: (c: Customer) => [c.last_name, c.first_name].filter(Boolean).join(' '), max: 28 },
  // phone_country_code is an ISO letter code (VN), not a dialing prefix.
  { header: 'PHONE', get: (c: Customer) => c.phone ?? '' },
  { header: 'EMAIL', get: (c: Customer) => c.email, max: 30 },
  { header: 'BALANCE', get: (c: Customer) => vnd(c.balance) },
  { header: 'CREATED', get: (c: Customer) => vnDateTime(c.createdAt) },
];

const transactionColumns = [
  { header: 'ID', get: (t: Transaction) => t.id },
  { header: 'TIME', get: (t: Transaction) => vnDateTime(t.createdAt) },
  { header: 'TYPE', get: (t: Transaction) => t.type },
  { header: 'CHANGE', get: (t: Transaction) => t.change_type },
  { header: 'AMOUNT', get: (t: Transaction) => vnd(t.amount) },
  { header: 'BOOKING', get: (t: Transaction) => t.booking_id },
  { header: 'STATUS', get: (t: Transaction) => t.status },
  { header: 'CONTENT', get: (t: Transaction) => t.content, max: 30 },
];

export function registerAccountCommands(program: Command, getCtx: GetCtx): void {
  program
    .command('account')
    .description("Show the API key's organization, balances and reservable credit")
    .action(async (_opts: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const sdk = ctx.sdk();
      const [org, credit] = await Promise.all([sdk.organization.me(), sdk.organization.reservableCredit()]);
      ctx.emit({ organization: org, reservableCredit: credit }, () => {
        ctx.out(`Organization : ${org.name} (${org.slug}, ${org.id})`);
        ctx.out(`Credit       : ${vnd(org.credit)}`);
        ctx.out(`Balances     : downward ${vnd(org.downward_balance)} · upward ${vnd(org.upward_balance)}`);
        ctx.out(`Reservable   : ${vnd(credit)} (credit usable when issuing tickets)`);
      });
    });

  const customers = program.command('customers').description('Customers (khách hàng) of your organization');
  customers
    .command('list', { isDefault: true })
    .description('List or search customers (newest first)')
    .option('--search <text>', 'match name, phone or email')
    .option('--phone <phone>', 'exact phone')
    .option('--email <email>', 'exact email')
    .option('--limit <n>', 'page size (max 50)')
    .option('--cursor <cursor>', 'page cursor')
    .option('--all', 'follow cursors and fetch every page')
    .action(
      async (
        opts: { search?: string; phone?: string; email?: string; limit?: string; cursor?: string; all?: boolean },
        cmd: Command,
      ) => {
        const ctx = getCtx(cmd);
        const filters: CustomerFilters = {
          ...(opts.search ? { namePhoneEmail: opts.search } : {}),
          ...(opts.phone ? { phone: opts.phone } : {}),
          ...(opts.email ? { email: opts.email } : {}),
        };
        const limit = parseLimit(opts.limit, 50);
        const sdk = ctx.sdk();
        if (opts.all)
          return ctx.emitList(await collect(sdk.customers.iterate({ filters, limit: limit ?? 50 })), customerColumns);
        const page = await sdk.customers.list({ filters, limit, cursor: opts.cursor });
        ctx.emitList(page.data, customerColumns, { nextCursor: page.next_cursor });
      },
    );
  customers
    .command('get')
    .description('Show one customer')
    .argument('<id>', 'customer id (number)')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const c = await ctx.sdk().customers.get(id);
      ctx.emit(c, () => ctx.emitList([c], customerColumns));
    });
  customers
    .command('create')
    .description('Create a customer (needed as `customer_id` for bookings)')
    .option('--first-name <name>', 'given name (required unless in --data)')
    .option('--last-name <name>', 'family name')
    .option('--phone <phone>', 'phone number without country code, e.g. 901234567')
    .option('--country-code <code>', 'phone country code, ISO 3166 alpha-2 (default VN)')
    .option('--email <email>', 'email')
    .option('--data <json|@file>', 'full CreateCustomerDto as JSON (or @path to a JSON file); flags override it')
    .action(
      async (
        opts: {
          firstName?: string;
          lastName?: string;
          phone?: string;
          countryCode?: string;
          email?: string;
          data?: string;
        },
        cmd: Command,
      ) => {
        const ctx = getCtx(cmd);
        const base = opts.data
          ? parseJsonInput(opts.data.startsWith('@') ? ctx.deps.readFile(opts.data.slice(1)) : opts.data, '--data')
          : {};
        const input = {
          ...base,
          ...(opts.firstName ? { first_name: opts.firstName } : {}),
          ...(opts.lastName ? { last_name: opts.lastName } : {}),
          ...(opts.phone ? { phone: opts.phone } : {}),
          ...(opts.email ? { email: opts.email } : {}),
          phone_country_code: opts.countryCode ?? (base.phone_country_code as string | undefined) ?? 'VN',
        };
        if (!input.first_name) throw new UsageError('--first-name (or first_name in --data) is required');
        const created = await ctx.sdk().customers.create(input as unknown as CreateCustomerInput);
        ctx.emit(created, () => ctx.out(`Created customer ${created.id} (${created.first_name})`));
      },
    );

  program
    .command('transactions')
    .description("List your organization's balance transactions (read-only)")
    .option('--booking <id>', 'filter by booking id')
    .option('--customer <id>', 'filter by customer id')
    .option('--type <codes>', 'transaction type codes, comma-separated (e.g. PB,PO,RF,DP)')
    .option('--from-date <YYYY-MM-DD>', 'created from')
    .option('--to-date <YYYY-MM-DD>', 'created to')
    .option('--limit <n>', 'page size (max 50)')
    .option('--cursor <cursor>', 'page cursor')
    .option('--all', 'follow cursors and fetch every page')
    .action(
      async (
        opts: {
          booking?: string;
          customer?: string;
          type?: string;
          fromDate?: string;
          toDate?: string;
          limit?: string;
          cursor?: string;
          all?: boolean;
        },
        cmd: Command,
      ) => {
        const ctx = getCtx(cmd);
        const customerId = opts.customer ? Number(opts.customer) : undefined;
        if (customerId !== undefined && !Number.isInteger(customerId))
          throw new UsageError('--customer must be a number');
        const filters = {
          ...(opts.booking ? { booking_id: opts.booking } : {}),
          ...(customerId !== undefined ? { customer_id: customerId } : {}),
          ...(opts.type ? { types: opts.type.split(',').map((s) => s.trim().toUpperCase()) } : {}),
          // Validated: the backend silently ignores a date it cannot parse (the whole ledger comes back).
          ...(opts.fromDate ? { createdAtFrom: requireDate(opts.fromDate, '--from-date') } : {}),
          ...(opts.toDate ? { createdAtTo: requireDate(opts.toDate, '--to-date') } : {}),
        };
        const limit = parseLimit(opts.limit, 50);
        const sdk = ctx.sdk();
        if (opts.all) {
          return ctx.emitList(
            await collect(sdk.transactions.iterate({ filters, limit: limit ?? 50 })),
            transactionColumns,
          );
        }
        const page = await sdk.transactions.list({ filters, limit, cursor: opts.cursor });
        ctx.emitList(page.data, transactionColumns, { nextCursor: page.next_cursor });
      },
    );

  program
    .command('debts')
    .description('List customer debts (debt ledger)')
    .option('--status <list>', 'borrowing,paid,written_off')
    .option('--customer <id>', 'filter by customer id')
    .option('--limit <n>', 'page size (max 50)')
    .option('--cursor <cursor>', 'page cursor')
    .action(async (opts: { status?: string; customer?: string; limit?: string; cursor?: string }, cmd: Command) => {
      const ctx = getCtx(cmd);
      const allowed = ['borrowing', 'paid', 'written_off'] as const;
      const statuses = opts.status?.split(',').map((s) => s.trim()) ?? [];
      const bad = statuses.filter((s) => !(allowed as readonly string[]).includes(s));
      if (bad.length) throw new UsageError(`--status: unknown ${bad.join(', ')} (valid: ${allowed.join(', ')})`);
      const page = await ctx.sdk().debtLedger.list({
        limit: parseLimit(opts.limit, 50),
        cursor: opts.cursor,
        filters: {
          ...(statuses.length ? { statuses: statuses as (typeof allowed)[number][] } : {}),
          ...(opts.customer ? { customer_ids: [Number(opts.customer)] } : {}),
        },
      });
      ctx.emitList(
        page.data,
        [
          { header: 'ID', get: (d) => d.id },
          { header: 'CUSTOMER', get: (d) => d.customer_id },
          { header: 'BOOKING', get: (d) => d.booking_id },
          { header: 'AMOUNT', get: (d) => vnd(d.amount) },
          { header: 'STATUS', get: (d) => d.status },
          { header: 'CREATED', get: (d) => vnDateTime(d.createdAt) },
          { header: 'PAID_AT', get: (d) => vnDateTime(d.paid_at) },
        ],
        { nextCursor: page.next_cursor },
      );
    });

  const vouchers = program.command('vouchers').description("Your organization's vouchers");
  vouchers
    .command('list', { isDefault: true })
    .description('List vouchers')
    .option('--code <codes>', 'voucher codes, comma-separated')
    .option('--limit <n>', 'page size (max 50)')
    .option('--cursor <cursor>', 'page cursor')
    .action(async (opts: { code?: string; limit?: string; cursor?: string }, cmd: Command) => {
      const ctx = getCtx(cmd);
      const page = await ctx.sdk().vouchers.list({
        limit: parseLimit(opts.limit, 50),
        cursor: opts.cursor,
        filters: opts.code ? { voucher_codes: opts.code.split(',').map((s) => s.trim()) } : {},
      });
      ctx.emitList(
        page.data,
        [
          { header: 'ID', get: (v) => v.id },
          { header: 'CODE', get: (v) => v.voucher_code },
          { header: 'TITLE', get: (v) => v.title, max: 30 },
          { header: 'AMOUNT', get: (v) => (v.amount_type === 'percentage' ? `${v.amount}%` : vnd(v.amount)) },
          { header: 'FROM', get: (v) => vnDateTime(v.effectiveFrom) },
          { header: 'TO', get: (v) => vnDateTime(v.effectiveTo) },
          { header: 'USED', get: (v) => `${v.usage_count ?? 0}/${v.usage_limit ?? '∞'}` },
        ],
        { nextCursor: page.next_cursor },
      );
    });

  const disruptions = program.command('disruptions').description('Delays / cancellations affecting your bookings');
  disruptions
    .command('list', { isDefault: true })
    .description('List disruptions (oldest update first)')
    .option('--since <iso>', 'only incidents updated since this ISO timestamp')
    .option('--state <state>', 'building | active | closing | closed')
    .option('--booking <id>', 'only incidents affecting this booking')
    .option('--limit <n>', 'page size (max 50)')
    .option('--cursor <cursor>', 'page cursor')
    .action(
      async (
        opts: { since?: string; state?: string; booking?: string; limit?: string; cursor?: string },
        cmd: Command,
      ) => {
        const ctx = getCtx(cmd);
        const states = ['building', 'active', 'closing', 'closed'] as const;
        if (opts.state && !(states as readonly string[]).includes(opts.state)) {
          throw new UsageError(`--state must be one of ${states.join(', ')}`);
        }
        if (opts.since && !Number.isFinite(Date.parse(opts.since))) throw new UsageError('--since must be an ISO date');
        const page = await ctx.sdk().disruptions.list({
          updatedSince: opts.since,
          state: opts.state as (typeof states)[number] | undefined,
          bookingId: opts.booking,
          limit: parseLimit(opts.limit, 50),
          cursor: opts.cursor,
        });
        ctx.emitList(
          page.data,
          [
            { header: 'ID', get: (d) => d.id },
            { header: 'KIND', get: (d) => d.kind },
            { header: 'STATE', get: (d) => d.state },
            {
              header: 'VOYAGE',
              get: (d) => `${d.voyage?.route?.departure_name ?? ''} → ${d.voyage?.route?.destination_name ?? ''}`,
              max: 32,
            },
            { header: 'ORIGINAL', get: (d) => vnDateTime(d.original_departure_at) },
            { header: 'REVISED', get: (d) => vnDateTime(d.revised_departure_at) },
            { header: 'TICKETS', get: (d) => d.affected_ticket_count },
            { header: 'REASON', get: (d) => d.public_reason, max: 30 },
          ],
          { nextCursor: page.next_cursor ?? null },
        );
      },
    );
  disruptions
    .command('get')
    .description('Show one disruption with the affected bookings')
    .argument('<id>', 'disruption id')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const d = await ctx.sdk().disruptions.get(id);
      ctx.emit(d, () => {
        ctx.out(`Disruption ${d.id} — ${d.kind}, ${d.state}`);
        ctx.out(
          `  ${d.voyage?.route?.departure_name ?? ''} → ${d.voyage?.route?.destination_name ?? ''}  ${d.voyage?.operator_name ?? ''} ${d.voyage?.boat_name ?? ''}`,
        );
        ctx.out(
          `  original ${vnDateTime(d.original_departure_at)}  revised ${vnDateTime(d.revised_departure_at) || '-'}`,
        );
        if (d.public_reason) ctx.out(`  reason: ${d.public_reason}`);
        for (const b of d.affected_bookings ?? [])
          ctx.out(`  booking ${b.booking_id}: ${b.ticket_count} ticket(s), ${b.legs?.join('+')}`);
      });
    });
}
