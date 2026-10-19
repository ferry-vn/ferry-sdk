/**
 * Selling prices of a route: what your organization's customers pay per ticket,
 * for every voyage of a date (or date range), seat type and ticket type.
 *
 * - The selling price is `price_with_VAT`: the operator's price after its
 *   promotions and your organization's price additions. It is what the server
 *   charges at booking (`total_price`). Your cost (`base_price`) is never
 *   returned by the API; it only shows up as `total_net_price` on a booking.
 * - The operator's per-ticket harbor fee on the route is added on top.
 * - Search data (`source: 'search'`) is synced and can lag the operator: with
 *   `live: n` the first n bookable voyages are re-priced from their live seat
 *   map (`source: 'seat-map'`) — each of those calls may query the operator.
 */

import { isVehicleSeatType, voyageHarborFee } from './booking-builder.js';
import type { DateLike } from './dates.js';
import { FerryError } from './errors.js';
import type { RequestOptions } from './http.js';
import { collect } from './pagination.js';
import type { BoatLayoutsResource, VoyagesResource } from './resources/supply-resources.js';
import type { TicketPrice, TicketTypeConfig, Voyage, VoyageSearchFilters } from './types.js';
import { voyageDeparture, voyageUnbookableReason } from './voyage-utils.js';

/** At most this many live seat maps per call: each may hit the operator's own system. */
export const MAX_LIVE_SEAT_MAPS = 10;

export interface RoutePriceEntry {
  seatType: string;
  ticketTypeId: number;
  ticketType: string;
  /** Selling price incl. VAT (per ticket). */
  priceVnd: number;
  harborFeeVnd: number;
  /** `priceVnd + harborFeeVnd`. */
  totalVnd: number;
  /** The operator's default (usually adult) price for this seat type. */
  isDefault: boolean;
  /** Motorbike/car place sold as a seat type (`isVehicleSeatType`). */
  vehicle: boolean;
  /**
   * Can be booked through the API: a non-zero price and, when the operator
   * publishes ticket-type rules, a type covered by them (the server refuses
   * other types — e.g. invitations or disability tickets — with InvalidTicketTypeId).
   */
  bookable: boolean;
  /** Age / nationality rules of the ticket type, e.g. `MIN_AGE 1, MAX_AGE 11`. */
  rules?: string | undefined;
}

export interface RouteVoyagePrices {
  voyageId: string;
  operatorCode: string | undefined;
  operatorName: string | undefined;
  /** `YYYY-MM-DD HH:mm`, Vietnam time. */
  departure: string | undefined;
  arrival: string | undefined;
  boat: string | undefined;
  seatsLeft: number | undefined;
  /** Why the voyage cannot be sold (only present with `includeUnavailable`). */
  unavailable?: string | undefined;
  harborFeeVnd: number;
  /** `search` = synced voyage data; `seat-map` = live seat map (the price that is charged). */
  source: 'search' | 'seat-map';
  /** Set when `live` was requested but the seat map could not be read (the search prices are kept). */
  liveError?: string | undefined;
  prices: RoutePriceEntry[];
  /** Cheapest passenger ticket of the voyage incl. harbor fee (often a child ticket). */
  fromVnd: number | undefined;
  /** Cheapest *default* ticket (usually adult) incl. harbor fee — the usual "price from". */
  defaultFromVnd: number | undefined;
}

export interface RoutePricesParams {
  departureId: string;
  destinationId: string;
  /** One day (Vietnam calendar day)… */
  date?: DateLike | undefined;
  /** …or a range `from`–`to` (inclusive). */
  from?: DateLike | undefined;
  to?: DateLike | undefined;
  filters?: VoyageSearchFilters | undefined;
  /** Re-price the first n bookable voyages from their live seat map (max `MAX_LIVE_SEAT_MAPS`). Default 0. */
  live?: number | undefined;
  /** Also list vehicle places (motorbike/car slots). Default false. */
  includeVehicles?: boolean | undefined;
  /** Also list ticket types the API cannot book (zero price, not covered by the rules). Default false. */
  includeAllTicketTypes?: boolean | undefined;
  /** Also list disabled / sold-out / departed voyages. Default false. */
  includeUnavailable?: boolean | undefined;
  /** Stop after this many voyages (default 200). */
  maxVoyages?: number | undefined;
}

export interface RoutePrices {
  voyages: RouteVoyagePrices[];
  /** Unsellable voyages left out (when `includeUnavailable` is false). */
  hiddenUnavailable: number;
}

const rulesByType = (configs: TicketTypeConfig[] | undefined) => {
  const out = new Map<number, string[]>();
  for (const c of configs ?? []) {
    if (!/AGE|NATIONAL_ID/.test(c.key_config)) continue;
    out.set(c.ticket_type_id, [...(out.get(c.ticket_type_id) ?? []), `${c.key_config} ${c.value_config}`]);
  }
  return out;
};

/**
 * Price entries of one voyage from a price list (the voyage's `ticket_prices`
 * or a seat map's `prices`). Pure; sorted by seat type then price.
 */
