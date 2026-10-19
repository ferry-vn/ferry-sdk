/**
 * Booking-side partner endpoints: bookings, orders, cancel-ticket requests,
 * vouchers and disruptions. All require the partner API key except
 * `bookings.getPublic`.
 *
 * Not available to API keys (verified in backend v3.2.16, so intentionally
 * absent): `/bookings/sync` (admin), passengers (internal),
 * `GET /cancel-ticket-request/:id` (use `cancelTicketRequests.get`, which filters the list).
 */
import { withVietnamCreatedAt } from '../dates.js';
import { FerryNotFoundError } from '../errors.js';
import type { RequestOptions, Transport } from '../http.js';
import { type PaginateOptions, paginate } from '../pagination.js';
import type {
  Booking,
  BookingFilters,
  CancelTicketRequest,
  CancelTicketRequestFilters,
  CheckVoucherInput,
  ChildOrgBooking,
  CreateBookingInput,
  CreateCancelTicketRequestInput,
  CursorPage,
  CursorParams,
  Order,
  OrderFilters,
  PublicBookingSummary,
  PublicDisruption,
  PublicDisruptionList,
  SortOrder,
  UpdateBookingInput,
  Voucher,
  VoucherApplicability,
  VoucherFilters,
} from '../types.js';
import { requireBody } from './account-resources.js';

const V1 = '/api/v1';
const enc = encodeURIComponent;
/** Ticket issuance talks to the operator synchronously and can take minutes. */
const ISSUE_TIMEOUT_MS = 600_000;

type BookingListParams = CursorParams & { filters?: BookingFilters; order?: SortOrder };

export class BookingsResource {
  constructor(private readonly t: Transport) {}

  /**
   * `POST /api/v1/bookings` — create a booking (+ its depart/return orders).
   * Starts as `Requested (2)` / `NotPaid (1)` with a payment deadline; no money
   * moves and no seat is held until tickets are issued.
   *
   * NOT idempotent: the backend has no idempotency-key support, so the SDK
   * never retries it. After a network error/timeout, look the booking up with
   * `list({ filters: { namePhoneEmail } })` before re-submitting.
   *
   * The response is not populated (`depart_order`/`return_order` are null) —
   * call `get(id)` for the full booking.
   *
   * Tip: build `input` with `ferry.bookingDrafts.prepare()` instead of by hand.
   */
  create(input: CreateBookingInput, opts: RequestOptions = {}): Promise<Booking> {
    return this.t.request({ method: 'POST', path: `${V1}/bookings`, body: input, ...opts });
  }

  /** `GET /api/v1/bookings/:id`. A booking of another organization yields `FerryPermissionError` (403). */
  async get(id: string, opts: RequestOptions = {}): Promise<Booking> {
    const path = `${V1}/bookings/${enc(id)}`;
    return requireBody(await this.t.request<Booking>({ method: 'GET', path, ...opts }), `booking ${id}`, path);
  }

  /**
   * `GET /api/v1/bookings` — bookings of the API key's organization, newest first
   * (max 50 per page). Note: the backend answers internal errors on this route
   * with an empty page rather than an error.
   */
  list(params: BookingListParams = {}, opts: RequestOptions = {}): Promise<CursorPage<Booking>> {
    return this.t.request({
      method: 'GET',
      path: `${V1}/bookings`,
      query: {
        cursor: params.cursor,
        limit: params.limit,
        // createdAtFrom/To given as YYYY-MM-DD mean Vietnam days.
        filters: withVietnamCreatedAt(params.filters),
        sort: params.order ? `_id:${params.order}` : undefined,
      },
      ...opts,
    });
  }

  /** Iterate every booking matching `filters`. */
  iterate(
    params: Omit<BookingListParams, 'cursor'> & PaginateOptions = {},
    opts: RequestOptions = {},
  ): AsyncGenerator<Booking, void, undefined> {
    const { maxPages, maxItems, ...rest } = params;
    return paginate((cursor) => this.list({ ...rest, cursor }, opts), { maxPages, maxItems });
  }

  /** `PATCH /api/v1/bookings/:id` — update contact / VAT invoice fields. */
  update(id: string, input: UpdateBookingInput, opts: RequestOptions = {}): Promise<Booking> {
    return this.t.request({ method: 'PATCH', path: `${V1}/bookings/${enc(id)}`, body: input, ...opts });
  }

