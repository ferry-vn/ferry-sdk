/**
 * `ferry booking draft` — build a valid booking payload from seat names and a
 * passenger list (CSV from a spreadsheet, or JSON) using the SDK booking builder.
 */
import { type DraftPassenger, FerryBookingDraftError, normalizeText, type PrepareBookingInput } from '@ferryvn/sdk';
import type { Command } from 'commander';
import { type CliContext, UsageError } from '../cli-context.js';
import { printTable, vnd } from '../output.js';
import { printBooking } from './booking-commands.js';

type GetCtx = (cmd: Command) => CliContext;

/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF, BOM). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  // One delimiter per file: `;` when the header row uses it (Excel in Vietnamese/European locales), else `,`.
  const header = src.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = header.includes(';') && !header.includes(',') ? ';' : ',';
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '')
      quoted = true; // like Excel: a quote opens only at the field start
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

const COLUMN_ALIASES: Record<string, keyof DraftPassenger> = {
  name: 'name',
  full_name: 'name',
  ho_ten: 'name',
  ho_va_ten: 'name',
  ten: 'name',
  date_of_birth: 'dateOfBirth',
  dateofbirth: 'dateOfBirth',
  dob: 'dateOfBirth',
  ngay_sinh: 'dateOfBirth',
  social_id: 'socialId',
  socialid: 'socialId',
  cccd: 'socialId',
  so_cccd: 'socialId',
  cmnd: 'socialId',
  cccd_ho_chieu: 'socialId',
  ho_chieu: 'socialId',
  passport: 'socialId',
  home_town: 'homeTown',
  hometown: 'homeTown',
  que_quan: 'homeTown',
  gender: 'gender',
  gioi_tinh: 'gender',
  national_id: 'nationalId',
  nationalid: 'nationalId',
  nationality: 'nationalId',
  quoc_tich: 'nationalId',
  ticket_type_id: 'ticketTypeId',
  tickettypeid: 'ticketTypeId',
  plate_number: 'plateNumber',
  platenumber: 'plateNumber',
  bien_so: 'plateNumber',
  passport_expired_at: 'passportExpiredAt',
  passportexpiredat: 'passportExpiredAt',
};

/** `Họ tên` / `Ngày sinh` / `date of birth` → `ho_ten` / `ngay_sinh` / `date_of_birth`. */
const headerKey = (h: string) =>
  normalizeText(h)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

function parseGender(v: string): DraftPassenger['gender'] {
  const s = normalizeText(v);
  if (!s) return undefined;
  if (['1', 'm', 'male', 'nam'].includes(s)) return 'male';
  if (['0', 'f', 'female', 'nu'].includes(s)) return 'female';
  throw new UsageError(`unknown gender "${v}" (use male/female, nam/nữ or 1/0)`);
}

/** Parse passengers from CSV (header row required) or a JSON array. */
export function parsePassengers(raw: string): DraftPassenger[] {
  const text = raw.replace(/^\uFEFF/, '').trim();
  if (text.includes('\uFFFD')) {
    throw new UsageError(
      '--passengers is not UTF-8 (names would be garbled) — in Excel use Save As → "CSV UTF-8 (Comma delimited)"',
    );
  }
  if (text.startsWith('[')) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new UsageError(`--passengers is not valid JSON: ${(e as Error).message}`);
    }
    return (data as Array<Record<string, unknown>>).map((obj) => {
      const p: Record<string, unknown> = {};
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new UsageError('--passengers JSON must be an array of passenger objects');
      }
      for (const [k, v] of Object.entries(obj)) {
        p[COLUMN_ALIASES[headerKey(k)] ?? k] = typeof v === 'string' ? v.normalize('NFC') : v;
      }
      if (typeof p.gender === 'string') p.gender = parseGender(p.gender);
      if (typeof p.ticketTypeId === 'string') p.ticketTypeId = Number(p.ticketTypeId);
      return p as unknown as DraftPassenger;
    });
  }
  const [header, ...rows] = parseCsv(text);
  if (!header || !rows.length) throw new UsageError('--passengers CSV needs a header row and at least one passenger');
  // Excel leaves empty trailing columns (`name;dob;;`): ignore columns without a header.
  const keys = header.map((h) => (h.trim() ? COLUMN_ALIASES[headerKey(h)] : undefined));
  const unknown = header.filter((h, i) => h.trim() && !keys[i]);
  if (unknown.length) throw new UsageError(`--passengers: unknown column(s) ${unknown.join(', ')}`);
  return rows.map((cells) => {
    const p: Record<string, unknown> = {};
    keys.forEach((k, i) => {
      const v = (cells[i] ?? '').trim().normalize('NFC');
      if (!k || v === '') return;
      if (k === 'gender') p.gender = parseGender(v);
      else if (k === 'ticketTypeId') p.ticketTypeId = Number(v);
      else p[k] = v;
    });
    return p as unknown as DraftPassenger;
  });
}