export function voyagePriceEntries(
  voyage: Voyage,
  prices: TicketPrice[] | undefined,
  configs: TicketTypeConfig[] | undefined,
  options: { includeVehicles?: boolean | undefined; includeAllTicketTypes?: boolean | undefined } = {},
): RoutePriceEntry[] {
  const harborFeeVnd = voyageHarborFee(voyage);
  const rules = rulesByType(configs);
  const configured = new Set((configs ?? []).map((c) => c.ticket_type_id));
  return (prices ?? [])
    .map((p) => {
      const vehicle = isVehicleSeatType(p.seat_type);
      const r = rules.get(p.ticket_type_id);
      const bookable = p.price_with_VAT > 0 && (configured.size === 0 || configured.has(p.ticket_type_id));
      return {
        seatType: p.seat_type,
        ticketTypeId: p.ticket_type_id,
        ticketType: p.ticket_type_label,
        priceVnd: p.price_with_VAT,
        harborFeeVnd,
        totalVnd: p.price_with_VAT + harborFeeVnd,
        isDefault: Boolean(p.is_default),
        vehicle,
        bookable,
        ...(r && !vehicle ? { rules: r.join(', ') } : {}),
      };
    })
    .filter((e) => (options.includeAllTicketTypes || e.bookable) && (options.includeVehicles || !e.vehicle))
    .sort((a, b) => a.seatType.localeCompare(b.seatType) || a.priceVnd - b.priceVnd || a.ticketTypeId - b.ticketTypeId);
}

function summarize(voyage: Voyage, entries: RoutePriceEntry[], source: RouteVoyagePrices['source']): RouteVoyagePrices {
  const passenger = entries.filter((e) => !e.vehicle && e.bookable);
  const defaults = passenger.filter((e) => e.isDefault);
  return {
    voyageId: voyage.id,
    operatorCode: voyage.operator?.operator_code,
    operatorName: voyage.operator?.operator_name,
    departure: voyageDeparture(voyage),
    arrival: voyage.arrive_time ? String(voyage.arrive_time).slice(0, 5) : undefined,
    boat: voyage.boat_name ?? undefined,
    seatsLeft: voyage.no_remain,
    harborFeeVnd: voyageHarborFee(voyage),
    source,
    prices: entries,
    fromVnd: passenger.length ? Math.min(...passenger.map((e) => e.totalVnd)) : undefined,
    defaultFromVnd: defaults.length ? Math.min(...defaults.map((e) => e.totalVnd)) : undefined,
  };
}

/** `ferry.prices` — route price tables built from voyage search (+ optional live seat maps). */
export class PricesResource {
  constructor(
    private readonly voyages: VoyagesResource,
    private readonly boatLayouts: BoatLayoutsResource,
  ) {}

  /**
   * Selling prices for every voyage between two locations on a date or range.
   * One search request per page; plus one seat-map request per `live` voyage.
   */
  async forRoute(params: RoutePricesParams, opts: RequestOptions = {}): Promise<RoutePrices> {
    const live = Math.max(0, Math.floor(params.live ?? 0));
    if (live > MAX_LIVE_SEAT_MAPS) {
      throw new FerryError(`live is limited to ${MAX_LIVE_SEAT_MAPS} seat maps per call (each may query the operator)`);
    }
    const range =
      params.date !== undefined
        ? { date: params.date }
        : params.from !== undefined && params.to !== undefined
          ? { from: params.from, to: params.to }
          : undefined;
    if (!range) throw new FerryError('give either date, or from and to');
    const found = await collect(
      this.voyages.iterate(
        {
          departureId: params.departureId,
          destinationId: params.destinationId,
          filters: params.filters,
          limit: 50,
          maxItems: params.maxVoyages ?? 200,
          ...range,
        },
        opts,
      ),
    );
    const seen = new Set<string>();
    const voyages: Voyage[] = [];
    for (const v of found) {
      if (v.voyage && !seen.has(v.voyage.id)) {
        seen.add(v.voyage.id);
        voyages.push(v.voyage);
      }
    }
    voyages.sort((a, b) => (voyageDeparture(a) ?? '').localeCompare(voyageDeparture(b) ?? ''));
    const shown = params.includeUnavailable ? voyages : voyages.filter((v) => !voyageUnbookableReason(v));
    const entryOptions = {
      includeVehicles: params.includeVehicles,
      includeAllTicketTypes: params.includeAllTicketTypes,
    };

    const rows = shown.map((v) => {
      const tp = v.ticket_prices as { prices?: TicketPrice[]; ticket_type_configs?: TicketTypeConfig[] } | undefined;
      const row = summarize(v, voyagePriceEntries(v, tp?.prices, tp?.ticket_type_configs, entryOptions), 'search');
      const reason = voyageUnbookableReason(v);
      return reason ? { ...row, unavailable: reason } : row;
    });

    // Live seat maps, sequentially: they may hit the operator's system.
    let remaining = live;
    for (let i = 0; i < rows.length && remaining > 0; i++) {
      if (rows[i]!.unavailable) continue;
      remaining--;
      const v = shown[i]!;
      try {
        const layout = await this.boatLayouts.latestByVoyageId(v.id, opts);
        const bl = layout.boatLayout;
        const tp = v.ticket_prices as { ticket_type_configs?: TicketTypeConfig[] } | undefined;
        const configs = bl.ticket_type_configs?.length ? bl.ticket_type_configs : tp?.ticket_type_configs;
        rows[i] = summarize(v, voyagePriceEntries(v, bl.prices, configs, entryOptions), 'seat-map');
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        const fields = (e as { fieldErrors?: Record<string, unknown> }).fieldErrors;
        rows[i] = { ...rows[i]!, liveError: fields ? Object.values(fields).join(', ') : (e as Error).message };
      }
    }
    return { voyages: rows, hiddenUnavailable: voyages.length - shown.length };
  }
}