  /**
   * `POST /api/v1/bookings/confirmToIssue/:id` — **moves money**: charges the
   * organization (balance + credit; a customer shortfall is lent as debt, so
   * the booking usually ends `PaidWithDebt`) and places the real order with
   * the ferry operator. Resolves with no value — read the result with
   * `bookings.get(id)`:
   *  - automatic operators issue synchronously (can take minutes, so the
   *    default timeout of this call is 10 minutes): booking → `Booked`;
   *  - manual operators: order → `WaitForIssue`, staff issue later;
   *  - failure: payment reset to `NotPaid`, `order.issue_ticket_error` set;
   *    a round trip that issued only one leg answers HTTP 500 and ends `ExportError`.
   *
   * Only `Requested` orders are processed (422 `InvalidStatus`, also for
   * already-issued bookings); a concurrent call gets 422
   * `AlreadyProcessingIssueTicket`; at most 5 attempts per booking per minute
   * (429). Never retried automatically. If the call times out, the server keeps
   * going — check `bookings.get(id)` before trying again.
   */
  async confirmToIssue(id: string, opts: RequestOptions = {}): Promise<void> {
    await this.t.request<unknown>({
      method: 'POST',
      path: `${V1}/bookings/confirmToIssue/${enc(id)}`,
      ...opts,
      timeoutMs: opts.timeoutMs ?? Math.max(this.t.config.timeoutMs, ISSUE_TIMEOUT_MS),
    });
  }

  /**
   * `GET /api/v1/bookings/download-ticket/:id` — ask the backend to re-fetch the
   * ticket files of an issued booking from the operator. Resolves with no
   * value; the refreshed files are on the booking afterwards (see
   * `ticketFileUrls(await bookings.get(id))`). 422 until an order is issued.
   */
  async refreshTicketFiles(id: string, opts: RequestOptions = {}): Promise<void> {
    // A GET with a side effect (synchronous re-download from the operator): never retried.
    await this.t.request<unknown>({
      method: 'GET',
      path: `${V1}/bookings/download-ticket/${enc(id)}`,
      ...opts,
      maxRetries: 0,
      timeoutMs: opts.timeoutMs ?? Math.max(this.t.config.timeoutMs, 120_000),
    });
  }

  /**
   * `GET /api/v1/bookings/public/:id` — anonymous summary of a booking
   * (route, departure, operator, orderer name). Works without an API key.
   */
  getPublic(id: string, opts: RequestOptions = {}): Promise<PublicBookingSummary> {
    return this.t.request({ method: 'GET', path: `${V1}/bookings/public/${enc(id)}`, ...opts });
  }

  /**
   * `GET /api/v1/bookings/child-orgs/bookings` — bookings of your **direct**
   * child organizations (censored for parents). Empty when you have none.
   */
  listChildOrgBookings(
    params: CursorParams & { filters?: BookingFilters; order?: SortOrder } = {},
    opts: RequestOptions = {},
  ): Promise<CursorPage<ChildOrgBooking>> {
    return this.t.request({
      method: 'GET',
      path: `${V1}/bookings/child-orgs/bookings`,
      query: {
        cursor: params.cursor,
        limit: params.limit,
        filters: withVietnamCreatedAt(params.filters),
        sort: params.order ? `_id:${params.order}` : undefined,
      },
      ...opts,
    });
  }
}

export class OrdersResource {
  constructor(private readonly t: Transport) {}

  /** `GET /api/v1/orders` — orders (one voyage of a booking) of the organization. Max 50 per page. */
  list(params: CursorParams & { filters?: OrderFilters } = {}, opts: RequestOptions = {}): Promise<CursorPage<Order>> {
    return this.t.request({
      method: 'GET',
      path: `${V1}/orders`,
      // `limit` is required by the backend DTO.
      query: { cursor: params.cursor, limit: params.limit ?? 10, filters: params.filters },
      ...opts,
    });
  }

  /** Iterate every order matching `filters`. */
  iterate(
    params: Omit<CursorParams, 'cursor'> & { filters?: OrderFilters } & PaginateOptions = {},
    opts: RequestOptions = {},
  ): AsyncGenerator<Order, void, undefined> {
    const { maxPages, maxItems, ...rest } = params;
    return paginate((cursor) => this.list({ ...rest, cursor }, opts), { maxPages, maxItems });
  }

  /** `GET /api/v1/orders/:id`. */
  async get(id: string, opts: RequestOptions = {}): Promise<Order> {
    const path = `${V1}/orders/${enc(id)}`;
    return requireBody(await this.t.request<Order>({ method: 'GET', path, ...opts }), `order ${id}`, path);
  }
}

export class CancelTicketRequestsResource {
  constructor(private readonly t: Transport) {}

  /**
   * `POST /api/v1/cancel-ticket-request` — ask to cancel tickets of a `Booked`
   * order of your organization. The backend immediately holds the cancellation
   * fee from the customer and routes the request up the organization chain
   * (`processing → accept → refunded`, or `reject` / `recall`). Requires the
   * organization's cancellation rules to be configured (422 otherwise).
   */
  create(input: CreateCancelTicketRequestInput, opts: RequestOptions = {}): Promise<CancelTicketRequest> {
    return this.t.request({ method: 'POST', path: `${V1}/cancel-ticket-request`, body: input, ...opts });
  }

  /** `GET /api/v1/cancel-ticket-request` — requests of your organization and its descendants (max 50 per page). */
  list(
    params: CursorParams & { filters?: CancelTicketRequestFilters } = {},
    opts: RequestOptions = {},
  ): Promise<CursorPage<CancelTicketRequest>> {
    return this.t.request({
      method: 'GET',
      path: `${V1}/cancel-ticket-request`,
      query: { cursor: params.cursor, limit: params.limit, filters: params.filters },
      ...opts,
    });
  }

