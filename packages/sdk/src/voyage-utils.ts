/**
 * Voyage helpers. Search results include voyages that cannot be sold: the
 * operator disabled them (`disable`, the seat-map endpoints then answer
 * `VoyageIsDisabled`), the operator itself is disabled, they are full, or they
 * already left. The dashboard hides those; so should integrations.
 */
import { nowInVietnam, todayInVietnam } from './dates.js';
import type { Voyage } from './types.js';

export type VoyageUnbookableReason = 'disabled' | 'operator-disabled' | 'sold-out' | 'departed';

/** `YYYY-MM-DD HH:mm` departure in Vietnam time, or `undefined` when unknown. */
export function voyageDeparture(voyage: Pick<Voyage, 'departure_date' | 'depart_time'>): string | undefined {
  const date = voyage.departure_date ? String(voyage.departure_date).slice(0, 10) : '';
  if (!date) return undefined;
  const time = voyage.depart_time ? String(voyage.depart_time).slice(0, 5) : '';
  return time ? `${date} ${time}` : date;
}

/** Why a voyage cannot be booked right now, or `undefined` when it can. */
export function voyageUnbookableReason(
  voyage: Voyage,
  options: { now?: Date | undefined } = {},
): VoyageUnbookableReason | undefined {
  if (voyage.disable) return 'disabled';
  if (voyage.operator?.is_enabled === false) return 'operator-disabled';
  if (typeof voyage.no_remain === 'number' && voyage.no_remain <= 0) return 'sold-out';
  const departure = voyageDeparture(voyage);
  if (departure) {
    const past =
      departure.length === 16
        ? departure <= nowInVietnam(options.now)
        : departure.slice(0, 10) < todayInVietnam(options.now);
    if (past) return 'departed';
  }
  return undefined;
}

/** True when the voyage is enabled, its operator is enabled, it has seats left and has not departed. */
export function isVoyageBookable(voyage: Voyage, options: { now?: Date | undefined } = {}): boolean {
  return voyageUnbookableReason(voyage, options) === undefined;
}
