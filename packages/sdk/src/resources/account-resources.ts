/**
 * Organization-side partner endpoints: customers, the API key's organization,
 * transactions and the debt ledger. All require the partner API key and are
 * scoped server-side to the key's organization.
 *
 * Verified in backend v3.2.16 (Permify grants for the `api_key` relation):
 * customers CRUD minus delete, organizations/me (`view`), reservable-credit
 * (`edit`), transactions and debt-ledger reads.
 */
import { withVietnamCreatedAt } from '../dates.js';
import { FerryNotFoundError } from '../errors.js';
import type { RequestOptions, Transport } from '../http.js';
import { type PaginateOptions, paginate } from '../pagination.js';
import type {
  CreateCustomerInput,
  CursorPage,
  CursorParams,
  Customer,
  CustomerFilters,
  DebtLedgerEntry,
  DebtLedgerFilters,
  Organization,
  SortOrder,
  Transaction,
  TransactionFilters,
  UpdateCustomerInput,
} from '../types.js';

const V1 = '/api/v1';
const enc = encodeURIComponent;

/**
 * Some backend `:id` routes answer "not found" with an empty HTTP 204 instead
 * of a 404; turn that into the error callers expect.
 */
export function requireBody<T>(value: T | undefined | null | '', what: string, url: string): T {
  if (value === undefined || value === null || value === '') {
    throw new FerryNotFoundError({ status: 404, message: `${what} not found`, method: 'GET', url });
  }
  return value;
}

export class CustomersResource {
  constructor(private readonly t: Transport) {}

  /**
   * `POST /api/v1/customers` — create a customer (khách hàng) in the key's organization.
   * Bookings must reference a customer of the organization (`customer_id`).
   */
  create(input: CreateCustomerInput, opts: RequestOptions = {}): Promise<Customer> {
    return this.t.request({ method: 'POST', path: `${V1}/customers`, body: input, ...opts });
  }

  /** `GET /api/v1/customers` — customers of the organization, newest first (max 50 per page). */
  list(
    params: CursorParams & { filters?: CustomerFilters; order?: SortOrder } = {},
    opts: RequestOptions = {},
  ): Promise<CursorPage<Customer>> {
    return this.t.request({
      method: 'GET',
      path: `${V1}/customers`,
      query: {
        cursor: params.cursor,
        limit: params.limit,
        filters: params.filters,
        sort: params.order ? `_id:${params.order}` : undefined,
      },
      ...opts,
    });
  }

  /** Iterate every customer matching `filters`. */
  iterate(
    params: Omit<CursorParams, 'cursor'> & { filters?: CustomerFilters; order?: SortOrder } & PaginateOptions = {},
    opts: RequestOptions = {},
  ): AsyncGenerator<Customer, void, undefined> {
    const { maxPages, maxItems, ...rest } = params;
    return paginate((cursor) => this.list({ ...rest, cursor }, opts), { maxPages, maxItems });
  }

  /**
   * `GET /api/v1/customers/:id`. A customer of another organization yields
   * `FerryPermissionError` (403) — the backend checks access before existence.
   */
  async get(id: number | string, opts: RequestOptions = {}): Promise<Customer> {
    const path = `${V1}/customers/${enc(String(id))}`;
    return requireBody(await this.t.request<Customer>({ method: 'GET', path, ...opts }), `customer ${id}`, path);
  }

  /** `PATCH /api/v1/customers/:id` — update contact details. */
  update(id: number | string, input: UpdateCustomerInput, opts: RequestOptions = {}): Promise<Customer> {
    return this.t.request({ method: 'PATCH', path: `${V1}/customers/${enc(String(id))}`, body: input, ...opts });
  }

  /**
   * Find customers by phone, email or name (server-side substring match on
   * name, phone and email). Vietnamese phones are stored as `+84…`, so a local
   * number like `0901234567` is searched without its leading 0 to match both
   * forms. Returns at most `limit` (default 10) matches.
   */
  async search(text: string, params: { limit?: number } = {}, opts: RequestOptions = {}): Promise<Customer[]> {
    const compact = text.replace(/[\s.-]/g, '');
    const query = /^(?:\+?84|0)\d{8,10}$/.test(compact) ? compact.replace(/^(?:\+?84|0)/, '') : text.trim();
    const page = await this.list({ filters: { namePhoneEmail: query }, limit: params.limit ?? 10 }, opts);
    return page.data;
  }
}

export class OrganizationResource {
  constructor(private readonly t: Transport) {}

  /** `GET /api/v1/organizations/me` — the API key's organization (name, slug, balances, credit). */
  me(opts: RequestOptions = {}): Promise<Organization> {
    return this.t.request({ method: 'GET', path: `${V1}/organizations/me`, ...opts });
  }

  /**
   * `GET /api/v1/organizations/reservable-credit` — credit (VND) the organization
   * can still use from its parent chain when issuing tickets. Root organizations
   * report a very large constant.
   */
  async reservableCredit(opts: RequestOptions = {}): Promise<number> {
    const value = await this.t.request<number | string>({
      method: 'GET',
      path: `${V1}/organizations/reservable-credit`,
      ...opts,
    });
    return typeof value === 'number' ? value : Number(value);
  }
}

export class TransactionsResource {
  constructor(private readonly t: Transport) {}

  /** `GET /api/v1/transactions` — balance movements created by the organization (read-only). */
  list(
    params: CursorParams & { filters?: TransactionFilters } = {},
    opts: RequestOptions = {},
  ): Promise<CursorPage<Transaction>> {
    return this.t.request({
      method: 'GET',
      path: `${V1}/transactions`,
      query: { cursor: params.cursor, limit: params.limit, filters: withVietnamCreatedAt(params.filters) },
      ...opts,
    });
  }

  /** Iterate every transaction matching `filters`. */
  iterate(
    params: Omit<CursorParams, 'cursor'> & { filters?: TransactionFilters } & PaginateOptions = {},
    opts: RequestOptions = {},
  ): AsyncGenerator<Transaction, void, undefined> {
    const { maxPages, maxItems, ...rest } = params;
    return paginate((cursor) => this.list({ ...rest, cursor }, opts), { maxPages, maxItems });
  }

  /** `GET /api/v1/transactions/:id`. */
  async get(id: string, opts: RequestOptions = {}): Promise<Transaction> {
    const path = `${V1}/transactions/${enc(id)}`;
    return requireBody(await this.t.request<Transaction>({ method: 'GET', path, ...opts }), `transaction ${id}`, path);
  }
}

export class DebtLedgerResource {
  constructor(private readonly t: Transport) {}

  /**
   * `GET /api/v1/debt-ledger` — customer debts (borrowing / paid / written_off).
   * Visibility follows the role of the user who created the API key: if that
   * user is no longer an admin/manager of the organization, the list is empty.
   */
  list(
    params: CursorParams & { filters?: DebtLedgerFilters } = {},
    opts: RequestOptions = {},
  ): Promise<CursorPage<DebtLedgerEntry>> {
    return this.t.request({
      method: 'GET',
      path: `${V1}/debt-ledger`,
      query: { cursor: params.cursor, limit: params.limit, filters: params.filters },
      ...opts,
    });
  }

  /** Iterate every debt-ledger entry matching `filters`. */
  iterate(
    params: Omit<CursorParams, 'cursor'> & { filters?: DebtLedgerFilters } & PaginateOptions = {},
    opts: RequestOptions = {},
  ): AsyncGenerator<DebtLedgerEntry, void, undefined> {
    const { maxPages, maxItems, ...rest } = params;
    return paginate((cursor) => this.list({ ...rest, cursor }, opts), { maxPages, maxItems });
  }
}
