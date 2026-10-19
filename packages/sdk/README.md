# @ferryvn/sdk

Official TypeScript client for the **FerryVN** ferry-ticket partner API. Zero runtime dependencies, `fetch`-based: Node.js ≥ 20, Bun, Deno, Cloudflare Workers and other edge runtimes. ESM and CommonJS.

```bash
npm install @ferryvn/sdk
```

```ts
import { FerryClient } from '@ferryvn/sdk';

const ferry = new FerryClient({ apiKey: process.env.FERRY_API_KEY }); // Authorization: Bearer <key>

const [from] = await ferry.locations.find('Rạch Giá');
const [to] = await ferry.locations.find('phu quoc');
const { data } = await ferry.voyages.search({ date: '2026-10-20', departureId: from.id, destinationId: to.id });
```

API keys are created by an organization admin in the FerryVN dashboard. Use `environment: 'uat'` with a UAT key while integrating.

## Options

| Option | Default | Notes |
|---|---|---|
| `apiKey` | — | Not needed for locations, routes, operators and `bookings.getPublic`. |
| `environment` | `'production'` | `'production'` → `https://api.ferry.vn`, `'uat'` → `https://api.ferryvn.net` |
| `baseUrl` | — | Explicit origin (overrides `environment`). The SDK appends `/api/v1`. |
| `timeoutMs` | `30000` | Per attempt. `bookings.confirmToIssue` uses at least 10 minutes. |
| `retry` | `{ maxRetries: 2, baseDelayMs: 300, maxDelayMs: 5000 }` | GET/HEAD only, on network errors, 408, 429, 502, 503, 504. A `Retry-After` longer than `maxDelayMs` is surfaced instead of retried. |
| `language` | — | `x-custom-lang` header (`vi`, `en`). |
| `hooks` | — | `onRequest`, `onResponse`, `onRetry` callbacks (headers redacted). |
| `debug` | `false` | `true` logs to `console.debug`, or pass `(message, details) => …`. Never logs the key. |
| `cache.locationsTtlMs` | `600000` | In-memory cache for `locations.list()` (used by every name lookup). `0` disables. |
| `fetch`, `headers`, `userAgent` | — | Custom fetch (proxies, tests), extra headers, UA (ignored in browsers). |
| `dangerouslyAllowBrowser` | `false` | See [Browsers](#browsers). |

Invalid options throw `FerryConfigError` immediately.

Every method takes a last `RequestOptions` argument: `{ signal, timeoutMs, maxRetries, headers, requestId }`.

## Resources

| Resource | Methods |
|---|---|
| `locations` | `list()`, `find(query)` — accent-insensitive name / abbreviation / id, cached |
| `routes` | `list({ filters, cursor, limit })`, `iterate()`, `get(id)` |
| `operators` | `list()`, `nationals(operatorId)` — values for a ticket's `national_id` |
| `voyages` | `search({ date, departureId, destinationId, filters })`, `searchRange({ from, to, … })`, `iterate()`, `get(id)` |
| `voyageCounts` | `list({ departureId, destinationId, from, to })` — voyages per day |
| `prices` | `forRoute({ departureId, destinationId, date \| from+to, live })` — selling prices of a route per voyage × seat type × ticket type, with harbor fee and age rules (see [Route prices](#route-prices)) |
| `boatLayouts` | `latestByVoyageId(id)`, `byVoyageId(id)`, `get(id)` — seat maps (see `flattenSeatMap`). `latestByVoyageId` asks the operator live when FerryVN's ~5-minute cache is cold: do not poll it across many voyages; `byVoyageId` reads the stored copy |
| `bookingDrafts` | `prepare(input)`, `create(input)` — see [Booking builder](#booking-builder) |
| `bookings` | `create(input)`, `get(id)`, `list({ filters, order })`, `iterate()`, `update(id, input)`, `confirmToIssue(id)` ⚠ moves money, `refreshTicketFiles(id)`, `getPublic(id)`, `listChildOrgBookings()` |
| `orders` | `list({ filters })`, `iterate()`, `get(id)` |
| `cancelTicketRequests` | `create(input)` ⚠ holds a fee, `list({ filters })`, `iterate()`, `get(id)` |
| `customers` | `create(input)`, `get(id)`, `update(id, input)`, `list({ filters })`, `iterate()`, `search(text)` |
| `organization` | `me()`, `reservableCredit()` |
| `transactions` | `list({ filters })`, `iterate()`, `get(id)` — read-only |
| `debtLedger` | `list({ filters })`, `iterate()` — read-only |
| `vouchers` | `list()`, `get(id)`, `checkApplicability({ voucher_code, order_payload })` |
| `disruptions` | `list({ updatedSince, state, bookingId })`, `iterate()`, `get(id)`, `forBooking(bookingId)` |
| `request()` | Escape hatch: `ferry.request({ method, path: '/api/v1/…', query, body })`, with the same auth, retries, hooks and errors |

Every `list()` returns `{ data, next_cursor }`. Partner lists cap `limit` at 50 (routes: 100). `iterate()` follows cursors for you:

```ts
for await (const booking of ferry.bookings.iterate({ filters: { booking_statuses: [BookingStatus.Booked] } })) { … }
```

## Booking builder

Building a booking by hand means 17 fields per ticket, taken from two different structures. The ticket type has to match the passenger's age and the price row has to match the seat type. `bookingDrafts` does this for you. It applies the backend's rules locally and reports every problem before anything is sent.

```ts
const { booking, draft } = await ferry.bookingDrafts.create({
  customerId: 1001, // ferry.customers.search('0901234567') / customers.create(...)
  ordererName: 'Nguyễn Văn A',
  contactEmail: 'a@example.com',
  depart: {
    voyageId,
    seats: ['A1', 'A2'], // or 'C23#25' (NAME#POSITION_ID) where a boat repeats a name; omit to auto-pick
    passengers: [
      { name: 'Nguyen Van A', dateOfBirth: '1990-05-01', socialId: '079090000001', homeTown: 'Cần Thơ', gender: 'male' },
      { name: 'Nguyen Van B', dateOfBirth: '2018-03-02', socialId: '079090000001', homeTown: 'Cần Thơ' },
      { name: 'John Doe', dateOfBirth: '1985-02-03', socialId: 'P1234567', homeTown: 'London', nationalId: 'GB' },
    ],
    voucherCodes: ['SUMMER'],
  },
});
draft.depart.tickets; // seat, ticket type ("Người lớn" / "Trẻ em" …), price and harbor fee per passenger
draft.estimatedTotalVnd; // tickets + harbor fees − vouchers, as the server computes total_price
```

The builder mirrors the backend (v3.2.16) and the operator data it publishes:
- **Seats** must exist, be sellable and free. Seats the operator does not render (`IsRenders = false`) are not seats. A name used by several seats is refused as ambiguous unless only one of them is free; use `NAME#POSITION_ID` (`seatRef(seat)`). A seat that shares its name with a seat of another type is refused, because the server validates the type of the *first* seat with that name.
- **Auto-pick** (no `seats`): the cheapest passenger seat type with enough free seats (or `seatType`), adjacent seats in the operator's order when possible; a warning says when the group is split or another seat type was available. Vehicle places that some operators sell as seat types (`isVehicleSeatType`) are never auto-picked.
- **Ticket type** from age and nationality, with the operator's MIN/MAX_AGE (/ _WITH_DATE) and NATIONAL_ID rules; foreigners count as at most 35 on most operators, like the backend. When several types fit, the cheapest is chosen (with a warning). Types without a configured rule (e.g. invitations) are never chosen automatically. When the seat map has no rules, the voyage's published rules are used and a warning says the server may refuse the booking.
- **Nationality** defaults to Vietnam; `nationalId` also accepts an ISO code or country name and is resolved to the operator's own id (`1`, `"VN"`, `"Viet Nam"` depending on the operator).
- **Operator input rules**: social-id and home-town length (often 3–15 characters), passport expiry for foreign adults where required.
- **Social ids** must be unique, except on the child ticket types the server exempts.
- **Price quote**: ticket price incl. VAT + the operator's per-ticket harbor fee on the route (`voyageHarborFee`), minus vouchers checked with `vouchers.checkApplicability` (`checkVouchers: false` skips it).

Use `prepare()` to get the payload and quote without creating anything. Failures throw `FerryBookingDraftError` with an `issues` array. `isVoyageBookable(voyage)` / `voyageUnbookableReason()` tell which search results can be sold (the API also returns disabled, sold-out and departed voyages).

## Route prices

```ts
const [rg] = await ferry.locations.find('Rạch Giá');
const [pq] = await ferry.locations.find('Phú Quốc');
const { voyages } = await ferry.prices.forRoute({ departureId: rg.id, destinationId: pq.id, date: '2026-11-01', live: 3 });
for (const v of voyages) console.log(v.departure, v.operatorName, formatVnd(v.defaultFromVnd), v.source);
```

- Prices are **selling prices** — `price_with_VAT`, after the operator's promotions and your organization's price additions; it is what the server charges (`total_price`). Your cost (`base_price`) is never returned by the API.
- Each entry carries the per-ticket harbor fee, `totalVnd`, and the ticket type's age/nationality rules (`MIN_AGE 1, MAX_AGE 11`).
- Hidden by default: vehicle places, zero-price types and ticket types the API cannot book (priced but not covered by the operator's rules — the server refuses them). `includeVehicles` / `includeAllTicketTypes` show them.
- Without `live` the prices come from synced voyage data (one search request) and can lag the operator — a Thạnh Thới voyage listed at 290 000 ₫ charged 365 000 ₫ from its seat map. `live: n` (max 10) re-prices the first n voyages from their seat map; each may query the operator.

## Money-moving calls

**`bookings.create`** does not charge money and does not hold seats. The booking starts `Requested` / `NotPaid` with a payment deadline. The response is not populated; call `get(id)` for the full booking (it carries `total_price` for the customer and `total_net_price`, your organization's cost). The partner API cannot cancel a `Requested` booking: FerryVN expires unpaid orders automatically once the voyage departs. The server prices from its *stored* seat map, so call `boatLayouts.latestByVoyageId` (or `bookingDrafts.prepare`) first on operators whose seat maps are fetched on demand — otherwise creation fails with `CannotFindBoatLayoutFromVoyage`. Verified on production: two bookings created through `bookingDrafts.create` and `ferry booking draft --create` were priced by the server exactly as quoted (incl. harbor fees).

**`bookings.confirmToIssue(id)`** charges your organization's balance and credit. A customer shortfall is lent as debt, so the booking usually ends `PaidWithDebt`. It then places the real order with the operator.
- **Response:** the method resolves with no value. Read the outcome with `get(id)`.
- **Automatic operators:** tickets are issued during the call, which can take minutes. The result is `Booked`.
- **Manual operators:** the order goes to `WaitForIssue` and staff issue the tickets later.
- **Failure:** the payment is reset to `NotPaid` and `order.issue_ticket_error` is set.
- **Retries:** never retried automatically. Limited to 5 attempts per booking per minute.

**`cancelTicketRequests.create`** has these effects:
- It holds the cancellation service fee from the customer's wallet immediately. Error `160105` means the wallet cannot cover it.
- It marks the tickets cancelled at once.
- It starts an approval chain.

**Idempotency:** the backend has no idempotency keys, so writes are never retried. After a timeout, look the booking up with `bookings.list({ filters: { namePhoneEmail } })` before you re-submit.

## Errors

Everything thrown extends `FerryError`:

| Class | When |
|---|---|
| `FerryApiError` | any non-2xx: `status`, `errorCode`, `errorName`, `fieldErrors`, `userMessage` (Vietnamese), `requestId`, `retryAfterMs`, `body`, `toJSON()` (no body) |
| ↳ `FerryAuthError` (401) | Invalid or revoked key. |
| ↳ `FerryPermissionError` (403) | Not allowed. FerryVN also answers 403 for ids that do not exist or belong to another organization. Not a `FerryAuthError`. |
| ↳ `FerryNotFoundError` (404), `FerryConflictError` (409), `FerryValidationError` (422), `FerryRateLimitError` (429), `FerryServerError` (5xx) | |
| `FerryConnectionError` → `FerryTimeoutError`, `FerryNetworkError`, `FerryAbortError` | No response, timed out, or aborted by your `AbortSignal` |
| `FerryConfigError` | Bad options or arguments (before any request) |
| `FerryBookingDraftError` | Booking builder validation (`issues[]`) |

Domain codes are available as constants: `FerryErrorCode.OrganizationBalanceNotEnough === 120120`, `FerryErrorCode.UnavailableSeats === 150201`, …; `errorCodeName(code)` gives the name.

Every request carries an `x-request-id` (generated, or `requestId` per call). The backend logs it, so quote it to FerryVN support.

## Webhooks

FerryVN webhooks are configured per organization in the dashboard. They are **not signed** and are delivered **at most once** (one `POST`, 2-second timeout, no retries). Protect your endpoint as follows:
- Put an unguessable secret in the URL and compare it with `safeEqual`.
- Answer quickly.
- Reconcile by polling, because missed events are never resent.

```ts
import { parseWebhook, safeEqual } from '@ferryvn/sdk';

app.post('/ferry/hook/:secret', express.json(), (req, res) => {
  if (!safeEqual(req.params.secret, process.env.FERRY_WEBHOOK_SECRET!)) return res.sendStatus(404);
  res.sendStatus(204);
  const event = parseWebhook({ headers: req.headers, body: req.body }); // typed by x-event-type
  if (event.category === 'booking') refresh(event.data.id);
});
```

## Dates and money

- Schedules are in Vietnam time. `toYmd(date)` formats a `Date` as the **Vietnam** calendar day, so 00:30 on the 20th in Vietnam gives `2026-10-20` in any time zone. Related helpers: `todayInVietnam()`, `addDays()`, `isValidYmd()`.
- Prices are VND integers. `formatVnd(1250000)` returns `1.250.000 ₫`.

## Browsers

A partner API key has organization-admin power. It can create bookings, issue tickets against your balance and change settings. Keep it on your server. The client therefore refuses to start in a browser with an `apiKey` unless you pass `dangerouslyAllowBrowser: true`. Anonymous calls such as `locations` and `getPublic` work in browsers without a key.

## Migrating from 0.x

- **Dates:** `toYmd(Date)` now uses Vietnam time instead of UTC. It also throws `FerryConfigError` on malformed strings.
- **Removed and renamed methods:**
  - `confirmToIssue()` resolves with `void`.
  - `downloadTickets()` is now `refreshTicketFiles()` and resolves with `void`. Read the files with `ticketFileUrls(await bookings.get(id))`.
  - `checkApplicability()` resolves with `{ isApplicable, voucher }`.
  - The `sort` string option was replaced by `order: 'asc' | 'desc'`. The backend only sorts by creation time.
  - `locations.list({ sort })` was removed.
- **Errors:**
  - 403 now throws `FerryPermissionError`, a `FerryApiError` but not a `FerryAuthError` (in 0.x a 403 was a `FerryAuthError`): FerryVN also answers 403 for ids that do not exist, so `catch (e instanceof FerryAuthError)` no longer treats them as a bad key.
  - 5xx throws `FerryServerError`.
  - Aborts throw `FerryAbortError` instead of a raw `AbortError`.
  - Timeouts and network errors share the base class `FerryConnectionError`.
- **Imports:** `normalizeText` and `toYmd` moved out of the resources modules. Import them from the package root as before.
- **Types:** they are generated from a filtered spec (`openapi/sdk.json`), so `paths` / `operations` only cover the partner surface.

## License

Apache-2.0
