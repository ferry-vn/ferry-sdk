# Changelog

All notable changes to this repository are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/). The three packages are versioned together.

## [Unreleased]

### Changed

- Copyright holder is now Ferry VN JSC: `NOTICE` files, the packages' `author` field and the Claude Desktop bundle's author.
- The README is rewritten for integrators (API keys, environments, what moves money, links to [docs.ferry.vn/developers](https://docs.ferry.vn/developers/)); the development scripts and the release process moved to `CONTRIBUTING.md`.

## [1.0.0] - 2026-10-19

First public release: `@ferryvn/sdk`, `@ferryvn/cli` and `@ferryvn/mcp` under Apache-2.0. Every endpoint and response shape was re-verified against backend v3.2.16. That includes `api_key` permissions, real response bodies, error shapes, rate limits and webhooks.

### Security

- **MCP Streamable HTTP mode — DNS rebinding.** Before this release, `ferry-mcp --http` accepted requests with any `Host`/`Origin`. A malicious web page could therefore call its tools with your API key, including write tools when they were enabled. Changes:
  - `Host` and browser `Origin` headers are now validated.
  - An optional bearer token (`FERRY_MCP_HTTP_TOKEN`) is added. It is mandatory for non-loopback binds.
  - Only POST is accepted, the body is limited to 1 MB, and request/header timeouts are set.
  - `/healthz` was added for health checks.
- **SDK in browsers.** The client refuses to start with an API key in a browser unless `dangerouslyAllowBrowser: true` is set. The key has organization-admin power.
- **Logging.** Hooks and debug logs redact `Authorization`. `FerryApiError.toJSON()` omits response bodies, which may contain personal data.
- **CSV output.** CLI CSV output neutralises spreadsheet formula injection.

### Added

- **Route prices** — `ferry.prices.forRoute()`, `ferry prices` and the MCP tool `get_route_prices`: the selling price (incl. VAT and your price additions, plus the per-ticket harbor fee) of every voyage × seat type × ticket type on a route for a date or range, with age rules; `live` re-prices a few voyages from their seat map. Vehicle places and ticket types the API cannot book (e.g. Superdong invitations at 30 000 ₫) are hidden by default.
- **SDK**
  - New resources:
    - `customers`: create, get, update, list, search
    - `organization`: `me`, `reservableCredit`
    - `transactions` and `debtLedger`: read-only
    - `bookings.getPublic` and `bookings.listChildOrgBookings`
  - **Booking builder** (`ferry.bookingDrafts.prepare/create`, `buildLegTickets`). You pass seats (or let it pick adjacent ones) and passengers. It picks ticket types by age and nationality with the backend's operator rules, matches prices, checks free seats, duplicate social ids and the operator's input-length rules, resolves nationalities (ISO code or operator id), quotes the total (tickets + harbor fees − vouchers) and reports every issue locally.
  - Voyage and seat helpers: `isVoyageBookable`, `voyageUnbookableReason`, `voyageDeparture`, `voyageHarborFee`, `seatRef`, `resolveNational`, `parseIssueTicketError` / `formatIssueTicketError`, `nowInVietnam`.
  - Per-request options on every method: `signal`, `timeoutMs`, `maxRetries`, `headers`, `requestId`.
  - `iterate()` auto-pagination on every cursor list, plus `collect()`.
  - `hooks` (`onRequest`, `onResponse`, `onRetry`) and a `debug` logger.
  - An `x-request-id` on every request, exposed on errors.
  - A locations cache, which makes repeated name lookups cost one request.
  - Errors:
    - New classes `FerryPermissionError` (403), `FerryConflictError` (409), `FerryServerError` (5xx), `FerryConnectionError`, `FerryAbortError`, `FerryConfigError` and `FerryBookingDraftError`.
    - `FerryErrorCode` constants and `errorCodeName()`.
    - `userMessage` (Vietnamese text from the backend).
  - Webhook helpers: `parseWebhook` (typed by `x-event-type`), `safeEqual`, `WEBHOOK_EVENTS`.
  - Date and money helpers: `todayInVietnam`, `addDays`, `isValidYmd`, `formatVnd`, `ticketFileUrls`.
  - Enums: `OrderPaymentStatus`, `TicketStatus`, `TicketPaymentStatus`, `Gender`.
- **CLI**
  - Profiles (`--profile`, `profiles list|use`, `FERRY_PROFILE`).
  - `--output table|json|ndjson|csv`.
  - New commands: `booking draft` (passengers from CSV/JSON), `booking update|tickets|public`, `orders list`, `customers`, `account`, `transactions`, `debts`, `vouchers`, `disruptions`, `calendar`, `operators`, `api`, `doctor`, `completion`.
  - `whoami --check`.
  - Interactive confirmation for `booking issue` (shows the total and reservable credit) and `cancel request`.
  - Distinct exit codes: 3 auth, 4 not found, 5 rate limited.
  - `--date today|tomorrow`.
  - `--debug`.
- **MCP**
  - New read tools: `get_voyage_calendar`, `find_customers`, `get_disruptions`, `get_account`, `list_vouchers`.
  - New write tool `create_customer`, and the read-only `quote_booking` (validates and prices a booking without creating it).
  - `create_booking` now takes seat names and passengers, and builds the payload with the booking builder.
  - Write confirmation through MCP elicitation when the client supports it.
  - A write budget (`FERRY_MCP_MAX_WRITES`) and a JSON audit log (`FERRY_MCP_AUDIT_FILE`).
  - `structuredContent` with compact JSON text.
  - Prompts `plan_ferry_trip` and `check_booking`, and the resource `ferry://locations`.
  - A Claude Desktop bundle (`.mcpb`), a Dockerfile for HTTP mode, and an MCP Registry `server.json`.
- **Repository**
  - Biome, coverage thresholds, publint, are-the-types-wrong, and a pack-and-install test.
  - A CI matrix: Node 22 and 24; an SDK runtime smoke test on Node 20; Windows and macOS.
  - A tag-triggered release workflow (GitHub release + npm), Dependabot, and nightly read-only UAT contract tests.
  - Lockstep versioning (`npm run version:set`).
  - `openapi/sdk.json`, a filtered partner surface. Generated types shrink from 412 KB to 224 KB.

### Verified on UAT

Before release, the SDK, CLI and MCP were run read-only against UAT (`api.ferryvn.net`, 2026-10-07) on six operators. Fixed from what real data showed:
- Seat maps counted seats the operator does not render (Lightning68: 48 extra seats); free seats now equal the voyage's `no_remain`.
- Repeated seat names (Saigon Watergo `C23`/`C24`) silently mapped to one seat; they are now resolved or refused with `NAME#POSITION_ID` refs.
- The default nationality fell back to the first list entry when no entry was flagged default (GreenLines); it is now Vietnam.
- Auto-picked seats could mix seat types and scatter a group; ticket types were ranked by the "default" flag instead of price; priced-but-unconfigured types (invitations) could be chosen; the NATIONAL_ID rule and the operators' social-id / home-town length rules were not applied.
- The quote ignored harbor fees and vouchers.
- `boatLayouts.latestByVoyageId/byVoyageId` returned `undefined` on an empty 204 (now `FerryNotFoundError`).
- CLI/MCP listed operator-disabled voyages that cannot be sold (all UAT voyages at the time); they are now hidden by default (`--include-unavailable` / `include_unavailable`). `issue_ticket_error` (a JSON string) is now parsed; times show as `HH:mm`; `VoyageIsDisabled` and 403 errors carry actionable hints; MCP `get_seat_map` is grouped by seat type and `list_bookings` returns brief rows.
- Sanitized UAT supply fixtures (`packages/sdk/test/fixtures/uat-supply.json`) back the regression tests.

### Verified on production

The same checks were then run read-only against production (`api.ferry.vn`, 2026-10-07; 478 voyages on 51 routes, one live seat map per operator, nothing created or issued). Fixed:
- Thạnh Thới and Bình An Hà Tiên sell motorbike/car places as seat types (`Xe gắn máy`, `XEMAY<195`, `OTO4-5`), often cheaper than a passenger seat: auto-pick only uses passenger seat types (those with a default price, never vehicle places — `isVehicleSeatType`), and a passenger put on a vehicle place without a plate gets a warning. Vehicle places price every ticket type the same; the lowest type id is used instead of failing.
- Their seat maps carry no ticket-type rules (Thạnh Thới publishes them on the voyage instead): the builder falls back to the voyage's rules and warns that FerryVN validates ticket types against the seat map and may refuse the booking (`InvalidTicketTypeId`).
- Operators' name-length rule (Thạnh Thới, Bình An Hà Tiên, Cảng Sa Kỳ: 4–12 characters), which FerryVN does not check at creation, is reported as a warning.
- Vouchers: unique vouchers cannot be combined and per-customer limits are applied, as the server does at creation (the check endpoint does neither).
- CLI/MCP hints for `CanNotGetBoatVoyage` (operator seat map unavailable) and `CannotFindBoatLayoutFromVoyage` (no stored seat map yet); MCP flags vehicle places in `get_seat_map` and says search prices are indicative (Thạnh Thới listed 290 000 ₫ while its live seat map charged 365 000 ₫).
- Contract tests run against production with `FERRY_CONTRACT_ENV=production FERRY_CONTRACT_API_KEY=…`.
- Write path checked with two real `Requested` bookings (no payment, no issuance): the server's totals matched the builder's quote to the đồng (Saigon Watergo 418 000 ₫; Superdong Sóc Trăng → Côn Đảo 684 182 ₫ incl. 36 000 ₫ harbor fees). The CLI now also shows the organization's cost (`total_net_price`).
- Sanitized production supply fixtures (`packages/sdk/test/fixtures/prod-supply.json`) back the new regression tests.

### Pre-release audit

A line-by-line audit of the three packages before publishing (2026-10-18). Fixed:
- **SDK transport and errors:** an abort fired during an async `onRequest` hook is honoured; per-call `timeoutMs` / `maxRetries` are validated and timeouts capped below the `setTimeout` overflow (`MAX_TIMEOUT_MS`); header redaction keeps only the auth scheme and hides cookies and `x-api-key` entirely; query strings (search terms, phone numbers) stay out of error messages and `toJSON()`; HTML error pages no longer become the message; string error codes (disruption endpoints) are read.
- **SDK resources:** `routes/orders/vouchers/bookings.get` throw `FerryNotFoundError` on an empty body; `cancelTicketRequests.get` throws instead of returning `null`; `voyageCounts.list` requires `from`/`to` (the backend refuses without them); `routes.list` takes `order` like the other lists; `refreshTicketFiles` is never retried; booking and transaction `createdAtFrom/To` given as `YYYY-MM-DD` mean Vietnam days (`vietnamDayStart/End`); OpenAPI patches type the disruption, cancel-refund, organization-id and condition fields the backend's Swagger left empty.
- **Booking builder:** passengers whose name, social id or home town is not text are reported (numbers lose a CCCD's leading zeros); voyages that left earlier today are refused; auto-pick prefers a seat type every passenger can have a ticket on (Hoà Bình infants only fit VIP) and orders floors by position; social ids are compared exactly and the last matching price row wins, as on the server.
- **CLI:** `--output` is validated before any request (a bad value used to surface only after a booking or cancel request was created); an explicit `--profile` / `FERRY_PROFILE` wins over `FERRY_API_KEY`, unknown profiles are refused and a profile's key keeps its endpoint; an unparsable config file is reported instead of being overwritten; 403 exits 3 and a missing input file exits 2; passenger files accept accent-insensitive Vietnamese headers (`Họ tên`, `Ngày sinh`, `Số CCCD`…), ignore Excel's empty columns and refuse non-UTF-8 exports with a "CSV UTF-8" hint; CSV output keeps raw amounts; `ferry api` asks before POST/PATCH/PUT/DELETE (`--yes`); `transactions` dates are validated.
- **MCP:** write tools are left out over `--http` unless `FERRY_MCP_HTTP_ALLOW_WRITES=true` (stateless HTTP has no confirmation dialog); the HTTP bearer token is also mandatory when non-loopback hosts or origins are allowed; tool arguments are strict (unknown keys are errors, not silently dropped); `request_cancellation` confirms with the voyage and passenger names and refuses unknown or already-cancelled positions; `get_route_prices` lists ticket-type rules once per voyage, returns 10 voyages by default (max 30) and covers at most 7 days; `FERRY_MCP_DISABLED_TOOLS` hides chosen tools.
- **Packaging:** the `.mcpb` bundle and the Docker image ship `THIRD_PARTY_NOTICES.txt` (the licenses of the bundled dependencies); the packer is pinned (`@anthropic-ai/mcpb@2.1.2`); a tag creates the GitHub release (with the `.mcpb`), npm publishing runs only from a tag and only once the `NPM_PUBLISH` repository variable is `true`, `-rc` versions become GitHub pre-releases, and every step can be re-run.

### Changed

- **Breaking changes**
  - `toYmd(Date)` and every date parameter use the **Vietnam** calendar day. Before this, they used UTC, which searched the previous day for times before 07:00 in Vietnam.
  - `bookings.confirmToIssue()` resolves with `void`. The backend returns an empty body; read the result with `bookings.get(id)`. Its default timeout is now at least 10 minutes, because issuance is synchronous with the operator.
  - `bookings.downloadTickets()` was renamed to `refreshTicketFiles()` and resolves with `void`.
  - `vouchers.checkApplicability()` returns `{ isApplicable, voucher }`.
  - List `sort` strings were replaced by `order: 'asc' | 'desc'`. The backend only sorts by `_id`. `locations.list({ sort })` was removed.
  - 403 throws `FerryPermissionError` (a `FerryApiError`, deliberately not a `FerryAuthError`: FerryVN also answers 403 for ids that do not exist or belong to another organization, so it must not read as a bad key). 5xx throws `FerryServerError`. Caller aborts throw `FerryAbortError`.
  - MCP `create_booking` input is redesigned: `passengers` + `depart`/`return` legs with seat names, instead of raw ticket DTOs.
  - MCP `search_locations` returns `{ locations: [...] }`.
- **CLI config** moves to profiles. The 0.x file is read as the `default` profile.
- **CLI `login`** verifies the key with `organizations/me` and shows the organization.
- **Node requirements:** CLI and MCP require Node ≥ 22.12. The SDK supports Node ≥ 20.
- **Dependencies:** zod 4, commander 15, vitest 5.

### Fixed

- A `Retry-After` longer than `maxDelayMs` is no longer cut short and retried. The SDK throws `FerryRateLimitError` with `retryAfterMs`.
- Invalid options (for example `FERRY_TIMEOUT_MS=abc`, which made every request time out immediately) now fail fast with a clear error.
- The CLI ignored `--env` once a base URL had been stored by `login`. The endpoint now resolves flags > env vars > profile. The CLI also honours `FERRY_ENV`.
- Abort listeners leaked across retry waits.
- Domain errors whose message the backend drops now carry the code's name instead of a bare "HTTP 422".
- `GET /customers/:id`, `/transactions/:id` and `/boatLayouts/:id` answer "not found" with an empty 204. These now raise `FerryNotFoundError`.
- `organizations/reservable-credit` is sent as text. It is now parsed as a number.

## [0.1.0] - 2026-10-06

### Added

- `openapi/partner.json` + `openapi/public.json` extracted from ferry-ticket-back-end v3.2.16.
- `@ferryvn/sdk`, `@ferryvn/cli` (`ferry`), `@ferryvn/mcp` (`ferry-mcp`) initial versions; CI.
