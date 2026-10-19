/**
 * Read-only supply commands: locations, routes, operators, voyages search,
 * calendar (voyage counts), seats.
 */
import {
  addDays,
  collect,
  flattenSeatMap,
  isValidYmd,
  isVehicleSeatType,
  MAX_LIVE_SEAT_MAPS,
  type Route,
  type RoutePriceEntry,
  type RouteVoyagePrices,
  seatRef,
  todayInVietnam,
  type VoyageWithAdditions,
  voyageUnbookableReason,
} from '@ferryvn/sdk';
import type { Command } from 'commander';
import { type CliContext, UsageError } from '../cli-context.js';
import { printTable, vnd } from '../output.js';

type GetCtx = (cmd: Command) => CliContext;

const HMS = /^\d{2}:\d{2}(:\d{2})?$/;

export function parseLimit(v: string | undefined, max?: number): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError('--limit must be a positive integer');
  if (max !== undefined && n > max) throw new UsageError(`--limit must be at most ${max}`);
  return n;
}

export function requireDate(v: string, flag: string): string {
  if (v === 'today') return todayInVietnam();
  if (v === 'tomorrow') return addDays(todayInVietnam(), 1);
  if (!isValidYmd(v)) throw new UsageError(`${flag} must be YYYY-MM-DD, "today" or "tomorrow" (got "${v}")`);
  return v;
}

const withSeconds = (t: string) => (t.length === 5 ? `${t}:00` : t);
const hhmm = (t: string | null | undefined) => t?.slice(0, 5);

/** Why a search result cannot be sold (`undefined` = bookable). */
export const unbookable = (v: VoyageWithAdditions) => (v.voyage ? voyageUnbookableReason(v.voyage) : 'disabled');

export const voyageColumns = [
  { header: 'VOYAGE_ID', get: (v: VoyageWithAdditions) => v.voyage?.id },
  { header: 'DATE', get: (v: VoyageWithAdditions) => v.voyage?.departure_date?.slice(0, 10) },
  { header: 'DEPART', get: (v: VoyageWithAdditions) => hhmm(v.voyage?.depart_time) },
  { header: 'ARRIVE', get: (v: VoyageWithAdditions) => hhmm(v.voyage?.arrive_time) },
  { header: 'OPERATOR', get: (v: VoyageWithAdditions) => v.voyage?.operator?.operator_name, max: 24 },
  { header: 'BOAT', get: (v: VoyageWithAdditions) => v.voyage?.boat_name, max: 22 },
  { header: 'SEATS_LEFT', get: (v: VoyageWithAdditions) => v.voyage?.no_remain },
  { header: 'FROM_PRICE', get: (v: VoyageWithAdditions) => vnd(v.voyage?.ticket_prices?.default_ticket_price) },
];

/** `MIN_AGE 1, MAX_AGE 11, NATIONAL_ID VN` → `1–11 · VN`. */
export function ageRange(rules: string | undefined): string {
  if (!rules) return '';
  const num = (key: string) => {
    const m = new RegExp(`${key}(?:_WITH_DATE)? (\\d+)`).exec(rules);
    return m ? Number(m[1]) : undefined;
  };
  const min = num('MIN_AGE');
  const max = num('MAX_AGE');
  const nat = /NATIONAL_ID (\w+)/.exec(rules)?.[1];
  const ages =
    min !== undefined && max !== undefined && max < 150
      ? `${min}–${max}`
      : min !== undefined && min > 0
        ? `${min}+`
        : max !== undefined && max < 150
          ? `≤${max}`
          : '';
  return [ages, nat ? `${nat} only` : ''].filter(Boolean).join(' · ');
}

