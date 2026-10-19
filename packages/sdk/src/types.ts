/**
 * Friendly aliases over the types generated from `openapi/sdk.json`
 * (`src/generated/partner-api.d.ts`, regenerate with `npm run generate`).
 */
import type { components } from './generated/partner-api.js';

export type { components, operations, paths } from './generated/partner-api.js';

export type Schemas = components['schemas'];

// ── Supply ──────────────────────────────────────────────────────────────
export type Location = Schemas['Location'];
export type Route = Schemas['Route'];
export type Operator = Schemas['Operator'];
export type OperatorNational = Schemas['OperatorNational'];
export type Voyage = Schemas['Voyage'];
export type VoyageTicketPrice = Schemas['VoyageTicketPrice'];
export type TicketPrice = Schemas['TicketPrice'];
export type TicketTypeConfig = Schemas['TicketTypeConfig'];
export type VoyageWithAdditions = Schemas['VoyageWithAdditions'];
export type VoyageCountSummary = Schemas['VoyageCountSummary'];
export type BoatLayout = Schemas['BoatLayout'];
export type BoatLayoutWithAdditions = Schemas['BoatLayoutWithAdditions'];
export type FloorLayout = Schemas['FloorLayout'];
export type TicketPriceAddition = Schemas['TicketPriceAddition'];

// ── Booking ─────────────────────────────────────────────────────────────
export type Booking = Schemas['Booking'];
export type Order = Schemas['Order'];
export type Ticket = Schemas['Ticket'];
export type CancelTicketRequest = Schemas['CancelTicketRequest'];
export type Voucher = Schemas['Voucher'];
export type PublicDisruption = Schemas['PublicDisruptionDto'];
export type PublicDisruptionList = Schemas['PublicDisruptionListDto'];
/** Anonymous booking summary from `GET /bookings/public/:id` (no personal data beyond the orderer name). */
export type PublicBookingSummary = Schemas['NoAuthBookingDto'];
/** Booking of a direct child organization, as visible to its parent (prices/PII censored). */
export type ChildOrgBooking = Schemas['CensoredBookingForParentOrg'];

/** Body of `POST /api/v1/bookings` (nested depart/return order payloads). */
export type CreateBookingInput = Schemas['CreateBookingDto'];
export type CreateOrderInput = Schemas['CreateOrderDto'];
export type CreateTicketInput = Schemas['CreateTicketDto'];
export type UpdateBookingInput = Schemas['UpdateBookingDto'];
export type CreateCancelTicketRequestInput = Schemas['CreateCancelTicketRequestDto'];
export type CheckVoucherInput = Schemas['CheckApplicableDto'];
/** Result of `vouchers.checkApplicability` (no discount amount: FLAT = amount, PERCENTAGE = % of ticket + harbor fees). */
export interface VoucherApplicability {
  isApplicable: boolean;
  voucher: (Omit<Voucher, 'usage_limit' | 'usage_count'> & { _id?: string }) | null;
}
/** A stored file reference; `path` is an absolute URL. */
export interface FileRef {
  id: string;
  path: string;
}

// ── Customers, organization, money ──────────────────────────────────────
export type Customer = Schemas['Customer'];
export type CreateCustomerInput = Schemas['CreateCustomerDto'];
export type UpdateCustomerInput = Schemas['UpdateCustomerDto'];
export type Organization = Schemas['Organization'];
export type Transaction = Schemas['Transaction'];
export type DebtLedgerEntry = Schemas['DebtLedger'];

/** Cursor order (the backend's cursor pagination only sorts by creation, i.e. `_id`). */
export type SortOrder = 'asc' | 'desc';

// ── Filters (sent JSON-encoded in the `filters` query parameter) ────────
export interface VoyageSearchFilters {
  /** Earliest departure time, `HH:mm:ss`. */
  min_depart_time?: string;
  /** Latest departure time, `HH:mm:ss`. */
  max_depart_time?: string;
  operator_ids?: string[];
  route_ids?: number[];
  boat_name?: string;
}
export interface RouteFilters {
  departure_id?: string;
  destination_id?: string;
  is_disable?: boolean;
  operator_ids?: string[];
}
/**
 * Booking filters. The backend validates the status lists as arrays
 * (`@IsArray`) although its Swagger decorators omit `isArray`; dates are
 * ISO strings or `YYYY-MM-DD`.
 */
