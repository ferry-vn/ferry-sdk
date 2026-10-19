/**
 * Booking builder: turn "voyage + seats + passengers" into a valid
 * `CreateBookingInput`, applying the same rules the backend enforces
 * (backend v3.2.16, `orders.service.ts`, `tickets.service.ts`) and quoting the
 * price the server will compute:
 *
 *  - every ticket's seat must exist on the voyage's seat map, be sellable
 *    (rendered, not booked/held/exported) and — because the server looks a seat
 *    up by its *first* name match — not share its name with a seat of another type;
 *  - `ticket_type_id` must be one of the layout's `ticket_type_configs` and the
 *    passenger must satisfy every MIN_AGE / MAX_AGE (/ _WITH_DATE) rule of that
 *    type; foreigners count as at most 35 for most operators. The operator's
 *    NATIONAL_ID rule (e.g. SuperDong elderly tickets are for Vietnamese
 *    citizens only) is applied too, although the server only checks it at issuance;
 *  - a price row must exist for (ticket type, seat type);
 *  - social ids must be unique within an order, except on the operator's child
 *    ticket types (backend `child-ticket-type-ids.config.ts`);
 *  - the operator's passenger-input rules: social id / home town length, and a
 *    passport expiry date for foreign adults when the operator requires it.
 *
 * Price quote = Σ(ticket price incl. VAT + the operator's per-ticket harbor fee
 * on the route) − vouchers, floored at 0 — the server's `total_price`.
 *
 * Validation happens locally, before anything is sent, with messages that say
 * which passenger/seat is wrong.
 */
import { nowInVietnam, todayInVietnam, toYmd } from './dates.js';
import { FerryApiError, FerryError } from './errors.js';
import type { RequestOptions } from './http.js';
import type { BookingsResource, VouchersResource } from './resources/booking-resources.js';
import type { BoatLayoutsResource } from './resources/supply-resources.js';
import { flattenSeatMap, type SeatInfo, seatRef } from './seat-map.js';
import { normalizeText } from './text.js';
import type {
  BoatLayoutWithAdditions,
  Booking,
  CreateBookingInput,
  CreateOrderInput,
  CreateTicketInput,
  OperatorNational,
  TicketPrice,
  TicketTypeConfig,
  Voyage,
} from './types.js';
import { voyageDeparture } from './voyage-utils.js';

/** Thrown when a draft cannot be built; `issues` lists every problem found. */
export class FerryBookingDraftError extends FerryError {
  constructor(readonly issues: string[]) {
    super(`booking draft is invalid:\n- ${issues.join('\n- ')}`);
    this.name = 'FerryBookingDraftError';
  }
}

export interface DraftPassenger {
  /** Full name as on the ID card / passport. */
  name: string;
  /** `YYYY-MM-DD`. */
  dateOfBirth: string;
  /** CCCD/CMND (Vietnamese) or passport number. */
  socialId: string;
  /** Home town / province. Operators limit its length (often 3–15 characters). */
  homeTown: string;
  gender?: 'male' | 'female' | 0 | 1 | undefined;
  /**
   * Nationality: the operator's `national_id`, or an ISO 3166 alpha-2 code /
   * country name as the operator spells it (`"VN"`, `"US"`, `"United States"`) resolved against
   * `ferry.operators.nationals(operatorId)`. Defaults to Vietnam.
   */
  nationalId?: string | number | undefined;
  /** Force a ticket type; by default it is chosen from the passenger's age and nationality. */
  ticketTypeId?: number | undefined;
  /** Vehicle plate (only when travelling with a vehicle). */
  plateNumber?: string | null | undefined;
  /** `YYYY-MM-DD`, required by some operators for foreign adults. */
  passportExpiredAt?: string | null | undefined;
  /** Override the child flag sent to the operator (default: derived from the ticket type). */
  isChild?: boolean | undefined;
}

export interface DraftLeg {
  voyageId: string;
  /**
   * One seat per passenger, in the same order: a seat name (`"A1"`), or
   * `"NAME#POSITION_ID"` / `"#POSITION_ID"` (see `seatRef()`) when several seats
   * share a name. Omit to pick seats automatically.
   */
  seats?: string[] | undefined;
  /**
   * When picking seats automatically, only use this seat type (e.g. `ECO`,
   * `VIP`). Default: the cheapest seat type with enough free seats.
   */
  seatType?: string | undefined;
  passengers: DraftPassenger[];
  voucherCodes?: string[] | undefined;
}

export interface PrepareBookingInput {
  /** Id of an existing customer of your organization (`ferry.customers`). */
  customerId: number;
  ordererName: string;
  contactEmail: string;
  phoneNumber?: string | undefined;
  /** ISO 3166 alpha-2, e.g. `VN` (not `+84`). */
  phoneCountryCode?: string | undefined;
  depart: DraftLeg;
  return?: DraftLeg | undefined;
  /**
   * Check voucher codes with `vouchers.checkApplicability` (read-only) and
   * include their discount in the quote. Default `true`.
   */
  checkVouchers?: boolean | undefined;
}

export interface DraftTicketSummary {
  passenger: string;
  seatName: string;
  /** `NAME#POSITION_ID` — unambiguous even when seat names repeat. */
  seatRef: string;
  seatType: string;
  floor: string | undefined;
  ticketTypeId: number;
  ticketType: string;
  isChild: boolean;
  /** Ticket price incl. VAT for this ticket type and seat type. */
  priceVnd: number;
  /** The operator's per-ticket harbor fee on this route. */
  harborFeeVnd: number;
}

export interface DraftVoucherSummary {
  code: string;
  /** `flat` or `percentage` (of tickets + harbor fees). */
  amountType: string | undefined;
  amount: number | undefined;
  discountVnd: number;
}