export function registerSupplyCommands(program: Command, getCtx: GetCtx): void {
  program
    .command('locations')
    .description('List ports / islands (anonymous endpoint)')
    .argument('[query]', 'filter by name or abbreviation (accent-insensitive)')
    .action(async (query: string | undefined, _opts: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const sdk = ctx.sdk(false);
      const rows = query ? await sdk.locations.find(query) : await sdk.locations.list();
      ctx.emitList(rows, [
        { header: 'ID', get: (l) => l.id },
        { header: 'ABBR', get: (l) => l.abbreviation },
        { header: 'NAME', get: (l) => l.location_name },
        { header: 'DISABLED', get: (l) => (l.disable ? 'yes' : '') },
      ]);
    });

  program
    .command('routes')
    .description('List routes (anonymous endpoint)')
    .option('--from <location>', 'departure location (id, abbreviation or name)')
    .option('--to <location>', 'destination location (id, abbreviation or name)')
    .option('--limit <n>', 'page size (max 100)')
    .option('--cursor <cursor>', 'page cursor from a previous call')
    .option('--all', 'follow cursors and fetch every page')
    .action(
      async (opts: { from?: string; to?: string; limit?: string; cursor?: string; all?: boolean }, cmd: Command) => {
        const ctx = getCtx(cmd);
        const sdk = ctx.sdk(false);
        const filters: { departure_id?: string; destination_id?: string } = {};
        if (opts.from) filters.departure_id = (await ctx.resolveLocation(opts.from, '--from')).id;
        if (opts.to) filters.destination_id = (await ctx.resolveLocation(opts.to, '--to')).id;
        const limit = parseLimit(opts.limit, 100);
        let rows: Route[];
        let next: string | null | undefined;
        if (opts.all) {
          rows = await collect(sdk.routes.iterate({ limit: limit ?? 100, filters }));
        } else {
          const page = await sdk.routes.list({ cursor: opts.cursor, limit, filters });
          rows = page.data;
          next = page.next_cursor;
        }
        ctx.emitList(
          rows,
          [
            { header: 'ID', get: (r) => r.id },
            { header: 'FROM', get: (r) => r.departure_name },
            { header: 'TO', get: (r) => r.destination_name },
            {
              header: 'OPERATORS',
              get: (r) => (r.operators ?? []).map((o) => o.operator?.operator_name ?? o.operator_id).join(', '),
              max: 40,
            },
            { header: 'DISABLED', get: (r) => (r.disable ? 'yes' : '') },
          ],
          { nextCursor: next },
        );
      },
    );

  const operators = program.command('operators').description('Ferry operators (hãng tàu)');
  operators
    .command('list', { isDefault: true })
    .description('List operators (anonymous endpoint)')
    .action(async (_opts: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const rows = await ctx.sdk(false).operators.list();
      ctx.emitList(rows, [
        { header: 'ID', get: (o) => o.id },
        { header: 'CODE', get: (o) => o.operator_code },
        { header: 'NAME', get: (o) => o.operator_name },
      ]);
    });
  operators
    .command('nationals')
    .description('Nationalities accepted by an operator (values for a ticket `national_id`)')
    .argument('<operatorId>', 'operator id (see `ferry operators`)')
    .action(async (operatorId: string, _opts: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const rows = await ctx.sdk(false).operators.nationals(operatorId);
      ctx.emitList(rows, [
        { header: 'NATIONAL_ID', get: (n) => n.national_id },
        { header: 'ABBREV', get: (n) => n.abbrev },
        { header: 'NAME', get: (n) => n.name },
        { header: 'DEFAULT', get: (n) => (n.default ? 'yes' : '') },
      ]);
    });

  const voyages = program.command('voyages').description('Voyage (chuyến tàu) commands');
  voyages
    .command('search')
    .description('Search voyages between two locations on a date (or date range)')
    .requiredOption('--from <location>', 'departure location (id, abbreviation or name)')
    .requiredOption('--to <location>', 'destination location (id, abbreviation or name)')
    .requiredOption('--date <YYYY-MM-DD>', 'departure date (Vietnam time), or "today" / "tomorrow"')
    .option('--until <YYYY-MM-DD>', 'search a date range from --date until this date (inclusive)')
    .option('--after <HH:mm>', 'earliest departure time')
    .option('--before <HH:mm>', 'latest departure time')
    .option('--operator <id...>', 'restrict to operator id(s)')
    .option('--include-unavailable', 'also list voyages that cannot be sold (disabled, sold out, departed)')
    .option('--limit <n>', 'page size (max 50)')
    .option('--cursor <cursor>', 'page cursor from a previous call')
    .option('--all', 'follow cursors and fetch every page')
    .action(
      async (
        opts: {
          from: string;
          to: string;
          date: string;
          until?: string;
          after?: string;
          before?: string;
          operator?: string[];
          includeUnavailable?: boolean;
          limit?: string;
          cursor?: string;
          all?: boolean;
        },
        cmd: Command,
      ) => {
        const ctx = getCtx(cmd);
        const date = requireDate(opts.date, '--date');
        const until = opts.until ? requireDate(opts.until, '--until') : undefined;
        if (until && until < date) throw new UsageError('--until must not be before --date');
        for (const [flag, v] of [
          ['--after', opts.after],
          ['--before', opts.before],
        ] as const) {
          if (v && !HMS.test(v)) throw new UsageError(`${flag} must be HH:mm (got "${v}")`);
        }
        const sdk = ctx.sdk();
        const [from, to] = await Promise.all([
          ctx.resolveLocation(opts.from, '--from'),
          ctx.resolveLocation(opts.to, '--to'),
        ]);
        const filters = {
          ...(opts.after ? { min_depart_time: withSeconds(opts.after) } : {}),
          ...(opts.before ? { max_depart_time: withSeconds(opts.before) } : {}),
          ...(opts.operator ? { operator_ids: opts.operator } : {}),
        };
        const common = { departureId: from.id, destinationId: to.id, filters, limit: parseLimit(opts.limit, 50) };
        const range = until ? { from: date, to: until } : { date };
        let rows: VoyageWithAdditions[];
        let next: string | null | undefined;
        if (opts.all) {
          rows = await collect(sdk.voyages.iterate({ ...common, ...range }));
        } else {
          const page = until
            ? await sdk.voyages.searchRange({ ...common, from: date, to: until, cursor: opts.cursor })
            : await sdk.voyages.search({ ...common, date, cursor: opts.cursor });
          rows = page.data;
          next = page.next_cursor;
        }
        // The API also returns voyages the operator disabled (their seat map then
        // answers VoyageIsDisabled), sold-out and departed ones: hide them like the dashboard.
        const shown = opts.includeUnavailable ? rows : rows.filter((v) => !unbookable(v));
        const hidden = rows.length - shown.length;
        const columns = opts.includeUnavailable
          ? [...voyageColumns, { header: 'STATUS', get: (v: VoyageWithAdditions) => unbookable(v) ?? 'bookable' }]
          : voyageColumns;
        ctx.emitList(shown, columns, {
          nextCursor: next,
          footer: `${from.location_name} → ${to.location_name}: ${shown.length} bookable voyage(s)${
            hidden ? ` (${hidden} unavailable hidden — --include-unavailable to list them)` : ''
          }`,
        });
      },
    );

  program
    .command('prices')
    .description('Selling prices of a route: every voyage × seat type × ticket type, incl. harbor fees')
    .requiredOption('--from <location>', 'departure location (id, abbreviation or name)')
    .requiredOption('--to <location>', 'destination location (id, abbreviation or name)')
    .option('--date <YYYY-MM-DD>', 'departure date (Vietnam time), or "today" / "tomorrow"', 'today')
    .option('--until <YYYY-MM-DD>', 'price a date range from --date until this date (inclusive)')
    .option('--operator <id...>', 'restrict to operator id(s)')
    .option(
      '--live [n]',
      `re-price the first n voyages from their live seat map (default 3, max ${MAX_LIVE_SEAT_MAPS}; may query the operator)`,
    )
    .option('--summary', 'one line per voyage with its cheapest ticket')
    .option('--vehicles', 'also list motorbike/car places')
    .option('--all-ticket-types', 'also list ticket types the API cannot book (invitations, zero price…)')
    .option('--include-unavailable', 'also list voyages that cannot be sold')
    .addHelpText(
      'after',
      `
Prices are what your organization's customers pay (price incl. VAT and your price
additions); your cost is never returned by the API. Without --live they come from
synced voyage data and can lag the operator — --live shows the price that is charged.

Examples:
  ferry prices --from "Rạch Giá" --to "Phú Quốc" --date tomorrow
  ferry prices --from RG --to PQ --date 2026-11-01 --live 5
  ferry prices --from "Sóc Trăng" --to "Côn Đảo" --date tomorrow --until 2026-11-07 --summary --output csv`,
    )
    .action(
      async (
        opts: {
          from: string;
          to: string;
          date: string;
          until?: string;
          operator?: string[];
          live?: string | boolean;
          summary?: boolean;
          vehicles?: boolean;
          allTicketTypes?: boolean;
          includeUnavailable?: boolean;
        },
        cmd: Command,
      ) => {
        const ctx = getCtx(cmd);
        const date = requireDate(opts.date, '--date');
        const until = opts.until ? requireDate(opts.until, '--until') : undefined;
        if (until && until < date) throw new UsageError('--until must not be before --date');
        const live = opts.live === undefined ? 0 : opts.live === true ? 3 : Number(opts.live);
        if (!Number.isInteger(live) || live < 0 || live > MAX_LIVE_SEAT_MAPS) {
          throw new UsageError(`--live must be an integer from 0 to ${MAX_LIVE_SEAT_MAPS}`);
        }
        const sdk = ctx.sdk();
        const [from, to] = await Promise.all([
          ctx.resolveLocation(opts.from, '--from'),
          ctx.resolveLocation(opts.to, '--to'),
        ]);
        const result = await sdk.prices.forRoute({
          departureId: from.id,
          destinationId: to.id,
          ...(until ? { from: date, to: until } : { date }),
          ...(opts.operator ? { filters: { operator_ids: opts.operator } } : {}),
          live,
          includeVehicles: opts.vehicles,
          includeAllTicketTypes: opts.allTicketTypes,
          includeUnavailable: opts.includeUnavailable,
        });
        const when = (v: RouteVoyagePrices) => (until ? v.departure : v.departure?.slice(11));
        const notes = [
          `${from.location_name} → ${to.location_name}: ${result.voyages.length} voyage(s)${
            result.hiddenUnavailable
              ? ` (${result.hiddenUnavailable} unavailable hidden — --include-unavailable to list them)`
              : ''
          }`,
          live
            ? 'SOURCE live = price from the seat map (charged); list = synced voyage data'
            : 'Prices from synced voyage data (indicative) — add --live to price from the seat map',
          ...result.voyages
            .filter((v) => v.liveError)
            .map((v) => `${v.voyageId}: live seat map unavailable (${v.liveError}); list price shown`),
        ];
        if (ctx.format === 'json') return ctx.emit(result, () => {});
        if (opts.summary) {
          return ctx.emitList(
            result.voyages,
            [
              { header: 'VOYAGE_ID', get: (v) => v.voyageId },
              { header: until ? 'DEPART' : 'TIME', get: (v) => when(v) },
              { header: 'OPERATOR', get: (v) => v.operatorName, max: 24 },
              { header: 'BOAT', get: (v) => v.boat, max: 22 },
              { header: 'SEAT_TYPES', get: (v) => [...new Set(v.prices.map((p) => p.seatType))].join(', '), max: 30 },
              { header: 'ADULT_FROM', get: (v) => vnd(v.defaultFromVnd) },
              { header: 'FROM', get: (v) => vnd(v.fromVnd) },
              ...(live
                ? [{ header: 'SOURCE', get: (v: RouteVoyagePrices) => (v.source === 'seat-map' ? 'live' : 'list') }]
                : []),
              ...(opts.includeUnavailable
                ? [{ header: 'STATUS', get: (v: RouteVoyagePrices) => v.unavailable ?? 'bookable' }]
                : []),
            ],
            { footer: notes.join('\n') },
          );
        }
        type Row = RoutePriceEntry & { voyage: RouteVoyagePrices };
        const rows: Row[] = result.voyages.flatMap((voyage) => voyage.prices.map((p) => ({ ...p, voyage })));
        const anyHarbor = rows.some((r) => r.harborFeeVnd > 0);
        ctx.emitList(
          rows,
          [
            { header: 'VOYAGE_ID', get: (r) => r.voyage.voyageId },
            { header: until ? 'DEPART' : 'TIME', get: (r) => when(r.voyage) },
            { header: 'OPERATOR', get: (r) => r.voyage.operatorName, max: 20 },
            { header: 'SEAT_TYPE', get: (r) => (r.vehicle ? `${r.seatType} (vehicle)` : r.seatType), max: 24 },
            {
              header: 'TICKET_TYPE',
              get: (r) => `${r.ticketType} (${r.ticketTypeId})${r.bookable ? '' : ' — not bookable'}`,
              max: 40,
            },
            { header: 'AGES', get: (r) => ageRange(r.rules) },
            { header: 'PRICE', get: (r) => vnd(r.priceVnd) },
            ...(anyHarbor
              ? [
                  { header: 'HARBOR_FEE', get: (r: Row) => vnd(r.harborFeeVnd) },
                  { header: 'TOTAL', get: (r: Row) => vnd(r.totalVnd) },
                ]
              : []),
            ...(live
              ? [{ header: 'SOURCE', get: (r: Row) => (r.voyage.source === 'seat-map' ? 'live' : 'list') }]
              : []),
          ],
          { footer: notes.join('\n') },
        );
      },
    );

  program
    .command('calendar')
    .description('Number of voyages (and available ones) per day between two locations')
    .requiredOption('--from <location>', 'departure location')
    .requiredOption('--to <location>', 'destination location')
    .option('--start <YYYY-MM-DD>', 'first day (default today)', 'today')
    .option('--days <n>', 'number of days (default 14, max 62)', '14')
    .action(async (opts: { from: string; to: string; start: string; days: string }, cmd: Command) => {
      const ctx = getCtx(cmd);
      const start = requireDate(opts.start, '--start');
      const days = Number(opts.days);
      if (!Number.isInteger(days) || days < 1 || days > 62) throw new UsageError('--days must be 1–62');
      const sdk = ctx.sdk();
      const [from, to] = await Promise.all([
        ctx.resolveLocation(opts.from, '--from'),
        ctx.resolveLocation(opts.to, '--to'),
      ]);
      const rows = await sdk.voyageCounts.list({
        departureId: from.id,
        destinationId: to.id,
        from: start,
        to: addDays(start, days - 1),
      });
      ctx.emitList(
        rows,
        [
          { header: 'DATE', get: (r) => r.departure_date?.slice(0, 10) },
          { header: 'VOYAGES', get: (r) => r.total_voyage },
          { header: 'AVAILABLE', get: (r) => r.total_available_voyage },
        ],
        { footer: `${from.location_name} → ${to.location_name}` },
      );
    });

  program
    .command('seats')
    .description('Show the seat map (boat layout) and prices of a voyage')
    .argument('<voyageId>', 'voyage id (from `ferry voyages search`)')
    .option('--stored', 'use the stored layout (byVoyageId) instead of the latest refreshed one')
    .option('--all', 'list every seat, not only available ones')
    .action(async (voyageId: string, opts: { stored?: boolean; all?: boolean }, cmd: Command) => {
      const ctx = getCtx(cmd);
      const sdk = ctx.sdk();
      const layout = opts.stored
        ? await sdk.boatLayouts.byVoyageId(voyageId)
        : await sdk.boatLayouts.latestByVoyageId(voyageId);
      const map = flattenSeatMap(layout);
      const rows = opts.all ? map.seats : map.seats.filter((s) => s.available);
      const nameCount = new Map<string, number>();
      for (const s of map.seats) nameCount.set(s.seatName ?? '', (nameCount.get(s.seatName ?? '') ?? 0) + 1);
      const repeated = [...nameCount].filter(([, n]) => n > 1).map(([name]) => name);
      const seatColumns = [
        { header: 'SEAT', get: (s: (typeof rows)[number]) => s.seatName },
        { header: 'REF', get: (s: (typeof rows)[number]) => seatRef(s) },
        { header: 'TYPE', get: (s: (typeof rows)[number]) => s.seatType },
        { header: 'FLOOR', get: (s: (typeof rows)[number]) => s.floorName ?? s.floorId },
        { header: 'POSITION_ID', get: (s: (typeof rows)[number]) => s.positionId },
        { header: 'SEAT_ID', get: (s: (typeof rows)[number]) => s.seatId },
        { header: 'VIP', get: (s: (typeof rows)[number]) => (s.isVip ? 'yes' : '') },
        {
          header: 'STATUS',
          get: (s: (typeof rows)[number]) =>
            s.available ? 'free' : s.isBooked ? 'booked' : s.isHeld ? 'held' : 'exported',
        },
      ];
      if (ctx.format === 'json') return ctx.emit({ summary: { ...map, seats: rows }, layout }, () => {});
      if (ctx.format !== 'table') return ctx.emitList(rows, seatColumns);
      for (const f of map.floors) ctx.out(`${f.floorName ?? f.floorId}: ${f.available}/${f.total} available`);
      printTable(ctx.deps.stdout, rows, seatColumns);
      if (repeated.length) {
        ctx.out(
          `\nSeat names used more than once: ${repeated.join(', ')} — pass the REF (NAME#POSITION_ID) to \`ferry booking draft --seats\`.`,
        );
      }
      const configs = layout?.boatLayout?.ticket_type_configs ?? [];
      if (configs.length) {
        const byType = new Map<number, { label: string; rules: string[] }>();
        for (const c of configs) {
          const entry = byType.get(c.ticket_type_id) ?? { label: c.ticket_type_label, rules: [] };
          entry.rules.push(`${c.key_config} ${c.value_config}`);
          byType.set(c.ticket_type_id, entry);
        }
        ctx.out('\nTicket types (chosen automatically from age/nationality):');
        printTable(
          ctx.deps.stdout,
          [...byType],
          [
            { header: 'TICKET_TYPE', get: ([id, t]) => `${t.label} (${id})` },
            { header: 'RULES', get: ([, t]) => t.rules.join(', '), max: 60 },
          ],
        );
      }
      const prices = layout?.boatLayout?.prices ?? [];
      if (prices.length) {
        ctx.out('\nPrices:');
        printTable(ctx.deps.stdout, prices, [
          {
            header: 'SEAT_TYPE',
            get: (p) => (isVehicleSeatType(p.seat_type) ? `${p.seat_type} (vehicle)` : p.seat_type),
          },
          { header: 'TICKET_TYPE', get: (p) => `${p.ticket_type_label} (${p.ticket_type_id})` },
          { header: 'PRICE_ID', get: (p) => p.id },
          { header: 'PRICE', get: (p) => vnd(p.price_with_VAT) },
          { header: 'DEFAULT', get: (p) => (p.is_default ? 'yes' : '') },
        ]);
      }
    });
}