export interface BookingFilters {
  ids?: string[];
  booking_statuses?: BookingStatus[];
  order_statuses?: OrderStatus[];
  payment_statuses?: BookingPaymentStatus[];
  operator_ids?: string[];
  order_ids?: string[];
  customer_id?: number;
  company_id?: string;
  lead_id?: string;
  /** Matches orderer name, phone or email. */
  namePhoneEmail?: string;
  orderer_name?: string;
  createdAtFrom?: string;
  createdAtTo?: string;
  depart_date_from?: string;
  depart_date_to?: string;
  return_date_from?: string;
  return_date_to?: string;
  payment_expired_at_from?: string;
  payment_expired_at_to?: string;
  ticket_issued_date_from?: string;
  ticket_issued_date_to?: string;
  route_id?: number;
  depart_route_id?: number;
  return_route_id?: number;
  min_price?: number;
  max_price?: number;
}
export interface OrderFilters {
  ids?: string[];
  order_statuses?: OrderStatus[];
  operator_ids?: string[];
  customer_id?: number;
  company_id?: string;
  orderer_name?: string;
  has_ticket_file?: boolean;
  createdAtFrom?: string;
  createdAtTo?: string;
  voyageDepartDateFrom?: string;
  voyageDepartDateTo?: string;
  voyageDepartDateTimeFrom?: string;
  voyageDepartDateTimeTo?: string;
}
export type CancelRequestProcessStatus = 'processing' | 'accept' | 'reject' | 'recall' | 'refunded';
export interface CancelTicketRequestFilters {
  ids?: string[];
  booking_id?: string;
  order_id?: string;
  process_statuses?: CancelRequestProcessStatus[];
  createdAtFrom?: string;
  createdAtTo?: string;
}
export interface CustomerFilters {
  id?: number;
  /** Matches name, phone or email. */
  namePhoneEmail?: string;
  name?: string;
  phone?: string;
  email?: string;
  social_id?: string;
  company_id?: string;
  groups?: string[];
  sources?: string[];
  types?: string[];
  createdAtFrom?: string;
  createdAtTo?: string;
}
export interface VoucherFilters {
  title?: string;
  description?: string;
  voucher_codes?: string[];
  amount_type?: 'percentage' | 'flat';
}
export interface TransactionFilters {
  customer_id?: number;
  booking_id?: string;
  order_id?: string;
  message?: string;
  content?: string;
  /** Transaction type codes, e.g. `PB` (pay booking), `PO` (pay order), `RF` (refund), `DP` (customer deposit). */
  types?: string[];
  statuses?: number[];
  owner_types?: string[];
  createdAtFrom?: string;
  createdAtTo?: string;
}
export interface DebtLedgerFilters {
  customer_ids?: number[];
  booking_ids?: string[];
  order_ids?: string[];
  statuses?: Array<'borrowing' | 'paid' | 'written_off'>;
}

/** Cursor page as returned by every cursor-paginated list endpoint. */
export interface CursorPage<T> {
  data: T[];
  /** Pass back as `cursor` to fetch the next page; `null` when exhausted. Treat as opaque. */
  next_cursor: string | null;
  /** Not returned by partner endpoints today; kept for forward compatibility. */
  total?: number | null;
}

export interface CursorParams {
  cursor?: string | undefined;
  /** Page size. Partner list endpoints cap it at 50 (routes: 100). */
  limit?: number | undefined;
}

// ── Status enums (mirrors backend src/bookings/domain/*.enum.ts, src/orders/domain/order-status.enum.ts) ──
export const BookingStatus = {
  Draft: 0,
  Requested: 2,
  ExportError: 6,
  Expired: 8,
  Booked: 10,
  CancelRequest: 12,
  Cancelled: 14,
  CancelledBecauseBoatNotDepart: 16,
} as const;
export type BookingStatus = (typeof BookingStatus)[keyof typeof BookingStatus];

export const BookingPaymentStatus = {
  NotPaid: 1,
  PayNotEnough: 3,
  Paid: 4,
  PaidWithDebt: 5,
  Refunded: 18,
  Cancelled: 30,
} as const;
export type BookingPaymentStatus = (typeof BookingPaymentStatus)[keyof typeof BookingPaymentStatus];

export const OrderStatus = {
  Draft: 0,
  Requested: 2,
  WaitForIssue: 4,
  ExportError: 6,
  Expired: 8,
  Booked: 10,
  Cancelled: 14,
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const OrderPaymentStatus = {
  NotPaid: 1,
  PayNotEnough: 3,
  Paid: 4,
  Refunded: 18,
  Cancelled: 30,
} as const;
export type OrderPaymentStatus = (typeof OrderPaymentStatus)[keyof typeof OrderPaymentStatus];

export const TicketStatus = { Draft: 0, Booked: 10, Cancelled: 20 } as const;
export type TicketStatus = (typeof TicketStatus)[keyof typeof TicketStatus];

export const TicketPaymentStatus = { Pending: 0, Paid: 10, Refunded: 20 } as const;
export type TicketPaymentStatus = (typeof TicketPaymentStatus)[keyof typeof TicketPaymentStatus];

/** `gender` on tickets. */
export const Gender = { Female: 0, Male: 1 } as const;
export type Gender = (typeof Gender)[keyof typeof Gender];

/** Ticket file URLs of a booking (after issuance), per leg. */
export function ticketFileUrls(booking: Pick<Booking, 'depart_order' | 'return_order'>): {
  depart?: { tickets?: string; harborFee?: string };
  return?: { tickets?: string; harborFee?: string };
} {
  const urls = (o: unknown) => {
    const order = o as { tickets_file?: FileRef | null; harbor_fee_file?: FileRef | null } | null | undefined;
    if (!order) return undefined;
    const tickets = typeof order.tickets_file?.path === 'string' ? order.tickets_file.path : undefined;
    const harborFee = typeof order.harbor_fee_file?.path === 'string' ? order.harbor_fee_file.path : undefined;
    return tickets || harborFee ? { ...(tickets ? { tickets } : {}), ...(harborFee ? { harborFee } : {}) } : undefined;
  };
  const depart = urls(booking.depart_order);
  const ret = urls(booking.return_order);
  return { ...(depart ? { depart } : {}), ...(ret ? { return: ret } : {}) };
}

/** Reverse lookup helper: `statusLabel(BookingStatus, 10) === 'Booked'`. */
export function statusLabel(enumObj: Record<string, number>, value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const hit = Object.entries(enumObj).find(([, v]) => v === value);
  return hit ? hit[0] : String(value);
}