export interface DraftLegSummary {
  voyageId: string;
  operatorCode: string | undefined;
  route: string | undefined;
  /** `YYYY-MM-DD HH:mm` (Vietnam time). */
  departure: string | undefined;
  tickets: DraftTicketSummary[];
  ticketTotalVnd: number;
  harborFeeTotalVnd: number;
  /** `ticketTotalVnd + harborFeeTotalVnd`. */
  subtotalVnd: number;
  /** Filled by `bookingDrafts.prepare()` when vouchers are checked. */
  vouchers: DraftVoucherSummary[];
  voucherDiscountVnd: number;
  /** `max(subtotal − vouchers, 0)` — the order's `total_price` as the server computes it. */
  totalVnd: number;
}

export interface BookingDraft {
  /** Ready to pass to `ferry.bookings.create()`. */
  input: CreateBookingInput;
  depart: DraftLegSummary;
  return?: DraftLegSummary;
  estimatedTicketTotalVnd: number;
  estimatedHarborFeeVnd: number;
  estimatedVoucherDiscountVnd: number;
  /**
   * Customer price of the booking (tickets + harbor fees − vouchers). Indicative:
   * the server re-prices at creation and refuses issuance if the price changed.
   */
  estimatedTotalVnd: number;
  warnings: string[];
}

/** Child ticket type ids per operator (backend `child-ticket-type-ids.config.ts`). */
export const CHILD_TICKET_TYPE_IDS: Readonly<Record<string, readonly number[]>> = {
  phuquocexpress: [2],
  greenlines: [2],
  hoabinhship: [2],
  phuquyexpress: [2],
  mailinhexpress: [2],
  superdong: [4],
  lightning68: [2],
};

/** Operators that do not cap foreigners' age at 35 (backend `tickets.service.ts`). */
const NO_FOREIGNER_AGE_CAP = new Set(['greenlines', 'binhanhatien', 'thanhthoi', 'lightning68']);
const AGE_KEYS = new Set(['MIN_AGE', 'MAX_AGE', 'MIN_AGE_WITH_DATE', 'MAX_AGE_WITH_DATE']);
/** Ticket types that need paperwork or are complimentary: never picked automatically. */
const MANUAL_ONLY_KEYS = new Set(['REQUIRE_UPLOAD_FILE', 'FOC_OFFER']);
const CHILD_LABEL = /tre em|child|em be|infant/;

/**
 * Seat types that are vehicle places, not passenger seats: some operators
 * (Thạnh Thới, Bình An Hà Tiên) sell motorbike/car slots as seat types such as
 * `Xe gắn máy`, `XEMAY<195`, `OTO4-5`, often cheaper than a passenger seat.
 */
export function isVehicleSeatType(seatType: string | null | undefined): boolean {
  const t = normalizeText(seatType ?? '').replace(/[^a-z0-9]+/g, ' ');
  return /(^| )(xe|o ?to|xemay|moto|mo to|car|motorbike|vehicle)(?=$| |\d)/.test(t);
}

export interface AgeContext {
  today: string;
  operatorCode: string | undefined;
  isForeigner: boolean;
  /** Passenger's nationality (`abbrev`, e.g. `VN`), for NATIONAL_ID rules. */
  nationalAbbrev?: string | undefined;
}

/**
 * Same arithmetic as the backend's `TicketsService.checkConfig`, plus the
 * NATIONAL_ID rule (value = the nationality abbrev the type is reserved for).
 */
export function satisfiesTicketTypeRule(dateOfBirth: string, rule: TicketTypeConfig, ctx: AgeContext): boolean {
  if (rule.key_config === 'NATIONAL_ID') {
    const abbrev = ctx.nationalAbbrev ?? (ctx.isForeigner ? undefined : 'VN');
    return abbrev !== undefined && abbrev.toUpperCase() === String(rule.value_config).trim().toUpperCase();
  }
  const [cy, cm, cd] = ctx.today.split('-').map(Number) as [number, number, number];
  const [by, bm, bd] = dateOfBirth.split('-').map(Number) as [number, number, number];
  let yearOld = cy - by;
  let yearOldWithDate = yearOld;
  if (cm < bm || (cm === bm && cd < bd)) yearOldWithDate--;
  if (ctx.isForeigner && !NO_FOREIGNER_AGE_CAP.has(ctx.operatorCode ?? '')) yearOld = Math.min(yearOld, 35);
  if (ctx.isForeigner && ctx.operatorCode === 'phuquyexpress') yearOld = Math.max(yearOld, 8);
  const v = Number(rule.value_config);
  switch (rule.key_config) {
    case 'MIN_AGE':
      return yearOld >= v;
    case 'MAX_AGE':
      return yearOld <= v;
    case 'MIN_AGE_WITH_DATE':
      return yearOldWithDate >= v;
    case 'MAX_AGE_WITH_DATE':
      return yearOldWithDate <= v;
    default:
      return true;
  }
}

/**
 * The operator's per-ticket harbor fee on the voyage's route (what the server
 * adds to every ticket): `route.operators[operator_id = voyage.operator_id].harbor_fee`.
 */
export function voyageHarborFee(voyage: Voyage | null | undefined): number {
  const operators = (voyage?.route as { operators?: Array<{ operator_id?: string; harbor_fee?: number }> } | undefined)
    ?.operators;
  const fee = Number(operators?.find((o) => o.operator_id === voyage?.operator_id)?.harbor_fee ?? 0);
  return Number.isFinite(fee) && fee > 0 ? fee : 0;
}

/**
 * Resolve a nationality given as the operator's `national_id`, an ISO alpha-2
 * code or a country name. Without `value`, returns Vietnam (`abbrev` VN), then
 * the operator's default. `undefined` when nothing matches.
 */
export function resolveNational(
  nationals: readonly OperatorNational[],
  value?: string | number | null,
): OperatorNational | undefined {
  if (value === undefined || value === null || value === '') {
    return nationals.find((n) => n.abbrev?.toUpperCase() === 'VN') ?? nationals.find((n) => n.default);
  }
  const s = String(value).trim();
  return (
    nationals.find((n) => String(n.national_id) === s) ??
    nationals.find((n) => n.abbrev?.toUpperCase() === s.toUpperCase()) ??
    nationals.find((n) => normalizeText(n.name ?? '') === normalizeText(s))
  );
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function ymdOrIssue(value: string | null | undefined, label: string, issues: string[]): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  try {
    return toYmd(value);
  } catch {
    issues.push(`${label}: expected YYYY-MM-DD, got "${value}"`);
    return undefined;
  }
}

