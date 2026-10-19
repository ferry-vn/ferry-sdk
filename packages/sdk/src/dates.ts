/**
 * Date helpers. FerryVN schedules are expressed in Vietnam local time
 * (Asia/Ho_Chi_Minh, UTC+7, no DST): a voyage "on 2026-10-20" departs on that
 * calendar day in Vietnam, whatever the caller's own time zone.
 */
import { FerryConfigError } from './errors.js';

export const VIETNAM_TIME_ZONE = 'Asia/Ho_Chi_Minh';

/** Accepts `YYYY-MM-DD` strings or `Date` objects (converted to the Vietnam calendar date). */
export type DateLike = string | Date;

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

/** True for a real calendar date written as `YYYY-MM-DD` (rejects 2026-02-30). */
export function isValidYmd(value: string): boolean {
  const m = YMD.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * Format a date as `YYYY-MM-DD` in Vietnam time.
 * Strings must already be `YYYY-MM-DD` and are validated, not converted.
 *
 * @example toYmd(new Date('2026-10-19T17:30:00Z')) // '2026-10-20' (00:30 in Vietnam)
 */
export function toYmd(d: DateLike): string {
  if (typeof d === 'string') {
    if (!isValidYmd(d)) throw new FerryConfigError(`expected a date as YYYY-MM-DD, got "${d}"`);
    return d;
  }
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new FerryConfigError('invalid Date');
  // Vietnam has no DST, so a fixed +07:00 offset is exact and needs no Intl time-zone data.
  return new Date(d.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}

/** Today's date in Vietnam as `YYYY-MM-DD`. */
export function todayInVietnam(now: Date = new Date()): string {
  return toYmd(now);
}

/** Add whole days to a `YYYY-MM-DD` date. */
export function addDays(ymd: string, days: number): string {
  if (!Number.isInteger(days)) throw new FerryConfigError(`days must be an integer, got ${days}`);
  const base = toYmd(ymd);
  const dt = new Date(`${base}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Current Vietnam wall-clock time as `YYYY-MM-DD HH:mm`. */
export function nowInVietnam(now: Date = new Date()): string {
  return new Date(now.getTime() + VN_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

/** Start of a Vietnam calendar day as an exact instant: `2026-10-18T00:00:00.000+07:00`. */
export function vietnamDayStart(d: DateLike): string {
  return `${toYmd(d)}T00:00:00.000+07:00`;
}

/** End of a Vietnam calendar day as an exact instant: `2026-10-18T23:59:59.999+07:00`. */
export function vietnamDayEnd(d: DateLike): string {
  return `${toYmd(d)}T23:59:59.999+07:00`;
}

/**
 * The bookings and transactions endpoints read a bare `YYYY-MM-DD` as a UTC
 * day (07:00–06:59 in Vietnam) but keep an instant (`…T…`) as is: send
 * Vietnam-day bounds instead so "created on 18/10" means the Vietnam day.
 */
export function withVietnamCreatedAt<T extends { createdAtFrom?: string; createdAtTo?: string }>(
  filters: T | undefined,
): T | undefined {
  if (!filters) return filters;
  const out = { ...filters };
  if (typeof out.createdAtFrom === 'string' && isValidYmd(out.createdAtFrom)) {
    out.createdAtFrom = vietnamDayStart(out.createdAtFrom);
  }
  if (typeof out.createdAtTo === 'string' && isValidYmd(out.createdAtTo))
    out.createdAtTo = vietnamDayEnd(out.createdAtTo);
  return out;
}