const splitList = (v: string | undefined) =>
  v
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function registerDraftCommand(booking: Command, getCtx: GetCtx): void {
  booking
    .command('draft')
    .description('Build (and optionally create) a booking from seat names + a passenger list, validated locally')
    .requiredOption('--customer <id>', 'customer id (see `ferry customers`)')
    .requiredOption('--orderer-name <name>', 'name of the person placing the order')
    .requiredOption('--email <email>', 'contact email')
    .option('--phone <phone>', 'contact phone')
    .requiredOption('--voyage <voyageId>', 'outbound voyage id')
    .option('--seats <names>', 'outbound seat names, comma-separated (default: first free seats)')
    .option('--seat-type <type>', 'when picking seats automatically, only this seat type')
    .requiredOption('--passengers <file|->', 'CSV (header row) or JSON array of passengers; "-" for stdin')
    .option('--return-voyage <voyageId>', 'return voyage id (same passengers)')
    .option('--return-seats <names>', 'return seat names, comma-separated')
    .option('--voucher <codes>', 'voucher codes for the outbound order, comma-separated')
    .option('--out <file>', 'write the CreateBookingDto JSON to this file')
    .option('--create', 'create the booking right away (no money moves; tickets are issued separately)')
    .addHelpText(
      'after',
      `
Passenger CSV columns (header names are case-insensitive; Vietnamese aliases work):
  name, date_of_birth (YYYY-MM-DD), social_id, home_town, gender (male/female),
  national_id (optional, default Vietnam), ticket_type_id (optional, chosen by age),
  plate_number, passport_expired_at
Example:
  ferry booking draft --customer 1001 --orderer-name "Nguyễn Văn A" --email a@example.com \\
    --voyage 66f... --seats A1,A2 --passengers passengers.csv --out booking.json`,
    )
    .action(
      async (
        opts: {
          customer: string;
          ordererName: string;
          email: string;
          phone?: string;
          voyage: string;
          seats?: string;
          seatType?: string;
          passengers: string;
          returnVoyage?: string;
          returnSeats?: string;
          voucher?: string;
          out?: string;
          create?: boolean;
        },
        cmd: Command,
      ) => {
        const ctx = getCtx(cmd);
        if (opts.returnSeats && !opts.returnVoyage) throw new UsageError('--return-seats needs --return-voyage');
        const customerId = Number(opts.customer);
        if (!Number.isInteger(customerId) || customerId <= 0) throw new UsageError('--customer must be a numeric id');
        const raw = opts.passengers === '-' ? await ctx.deps.readStdin() : ctx.deps.readFile(opts.passengers);
        const passengers = parsePassengers(raw);
        const input: PrepareBookingInput = {
          customerId,
          ordererName: opts.ordererName,
          contactEmail: opts.email,
          ...(opts.phone ? { phoneNumber: opts.phone } : {}),
          depart: {
            voyageId: opts.voyage,
            seats: splitList(opts.seats),
            seatType: opts.seatType,
            passengers,
            voucherCodes: splitList(opts.voucher),
          },
          ...(opts.returnVoyage
            ? { return: { voyageId: opts.returnVoyage, seats: splitList(opts.returnSeats), passengers } }
            : {}),
        };
        const sdk = ctx.sdk();
        let draft: Awaited<ReturnType<typeof sdk.bookingDrafts.prepare>>;
        try {
          draft = await sdk.bookingDrafts.prepare(input);
        } catch (e) {
          if (e instanceof FerryBookingDraftError) throw new UsageError(e.message);
          throw e;
        }
        if (opts.out) ctx.deps.writeFile(opts.out, `${JSON.stringify(draft.input, null, 2)}\n`);
        const booking = opts.create ? await sdk.bookings.create(draft.input) : undefined;
        const full = booking ? await sdk.bookings.get(booking.id).catch(() => booking) : undefined;

        ctx.emit({ draft, ...(full ? { booking: full } : {}) }, () => {
          for (const leg of [draft.depart, draft.return].filter((l) => l !== undefined)) {
            ctx.out(`${leg.route ?? leg.voyageId}  ${leg.departure ?? ''}`);
            const repeated = new Set(leg.tickets.map((t) => t.seatName).filter((n, i, all) => all.indexOf(n) !== i));
            printTable(ctx.deps.stdout, leg.tickets, [
              { header: 'PASSENGER', get: (t) => t.passenger, max: 24 },
              { header: 'SEAT', get: (t) => (repeated.has(t.seatName) ? t.seatRef : t.seatName) },
              { header: 'SEAT_TYPE', get: (t) => t.seatType },
              { header: 'TICKET_TYPE', get: (t) => `${t.ticketType} (${t.ticketTypeId})` },
              { header: 'PRICE', get: (t) => vnd(t.priceVnd) },
              ...(leg.harborFeeTotalVnd
                ? [{ header: 'HARBOR_FEE', get: (t: (typeof leg.tickets)[number]) => vnd(t.harborFeeVnd) }]
                : []),
            ]);
            for (const v of leg.vouchers) ctx.out(`  voucher ${v.code}: −${vnd(v.discountVnd)}`);
          }
          const parts = [`tickets ${vnd(draft.estimatedTicketTotalVnd)}`];
          if (draft.estimatedHarborFeeVnd) parts.push(`harbor fees ${vnd(draft.estimatedHarborFeeVnd)}`);
          if (draft.estimatedVoucherDiscountVnd) parts.push(`vouchers −${vnd(draft.estimatedVoucherDiscountVnd)}`);
          ctx.out(
            `Estimated total: ${vnd(draft.estimatedTotalVnd)} (${parts.join(', ')}; FerryVN re-prices at creation)`,
          );
          for (const w of draft.warnings) ctx.err(`warning: ${w}`);
          if (opts.out) ctx.out(`Wrote ${opts.out} — create it with \`ferry booking create --file ${opts.out}\`.`);
          if (full) {
            ctx.out('');
            printBooking(ctx, full);
          } else if (!opts.out) {
            ctx.out('\nPayload (CreateBookingDto):');
            ctx.out(JSON.stringify(draft.input, null, 2));
          }
        });
      },
    );
}