interface LengthRule {
  min_length?: number;
  max_length?: number;
}
interface InputRule {
  enable?: boolean;
  required?: boolean;
  validation?: LengthRule;
}
type PassengerInputRules = Partial<Record<'full_name' | 'social_id' | 'address' | 'passport_expired_at', InputRule>>;

/** The server checks a length rule only when both bounds are set (non-zero). */
function lengthIssue(value: string, rule: LengthRule | undefined): string | undefined {
  const min = rule?.min_length;
  const max = rule?.max_length;
  if (!min || !max) return undefined;
  if (value.length < min || value.length > max) return `must be ${min}–${max} characters (got ${value.length})`;
  return undefined;
}

const hhmm = (t: string | undefined) => (t ? t.slice(0, 5) : '');
const fmtRules = (rules: TicketTypeConfig[]) =>
  rules
    .filter((r) => AGE_KEYS.has(r.key_config) || r.key_config === 'NATIONAL_ID')
    .map((r) => `${r.key_config} ${r.value_config}`)
    .join(', ');

export interface BuildLegArgs {
  leg: DraftLeg;
  layout: BoatLayoutWithAdditions;
  voyage?: Voyage | undefined;
  /** Operator nationality list; needed to default/resolve `nationalId` and detect foreigners. */
  nationals?: OperatorNational[] | undefined;
  /** "Today" for age rules (default: today in Vietnam). */
  today?: string | undefined;
  /** Current time, to refuse voyages that already left (default: now). */
  now?: Date | undefined;
  /** Label used in messages, e.g. "depart". */
  label?: string | undefined;
}

interface SeatPick {
  seats: Array<SeatInfo | undefined>;
}

/**
 * Pure, offline part of the builder: validate one leg against its seat map and
 * produce `CreateTicketInput`s plus a price quote (without vouchers). Throws
 * `FerryBookingDraftError`.
 */