  /** Iterate every cancel request matching `filters`. */
  iterate(
    params: Omit<CursorParams, 'cursor'> & { filters?: CancelTicketRequestFilters } & PaginateOptions = {},
    opts: RequestOptions = {},
  ): AsyncGenerator<CancelTicketRequest, void, undefined> {
    const { maxPages, maxItems, ...rest } = params;
    return paginate((cursor) => this.list({ ...rest, cursor }, opts), { maxPages, maxItems });
  }

  /**
   * Convenience: there is no partner `GET /:id`, so this filters `list()` by id.
   * `FerryNotFoundError` when no request of your organization has this id.
   */
  async get(id: string, opts: RequestOptions = {}): Promise<CancelTicketRequest> {
    const page = await this.list({ filters: { ids: [id] }, limit: 1 }, opts);
    const found = page.data[0];
    if (!found) {
      throw new FerryNotFoundError({
        status: 404,
        message: `cancel ticket request ${id} not found`,
        method: 'GET',
        url: `${V1}/cancel-ticket-request`,
      });
    }
    return found;
  }
}

export class VouchersResource {
  constructor(private readonly t: Transport) {}

  /** `GET /api/v1/vouchers` — vouchers of the organization (max 50 per page). */
  list(
    params: CursorParams & { filters?: VoucherFilters } = {},
    opts: RequestOptions = {},
  ): Promise<CursorPage<Voucher>> {
    return this.t.request({
      method: 'GET',
      path: `${V1}/vouchers`,
      query: { cursor: params.cursor, limit: params.limit, filters: params.filters },
      ...opts,
    });
  }

  /** `GET /api/v1/vouchers/:id`. */
  async get(id: string, opts: RequestOptions = {}): Promise<Voucher> {
    const path = `${V1}/vouchers/${enc(id)}`;
    return requireBody(await this.t.request<Voucher>({ method: 'GET', path, ...opts }), `voucher ${id}`, path);
  }

  /**
   * `POST /api/v1/vouchers/check-aplicability` (sic — spelling as in the backend).
   * Read-only check of one of your organization's voucher codes against an order
   * payload (a full `CreateOrderInput`, e.g. `draft.input.depart_order`).
   * 422 `VoucherNotExist` (150125) for unknown codes. Per-customer limits are
   * only enforced when the booking is created.
   */
  checkApplicability(input: CheckVoucherInput, opts: RequestOptions = {}): Promise<VoucherApplicability> {
    return this.t.request({ method: 'POST', path: `${V1}/vouchers/check-aplicability`, body: input, ...opts });
  }
}

export class DisruptionsResource {
  constructor(private readonly t: Transport) {}

  /**
   * `GET /api/v1/disruptions` — weather/operational incidents (delays,
   * cancellations) affecting your organization's bookings, oldest update first.
   * Poll with `updatedSince` (ISO timestamp) to catch changes; `limit` 1–50.
   */
  list(
    params: CursorParams & {
      updatedSince?: string | Date;
      state?: 'building' | 'active' | 'closing' | 'closed';
      voyageId?: string;
      bookingId?: string;
    } = {},
    opts: RequestOptions = {},
  ): Promise<PublicDisruptionList> {
    return this.t.request({
      method: 'GET',
      path: `${V1}/disruptions`,
      query: {
        cursor: params.cursor,
        limit: params.limit,
        updated_since: params.updatedSince instanceof Date ? params.updatedSince.toISOString() : params.updatedSince,
        state: params.state,
        voyage_id: params.voyageId,
        booking_id: params.bookingId,
      },
      ...opts,
    });
  }

  /** Iterate every disruption matching the filters. */
  iterate(
    params: Omit<Parameters<DisruptionsResource['list']>[0] & object, 'cursor'> & PaginateOptions = {},
    opts: RequestOptions = {},
  ): AsyncGenerator<PublicDisruption, void, undefined> {
    const { maxPages, maxItems, ...rest } = params;
    return paginate(
      async (cursor) => {
        const page = await this.list({ ...rest, cursor }, opts);
        return { data: page.data, next_cursor: page.next_cursor ?? null };
      },
      { maxPages, maxItems },
    );
  }

  /** `GET /api/v1/disruptions/:id` (404 when it affects none of your bookings). */
  get(id: string, opts: RequestOptions = {}): Promise<PublicDisruption> {
    return this.t.request({ method: 'GET', path: `${V1}/disruptions/${enc(id)}`, ...opts });
  }

  /** `GET /api/v1/bookings/:id/disruptions` — every disruption affecting one booking (not paginated). */
  forBooking(
    bookingId: string,
    opts: RequestOptions = {},
  ): Promise<Omit<PublicDisruptionList, 'next_cursor'> & { next_cursor?: string | null }> {
    return this.t.request({ method: 'GET', path: `${V1}/bookings/${enc(bookingId)}/disruptions`, ...opts });
  }
}