export function buildLegTickets(args: BuildLegArgs): {
  tickets: CreateTicketInput[];
  summary: DraftLegSummary;
  warnings: string[];
} {
  const { leg, layout, voyage } = args;
  const label = args.label ?? 'leg';
  const issues: string[] = [];
  const warnings: string[] = [];
  const today = args.today ?? todayInVietnam();
  const bl = layout?.boatLayout;
  const map = flattenSeatMap(layout);
  const prices: TicketPrice[] = bl?.prices ?? [];
  const layoutConfigs: TicketTypeConfig[] = bl?.ticket_type_configs ?? [];
  // Seen in production (Thạnh Thới): the seat map carries no rules while the voyage does.
  const voyageConfigs =
    (voyage?.ticket_prices as { ticket_type_configs?: TicketTypeConfig[] } | undefined)?.ticket_type_configs ?? [];
  const configs: TicketTypeConfig[] = layoutConfigs.length ? layoutConfigs : voyageConfigs;
  const operatorCode = voyage?.operator?.operator_code ?? undefined;
  const nationals = args.nationals ?? [];
  const inputRules = (voyage?.operator?.configs as { passenger_inputs?: PassengerInputRules } | undefined)
    ?.passenger_inputs;
  const harborFee = voyageHarborFee(voyage);
  const passengers = leg.passengers ?? [];

  if (!leg.voyageId) issues.push(`${label}: voyageId is required`);
  if (!passengers.length) issues.push(`${label}: at least one passenger is required`);
  if (bl?.voyage_id && leg.voyageId && bl.voyage_id !== leg.voyageId) {
    issues.push(`${label}: seat map belongs to voyage ${bl.voyage_id}, not ${leg.voyageId}`);
  }
  if (voyage?.disable) issues.push(`${label}: voyage ${voyage.id} is disabled by the operator and cannot be booked`);
  if (voyage?.operator?.is_enabled === false) {
    issues.push(`${label}: operator ${operatorCode ?? voyage.operator_id} is disabled`);
  }
  const departDate = voyage?.departure_date ? String(voyage.departure_date).slice(0, 10) : undefined;
  // The server only books voyages whose `departure_date depart_time` is still ahead (VoyageNotExists).
  const departure = voyage ? voyageDeparture(voyage) : undefined;
  const departed =
    departure !== undefined &&
    (departure.length === 16 ? departure <= nowInVietnam(args.now) : departure.slice(0, 10) < today);
  if (departed) issues.push(`${label}: voyage ${voyage?.id} already departed (${departure})`);
  if (!prices.length) issues.push(`${label}: the seat map has no prices — this voyage cannot be booked now`);
  if (!layoutConfigs.length && prices.length && passengers.length) {
    warnings.push(
      `${label}: the seat map has no ticket-type rules; FerryVN checks ticket types against them and may refuse this booking (InvalidTicketTypeId)${
        voyageConfigs.length ? ' — ticket types were chosen with the rules published on the voyage' : ''
      }`,
    );
  }

  // The server finds a seat's type by the first cell carrying its name (all floors, in order).
  const serverTypeByName = new Map<string, string | undefined>();
  for (const floor of bl?.floors ?? []) {
    (floor.SeatNames ?? []).forEach((name, i) => {
      if (name != null && !serverTypeByName.has(name)) serverTypeByName.set(name, floor.SeatTypes?.[i]);
    });
  }
  const serverAccepts = (s: SeatInfo) => serverTypeByName.get(s.seatName ?? '') === s.seatType;
  const pricedSeatType = (t: string | undefined) => prices.some((p) => p.seat_type === t && p.price_with_VAT > 0);

  // Auto-pick only seat types where every passenger has a priced ticket type their age allows.
  const fitsSeatType = (seatType: string): boolean =>
    (leg.passengers ?? []).every((p) => {
      if (!p || typeof p.dateOfBirth !== 'string' || !YMD.test(p.dateOfBirth) || !configs.length) return true;
      const national = nationals.length ? resolveNational(nationals, p.nationalId) : undefined;
      const ctx: AgeContext = {
        today,
        operatorCode,
        isForeigner: national ? national.abbrev !== 'VN' : false,
        nationalAbbrev: national?.abbrev,
      };
      return [...new Set(configs.map((c) => c.ticket_type_id))].some(
        (t) =>
          prices.some((pr) => pr.ticket_type_id === t && pr.seat_type === seatType && pr.price_with_VAT > 0) &&
          configs.filter((c) => c.ticket_type_id === t).every((r) => satisfiesTicketTypeRule(p.dateOfBirth, r, ctx)),
      );
    });
  const { seats } = leg.seats?.length
    ? resolveRequestedSeats(leg, map.seats, label, issues, serverAccepts)
    : prices.length
      ? autoPickSeats(leg, map.seats, label, issues, warnings, serverAccepts, pricedSeatType, prices, fitsSeatType)
      : { seats: [] };

  // ── Passengers ───────────────────────────────────────────────────────
  const tickets: CreateTicketInput[] = [];
  const summaries: DraftTicketSummary[] = [];
  const socialIds = new Map<string, string>();
  const configTypeIds = [...new Set(configs.map((c) => c.ticket_type_id))];
  const rulesOf = (t: number) => configs.filter((c) => c.ticket_type_id === t);
  const typeLabelOf = (t: number) =>
    prices.find((pr) => pr.ticket_type_id === t)?.ticket_type_label ?? rulesOf(t)[0]?.ticket_type_label ?? String(t);
  const childTypes = operatorCode ? CHILD_TICKET_TYPE_IDS[operatorCode] : undefined;

  passengers.forEach((p, i) => {
    if (!p || typeof p !== 'object') {
      issues.push(`${label} passenger ${i + 1}: expected an object with name, dateOfBirth, socialId and homeTown`);
      return;
    }
    const who = `${label} passenger ${i + 1}${typeof p.name === 'string' && p.name ? ` (${p.name})` : ''}`;
    let fieldsOk = true;
    for (const [field, value] of [
      ['name', p.name],
      ['socialId', p.socialId],
      ['homeTown', p.homeTown],
    ] as const) {
      if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
        issues.push(`${who}: ${field} is required`);
        fieldsOk = false;
      } else if (typeof value !== 'string') {
        // A number would silently lose leading zeros (CCCD numbers start with 0).
        issues.push(`${who}: ${field} must be text, got ${typeof value} — quote it (e.g. "079090000001")`);
        fieldsOk = false;
      }
    }
    if (!fieldsOk) return;
    if (!p.dateOfBirth || !YMD.test(p.dateOfBirth)) {
      issues.push(`${who}: dateOfBirth must be YYYY-MM-DD`);
      return;
    }
    const dob = ymdOrIssue(p.dateOfBirth, `${who} dateOfBirth`, issues);
    const passportExpiredAt = ymdOrIssue(p.passportExpiredAt, `${who} passportExpiredAt`, issues);
    if (!dob) return;
    if (dob > today) issues.push(`${who}: dateOfBirth is in the future`);

    const socialId = p.socialId.trim();
    const homeTown = p.homeTown.trim();
    const socialIdLength = lengthIssue(socialId, inputRules?.social_id?.validation);
    if (socialIdLength) issues.push(`${who}: socialId ${socialIdLength} for ${operatorCode ?? 'this operator'}`);
    const nameLength = lengthIssue(p.name.trim(), inputRules?.full_name?.validation);
    if (nameLength) {
      warnings.push(
        `${who}: the operator's rule for names is ${nameLength.replace('must be ', '')} — FerryVN does not check it when the booking is created, the operator may at issuance`,
      );
    }
    const homeTownLength = lengthIssue(homeTown, inputRules?.address?.validation);
    if (homeTownLength) {
      issues.push(
        `${who}: homeTown ${homeTownLength} for ${operatorCode ?? 'this operator'} — use a short province name, e.g. "TP.HCM", "Cần Thơ"`,
      );
    }

    // Nationality: the operator's own ids differ ("1", "VN", "Viet Nam"), so resolve.
    let nationalId: string;
    let national: OperatorNational | undefined;
    if (nationals.length) {
      national = resolveNational(nationals, p.nationalId);
      if (!national) {
        const accepted = nationals
          .slice(0, 12)
          .map((n) => n.abbrev || String(n.national_id))
          .join(', ');
        issues.push(
          p.nationalId === undefined || p.nationalId === null || p.nationalId === ''
            ? `${who}: nationalId is required (the operator has no Vietnam entry; see ferry.operators.nationals())`
            : `${who}: nationality "${p.nationalId}" is not accepted by ${operatorCode ?? 'this operator'} (accepted: ${accepted}${nationals.length > 12 ? ', …' : ''})`,
        );
        return;
      }
      nationalId = String(national.national_id);
    } else {
      if (p.nationalId === undefined || p.nationalId === null || p.nationalId === '') {
        issues.push(`${who}: nationalId is required (see ferry.operators.nationals(operatorId))`);
        return;
      }
      nationalId = String(p.nationalId);
    }
    const isForeigner = national ? national.abbrev !== 'VN' : false;
    if (isForeigner && (voyage?.route as { isVietnameseOnly?: boolean } | undefined)?.isVietnameseOnly) {
      warnings.push(
        `${who}: this route is marked Vietnamese-only; the operator may refuse a ${national?.abbrev} passenger`,
      );
    }

    const seat = seats[i];
    if (!seat) return; // seat problem already reported
    const seatType = seat.seatType ?? '';
    if (isVehicleSeatType(seatType) && !p.plateNumber) {
      warnings.push(`${who}: seat ${seatRef(seat)} is a vehicle place (${seatType}) but no plateNumber was given`);
    }

    // ── Ticket type ──
    // The server's price loop has no `break`: with repeated rows the last match wins.
    const priced = (t: number) =>
      [...prices].reverse().find((pr) => pr.ticket_type_id === t && pr.seat_type === seatType);
    const ageCtx: AgeContext = { today, operatorCode, isForeigner, nationalAbbrev: national?.abbrev };
    const passes = (t: number) => rulesOf(t).every((r) => satisfiesTicketTypeRule(dob, r, ageCtx));
    let ticketTypeId = p.ticketTypeId;
    if (ticketTypeId !== undefined) {
      if (configTypeIds.length && !configTypeIds.includes(ticketTypeId)) {
        issues.push(
          `${who}: ticket type ${ticketTypeId} is not offered on this voyage (types: ${configTypeIds.map((t) => `${t} ${typeLabelOf(t)}`).join(', ')})`,
        );
        return;
      }
      if (!passes(ticketTypeId)) {
        issues.push(
          `${who}: age/nationality does not match the rules of ticket type ${ticketTypeId} ${typeLabelOf(ticketTypeId)} (${fmtRules(rulesOf(ticketTypeId))})`,
        );
        return;
      }
    } else if (configTypeIds.length) {
      const fitting = configTypeIds.filter(
        (t) => passes(t) && !rulesOf(t).some((r) => MANUAL_ONLY_KEYS.has(r.key_config)),
      );
      const candidates = fitting.filter((t) => (priced(t)?.price_with_VAT ?? 0) > 0);
      if (!candidates.length) {
        const minAges = configs
          .filter((c) => String(c.key_config ?? '').startsWith('MIN_AGE'))
          .map((c) => Number(c.value_config));
        const youngest = minAges.length ? Math.min(...minAges) : undefined;
        const ageYears = Number(today.slice(0, 4)) - Number(dob.slice(0, 4));
        const hint =
          youngest !== undefined && Number.isFinite(youngest) && ageYears < youngest
            ? ` — younger than every ticket type (from ${youngest}); infants usually travel without a ticket, check with the operator`
            : fitting.length
              ? ` — matching type(s) ${fitting.join(', ')} have no price on seat type ${seatType}; pick another seat type`
              : '';
        issues.push(`${who}: no ticket type matches this passenger's age for seat type ${seatType}${hint}`);
        return;
      }
      // Most specific (has age rules) first, then the cheapest valid type.
      const ranked = [...candidates].sort((a, b) => {
        const ar = rulesOf(a).some((r) => AGE_KEYS.has(r.key_config)) ? 0 : 1;
        const br = rulesOf(b).some((r) => AGE_KEYS.has(r.key_config)) ? 0 : 1;
        if (ar !== br) return ar - br;
        return (priced(a)?.price_with_VAT ?? 0) - (priced(b)?.price_with_VAT ?? 0);
      });
      ticketTypeId = ranked[0]!;
      if (ranked.length > 1) {
        warnings.push(
          `${who}: several ticket types fit (${ranked.map((t) => `${t} ${typeLabelOf(t)} ${priced(t)?.price_with_VAT}`).join(', ')}); chose the cheapest, ${ticketTypeId} — pass ticketTypeId to override`,
        );
      }
    } else {
      // No published age rules: pick the default type (the server may still refuse it, see the warning above).
      const options = prices.filter((pr) => pr.seat_type === seatType && pr.price_with_VAT > 0);
      // Vehicle places price every ticket type the same: any of them charges the right amount.
      const samePrice = options.length > 0 && options.every((o) => o.price_with_VAT === options[0]!.price_with_VAT);
      const chosen =
        options.length === 1
          ? options[0]
          : (options.find((pr) => pr.is_default) ??
            (samePrice ? [...options].sort((a, b) => a.ticket_type_id - b.ticket_type_id)[0] : undefined));
      if (!chosen) {
        issues.push(
          `${who}: the operator publishes no age rules; pass ticketTypeId (options for ${seatType}: ${options.map((o) => `${o.ticket_type_id} ${o.ticket_type_label}`).join(', ') || 'none'})`,
        );
        return;
      }
      ticketTypeId = chosen.ticket_type_id;
      if (options.length > 1 && !samePrice) {
        warnings.push(
          `${who}: the operator publishes no age rules; used the default ticket type ${ticketTypeId} ${chosen.ticket_type_label} — pass ticketTypeId for children/elderly`,
        );
      }
    }
    const price = priced(ticketTypeId);
    if (!price) {
      issues.push(`${who}: no price for ticket type ${ticketTypeId} on seat type ${seatType} (seat ${seatRef(seat)})`);
      return;
    }
    const typeLabel = price.ticket_type_label ?? typeLabelOf(ticketTypeId);
    // The server's social-id exemption only covers its table; the operator flag may use the label.
    const socialIdExempt = childTypes?.includes(ticketTypeId) ?? false;
    const isChild = p.isChild ?? (childTypes ? socialIdExempt : CHILD_LABEL.test(normalizeText(typeLabel)));

    if (!socialIdExempt) {
      // The server compares social ids exactly (a Set of the strings sent).
      const key = socialId;
      const other = socialIds.get(key);
      if (other)
        issues.push(`${who}: social id ${socialId} is also used by ${other} (only child tickets may share one)`);
      else socialIds.set(key, who);
    }
    const passport = inputRules?.passport_expired_at;
    if (
      passport?.enable &&
      passport.required &&
      !socialIdExempt &&
      national &&
      !national.default &&
      !passportExpiredAt
    ) {
      issues.push(
        `${who}: passportExpiredAt is required by ${operatorCode ?? 'this operator'} for nationality ${national.abbrev || national.national_id} (not the operator's default)`,
      );
    }

    const gender = p.gender === 'male' ? 1 : p.gender === 'female' ? 0 : p.gender;
    tickets.push({
      name: p.name.trim(),
      date_of_birth: dob,
      social_id: socialId,
      national_id: nationalId,
      home_town: homeTown,
      ...(gender === undefined ? {} : { gender }),
      plate_number: p.plateNumber ?? null,
      ...(passportExpiredAt ? { passport_expired_at: passportExpiredAt } : {}),
      is_child: isChild,
      is_vip: seat.isVip,
      seat_id: String(seat.seatId ?? ''),
      seat_name: seat.seatName ?? '',
      position_id: String(seat.positionId ?? ''),
      floor_id: seat.floorId,
      sort_auto: seat.sortAuto ?? 0,
      seat_type_code: seatType,
      ticket_type_id: ticketTypeId,
      ticket_price_id: price.id,
    } as CreateTicketInput);
    summaries.push({
      passenger: p.name.trim(),
      seatName: seat.seatName ?? '',
      seatRef: seatRef(seat),
      seatType,
      floor: seat.floorName ?? seat.floorId,
      ticketTypeId,
      ticketType: typeLabel,
      isChild,
      priceVnd: price.price_with_VAT,
      harborFeeVnd: harborFee,
    });
  });

  if (!issues.length && tickets.length !== passengers.length) {
    issues.push(`${label}: built ${tickets.length} ticket(s) for ${passengers.length} passenger(s)`);
  }
  if (issues.length) throw new FerryBookingDraftError(issues);
  const route = voyage?.route ? `${voyage.route.departure_name} → ${voyage.route.destination_name}` : undefined;
  const ticketTotalVnd = summaries.reduce((n, t) => n + (t.priceVnd ?? 0), 0);
  const harborFeeTotalVnd = summaries.reduce((n, t) => n + t.harborFeeVnd, 0);
  return {
    tickets,
    warnings,
    summary: {
      voyageId: leg.voyageId,
      operatorCode,
      route,
      departure: voyage ? `${departDate ?? ''} ${hhmm(voyage.depart_time)}`.trim() : undefined,
      tickets: summaries,
      ticketTotalVnd,
      harborFeeTotalVnd,
      subtotalVnd: ticketTotalVnd + harborFeeTotalVnd,
      vouchers: [],
      voucherDiscountVnd: 0,
      totalVnd: ticketTotalVnd + harborFeeTotalVnd,
    },
  };
}

function seatProblem(seat: SeatInfo): string | undefined {
  if (seat.isBooked) return 'booked';
  if (seat.isHeld) return 'held';
  if (seat.isExported) return 'already issued';
  return undefined;
}

function resolveRequestedSeats(
  leg: DraftLeg,
  all: SeatInfo[],
  label: string,
  issues: string[],
  serverAccepts: (s: SeatInfo) => boolean,
): SeatPick {
  const requested = leg.seats ?? [];
  const count = leg.passengers?.length ?? 0;
  if (requested.length !== count) {
    issues.push(`${label}: ${requested.length} seat(s) for ${count} passenger(s) — give one seat per passenger`);
  }
  const used = new Set<SeatInfo>();
  const seats: Array<SeatInfo | undefined> = [];
  for (const raw of requested) {
    const ref = String(raw ?? '').trim();
    const hash = ref.lastIndexOf('#');
    const namePart = hash >= 0 ? ref.slice(0, hash).trim() : ref;
    const posPart = hash >= 0 ? ref.slice(hash + 1).trim() : '';
    let matches = all.filter(
      (s) =>
        (!namePart || normalizeText(s.seatName ?? '') === normalizeText(namePart)) &&
        (!posPart || String(s.positionId ?? '') === posPart),
    );
    if (!namePart && !posPart) matches = [];
    // A repeated name where only one seat is still free: that is the one meant.
    if (matches.length > 1 && !posPart) {
      const free = matches.filter((s) => !seatProblem(s));
      if (free.length === 1) matches = free;
    }
    let seat: SeatInfo | undefined;
    if (!matches.length) {
      issues.push(`${label}: seat ${ref || '(empty)'} does not exist on this boat`);
    } else if (matches.length > 1 && matches.every((s) => seatProblem(s))) {
      issues.push(`${label}: seat ${ref} is taken (${matches.length} seats share the name, none is free)`);
    } else if (matches.length > 1) {
      const refs = matches.map((s) => `${seatRef(s)}${s.floorName ? ` (${s.floorName})` : ''}`).join(', ');
      issues.push(
        `${label}: seat ${ref} is ambiguous — ${matches.length} seats share it: ${refs}; use NAME#POSITION_ID`,
      );
    } else {
      seat = matches[0]!;
      const problem = seatProblem(seat);
      if (used.has(seat)) {
        issues.push(`${label}: seat ${ref} is listed twice`);
        seat = undefined;
      } else if (problem) {
        issues.push(`${label}: seat ${ref} is ${problem}`);
        seat = undefined;
      } else if (!serverAccepts(seat)) {
        issues.push(
          `${label}: seat ${seatRef(seat)} shares its name with a seat of another type; the server would reject it (InvalidSeatType) — choose another seat`,
        );
        seat = undefined;
      }
      if (matches[0]) used.add(matches[0]);
    }
    seats.push(seat);
  }
  return { seats };
}

/** Floor order, then the operator's auto-assign order (when set), then row/column. */
function seatOrder(): (a: SeatInfo, b: SeatInfo) => number {
  const sortKey = (s: SeatInfo) => (s.sortAuto && s.sortAuto > 0 ? s.sortAuto : Number.MAX_SAFE_INTEGER);
  return (a, b) =>
    a.floorIndex - b.floorIndex ||
    sortKey(a) - sortKey(b) ||
    (a.row ?? 0) - (b.row ?? 0) ||
    (a.col ?? 0) - (b.col ?? 0);
}

function autoPickSeats(
  leg: DraftLeg,
  all: SeatInfo[],
  label: string,
  issues: string[],
  warnings: string[],
  serverAccepts: (s: SeatInfo) => boolean,
  pricedSeatType: (t: string | undefined) => boolean,
  prices: TicketPrice[],
  fitsSeatType: (seatType: string) => boolean = () => true,
): SeatPick {
  const n = leg.passengers?.length ?? 0;
  if (!n) return { seats: [] };
  const usable = (s: SeatInfo) => s.available && serverAccepts(s) && pricedSeatType(s.seatType);
  const wanted = leg.seatType?.trim().toUpperCase();
  const allTypes = [...new Set(all.map((s) => s.seatType).filter((t): t is string => Boolean(t)))];
  if (wanted && !allTypes.some((t) => t.toUpperCase() === wanted)) {
    issues.push(`${label}: no seats of type ${leg.seatType} on this boat (types: ${allTypes.join(', ') || 'none'})`);
    return { seats: [] };
  }
  // Passenger seat types: those the operator prices by default, never vehicle places.
  const priced = [...new Set(prices.filter((p) => p.price_with_VAT > 0).map((p) => p.seat_type))];
  const withDefault = priced.filter(
    (t) => !isVehicleSeatType(t) && prices.some((p) => p.seat_type === t && p.is_default),
  );
  const nonVehicle = priced.filter((t) => !isVehicleSeatType(t));
  const passengerTypes = new Set(withDefault.length ? withDefault : nonVehicle.length ? nonVehicle : priced);
  const freeByType = new Map<string, number>();
  for (const s of all) if (usable(s)) freeByType.set(s.seatType!, (freeByType.get(s.seatType!) ?? 0) + 1);
  const typePrice = (t: string) => {
    const rows = prices.filter((p) => p.seat_type === t && p.price_with_VAT > 0);
    return (rows.find((p) => p.is_default) ?? rows.sort((a, b) => a.price_with_VAT - b.price_with_VAT)[0])
      ?.price_with_VAT;
  };
  const roomyAmong = (allowed: Set<string>) =>
    [...freeByType.keys()]
      .filter((t) => (wanted ? t.toUpperCase() === wanted : allowed.has(t)))
      .filter((t) => (freeByType.get(t) ?? 0) >= n)
      .sort((a, b) => (typePrice(a) ?? Infinity) - (typePrice(b) ?? Infinity));
  const roomy = roomyAmong(passengerTypes);
  // Prefer a seat type every passenger can get a ticket for — first among the default-priced
  // types, then any passenger type (e.g. Hoà Bình VIP is the only type with an infant price).
  // Otherwise keep the cheapest so the per-passenger issues explain what is missing.
  let types = roomy.filter(fitsSeatType);
  if (!types.length && !wanted) {
    types = roomyAmong(new Set(nonVehicle)).filter(fitsSeatType);
    if (types.length && roomy.length) {
      warnings.push(`${label}: picked seat type ${types[0]} — not every passenger has a ticket type on ${roomy[0]}`);
    }
  }
  if (!types.length) types = roomy;
  const chosenType = types[0];
  if (!chosenType) {
    const counts = allTypes
      .filter((t) => (wanted ? t.toUpperCase() === wanted : passengerTypes.has(t)))
      .map((t) => `${t}: ${freeByType.get(t) ?? 0}`)
      .join(', ');
    issues.push(`${label}: not enough free seats for ${n} passenger(s) in one seat type (${counts || 'no seats'})`);
    return { seats: [] };
  }
  // Mention the other passenger seat types with room (incl. ones without a default price, e.g. VIP).
  const others = [...freeByType.keys()].filter(
    (t) => t !== chosenType && !isVehicleSeatType(t) && (freeByType.get(t) ?? 0) >= n,
  );
  if (!wanted && others.length) {
    warnings.push(
      `${label}: picked seat type ${chosenType} (cheapest with ${n} free seat(s); also available: ${others.join(', ')}) — pass seatType to choose`,
    );
  }
  // Prefer n adjacent seats (no taken seat in between, same floor); else the first free ones.
  const ordered = all.filter((s) => s.seatType === chosenType).sort(seatOrder());
  for (let start = 0; start + n <= ordered.length; start++) {
    const window = ordered.slice(start, start + n);
    if (window.every((s) => usable(s) && s.floorIndex === window[0]!.floorIndex)) return { seats: window };
  }
  if (n > 1) warnings.push(`${label}: no ${n} adjacent free ${chosenType} seats; the group is seated apart`);
  return { seats: ordered.filter(usable).slice(0, n) };
}

/** `ferry.bookingDrafts` — fetches what the builder needs and assembles the booking payload. */
export class BookingDraftsResource {
  constructor(
    private readonly boatLayouts: BoatLayoutsResource,
    private readonly bookings: BookingsResource,
    private readonly voyages?: { get(id: string, opts?: RequestOptions): Promise<Voyage> },
    private readonly operators?: { nationals(id: string, opts?: RequestOptions): Promise<OperatorNational[]> },
    private readonly vouchers?: Pick<VouchersResource, 'checkApplicability'>,
  ) {}

  private async prepareLeg(leg: DraftLeg, label: string, opts: RequestOptions) {
    const [layout, voyage] = await Promise.all([
      this.boatLayouts.latestByVoyageId(leg.voyageId, opts),
      this.voyages ? this.voyages.get(leg.voyageId, opts) : Promise.resolve(undefined),
    ]);
    const operatorId = voyage?.operator_id;
    const nationals = operatorId && this.operators ? await this.operators.nationals(operatorId, opts) : undefined;
    return buildLegTickets({ leg, layout, voyage, nationals, label });
  }

  /** Check each voucher of a leg against its order payload and fold the discount into the quote. */
  private async quoteVouchers(
    summary: DraftLegSummary,
    order: CreateOrderInput,
    codes: string[],
    label: string,
    issues: string[],
    opts: RequestOptions,
  ): Promise<void> {
    if (!this.vouchers || !codes.length) return;
    const checks = await Promise.all(
      codes.map(async (code) => {
        try {
          return {
            code,
            result: await this.vouchers!.checkApplicability({ voucher_code: code, order_payload: order }, opts),
          };
        } catch (e) {
          // 422 VoucherNotExist (errorCode 150125); any other error is not about the code.
          if (
            e instanceof FerryApiError &&
            e.status === 422 &&
            (e.errorCode === 150125 || /VoucherNotExist/.test(`${e.message} ${JSON.stringify(e.fieldErrors ?? {})}`))
          ) {
            return { code, result: undefined };
          }
          throw e;
        }
      }),
    );
    const unique: string[] = [];
    for (const { code, result } of checks) {
      if (!result) {
        issues.push(`${label}: voucher ${code} does not exist in your organization`);
        continue;
      }
      if (!result.isApplicable || !result.voucher) {
        issues.push(`${label}: voucher ${code} is not applicable to this order (route, date, period or usage limit)`);
        continue;
      }
      const amountType = String(result.voucher.amount_type ?? '').toLowerCase();
      const amount = Number(result.voucher.amount ?? 0);
      if (amountType === 'percentage' && amount > 100) {
        issues.push(`${label}: voucher ${code} is a percentage above 100 and is refused by the server`);
        continue;
      }
      // The OpenAPI spec types applied_orders[].customer_id as a string; the backend stores the numeric id.
      const rules = result.voucher as unknown as {
        is_unique?: boolean;
        limit_per_customer?: number | null;
        applied_orders?: Array<{ customer_id?: number | string }> | null;
      };
      const usedByCustomer = (rules.applied_orders ?? []).filter(
        (a) => Number(a.customer_id) === Number(order.customer_id),
      ).length;
      if (rules.limit_per_customer && usedByCustomer >= rules.limit_per_customer) {
        issues.push(
          `${label}: voucher ${code} was already used ${usedByCustomer} time(s) by this customer (limit ${rules.limit_per_customer})`,
        );
        continue;
      }
      const discountVnd = amountType === 'percentage' ? (summary.subtotalVnd * amount) / 100 : amount;
      summary.vouchers.push({ code, amountType: amountType || undefined, amount, discountVnd });
      if (rules.is_unique) unique.push(code);
    }
    if (unique.length && summary.vouchers.length > 1) {
      issues.push(`${label}: voucher ${unique.join(', ')} cannot be combined with other vouchers`);
    }
    const total = summary.vouchers.reduce((n, v) => n + v.discountVnd, 0);
    summary.totalVnd = Math.max(summary.subtotalVnd - total, 0);
    summary.voucherDiscountVnd = summary.subtotalVnd - summary.totalVnd;
  }

  /**
   * Validate and assemble a booking payload and quote its price. Calls the seat
   * map, voyage and nationality endpoints, plus the read-only voucher check;
   * nothing is created.
   */
  async prepare(input: PrepareBookingInput, opts: RequestOptions = {}): Promise<BookingDraft> {
    const issues: string[] = [];
    if (!Number.isInteger(input.customerId) || input.customerId <= 0) {
      issues.push('customerId must be the numeric id of a customer of your organization');
    }
    if (!input.ordererName?.trim()) issues.push('ordererName is required');
    if (!input.contactEmail?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.contactEmail)) {
      issues.push('contactEmail must be an email address');
    }
    if (issues.length) throw new FerryBookingDraftError(issues);

    const [depart, ret] = await Promise.all([
      this.prepareLeg(input.depart, 'depart', opts),
      input.return ? this.prepareLeg(input.return, 'return', opts) : Promise.resolve(undefined),
    ]);
    const contact = {
      customer_id: input.customerId,
      orderer_name: input.ordererName.trim(),
      contact_email: input.contactEmail.trim(),
      ...(input.phoneNumber ? { phone_number: input.phoneNumber } : {}),
    };
    const codesOf = (leg: DraftLeg) => [...new Set((leg.voucherCodes ?? []).map((c) => c.trim()).filter(Boolean))];
    const order = (leg: DraftLeg, tickets: CreateTicketInput[]): CreateOrderInput =>
      ({
        voyage_id: leg.voyageId,
        ...contact,
        tickets,
        vouchers: codesOf(leg).map((voucher_code) => ({ voucher_code })),
      }) as CreateOrderInput;
    const departOrder = order(input.depart, depart.tickets);
    const returnOrder = input.return && ret ? order(input.return, ret.tickets) : undefined;

    if (input.checkVouchers !== false) {
      await Promise.all([
        this.quoteVouchers(depart.summary, departOrder, codesOf(input.depart), 'depart', issues, opts),
        input.return && ret && returnOrder
          ? this.quoteVouchers(ret.summary, returnOrder, codesOf(input.return), 'return', issues, opts)
          : undefined,
      ]);
      if (issues.length) throw new FerryBookingDraftError(issues);
    }

    const bookingInput = {
      ...contact,
      ...(input.phoneCountryCode ? { phone_country_code: input.phoneCountryCode } : {}),
      depart_order: departOrder,
      ...(returnOrder ? { return_order: returnOrder } : {}),
    } as CreateBookingInput;
    const legs = [depart.summary, ...(ret ? [ret.summary] : [])];
    const sum = (f: (l: DraftLegSummary) => number) => legs.reduce((n, l) => n + f(l), 0);
    return {
      input: bookingInput,
      depart: depart.summary,
      ...(ret ? { return: ret.summary } : {}),
      estimatedTicketTotalVnd: sum((l) => l.ticketTotalVnd),
      estimatedHarborFeeVnd: sum((l) => l.harborFeeTotalVnd),
      estimatedVoucherDiscountVnd: sum((l) => l.voucherDiscountVnd),
      estimatedTotalVnd: sum((l) => l.totalVnd),
      warnings: [...depart.warnings, ...(ret?.warnings ?? [])],
    };
  }

  /** `prepare()` then `bookings.create()`. Not idempotent (see `bookings.create`). */
  async create(
    input: PrepareBookingInput,
    opts: RequestOptions = {},
  ): Promise<{ booking: Booking; draft: BookingDraft }> {
    const draft = await this.prepare(input, opts);
    const booking = await this.bookings.create(draft.input, opts);
    return { booking, draft };
  }
}
