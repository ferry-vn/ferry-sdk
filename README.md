# Ferry VN SDK · CLI · MCP

[![CI](https://github.com/ferry-vn/ferry-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/ferry-vn/ferry-sdk/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Official TypeScript SDK, command-line tool and MCP server for the [Ferry VN](https://ferry.vn) partner API. Travel agencies, OTAs, internal staff and AI agents use them to search voyages across Vietnam's ferry operators, read seat maps and prices, and create and manage bookings.

| Package | Install | What it is |
|---|---|---|
| [`@ferryvn/sdk`](packages/sdk) | `npm i @ferryvn/sdk` | Zero-dependency `fetch` client (Node ≥ 20, Bun, Deno, edge runtimes; ESM + CJS), typed from the real API, with a booking builder and webhook helpers |
| [`@ferryvn/cli`](packages/cli) | `npm i -g @ferryvn/cli` | `ferry`: voyages, prices, seat maps, bookings from a spreadsheet, customers, cancellations; table / JSON / CSV output |
| [`@ferryvn/mcp`](packages/mcp) | `npx -y @ferryvn/mcp` | `ferry-mcp`: MCP server for Claude and other AI agents; read-only by default, writes are opt-in and confirmed |

> **Status:** v1.0.0 is on [GitHub Releases](https://github.com/ferry-vn/ferry-sdk/releases). The npm packages are not published yet. Until they are, use the self-contained Claude Desktop bundle (`ferry-mcp.mcpb`) from the release, or build from source with `npm ci && npm run build`.

**Documentation:** [docs.ferry.vn/developers](https://docs.ferry.vn/developers/) (integration guide, in Vietnamese) · [api.ferry.vn/docs](https://api.ferry.vn/docs) (API reference) · package references: [SDK](packages/sdk/README.md) · [CLI](packages/cli/README.md) · [MCP](packages/mcp/README.md)

## Before you start

- **API key.** An organization admin creates it in the Ferry VN dashboard. It is shown once, never expires, and carries organization-admin power: keep it server-side. The SDK refuses to run with a key in a browser unless you opt in.
- **Environments.** `production` (`https://api.ferry.vn`, the default) and `uat` for integration testing. **UAT is not a sandbox:** issuing tickets there reaches the real operator and spends your organization's real balance.

## Quick start

**SDK**

```ts
import { FerryClient } from '@ferryvn/sdk';

const ferry = new FerryClient({ apiKey: process.env.FERRY_API_KEY }); // environment: 'uat' while integrating

const [from] = await ferry.locations.find('Rạch Giá');
const [to] = await ferry.locations.find('phu quoc');
const { data: voyages } = await ferry.voyages.search({ date: '2026-10-20', departureId: from.id, destinationId: to.id });

const [customer] = await ferry.customers.search('0901234567');
const { booking } = await ferry.bookingDrafts.create({
  customerId: customer.id,
  ordererName: 'Nguyễn Văn A',
  contactEmail: 'a@example.com',
  depart: {
    voyageId: voyages[0].voyage.id,
    seats: ['A1'],
    passengers: [{ name: 'Nguyen Van A', dateOfBirth: '1990-05-01', socialId: '079090000001', homeTown: 'Cần Thơ' }],
  },
});
```

The booking builder takes a voyage, seat names and passengers. It picks each passenger's ticket type by age with the operator's rules, matches prices, and checks free seats and duplicate ID numbers *before* anything is sent.

**CLI**

```bash
ferry login                       # paste the key (hidden); verified and stored 0600
ferry voyages search --from "Rạch Giá" --to "Phú Quốc" --date tomorrow
ferry seats <voyageId>
ferry booking draft --customer 1001 --orderer-name "Nguyễn Văn A" --email a@example.com \
  --voyage <voyageId> --seats A1,A2 --passengers passengers.csv --out booking.json
ferry booking create --file booking.json
```

Passenger lists come from CSV (Excel: Save As → "CSV UTF-8") or JSON; see [`examples/`](examples). Profiles keep production and UAT keys apart.

**MCP**

```bash
claude mcp add ferryvn -e FERRY_API_KEY=<key> -- npx -y @ferryvn/mcp
```

Claude Desktop: open `ferry-mcp.mcpb` from the [release](https://github.com/ferry-vn/ferry-sdk/releases) and enter your key. Other clients, Streamable HTTP mode and Docker: see the [MCP README](packages/mcp/README.md).

## What moves money

| Action | Effect |
|---|---|
| Create a booking | Charges nothing and holds no seats. The booking starts unpaid, with a payment deadline. |
| Issue tickets (`confirmToIssue`) | Charges your organization's balance and credit (a customer shortfall is recorded as debt), then orders from the operator; automated operators can take minutes. The CLI asks for confirmation. **The MCP server never exposes it.** |
| Retries | The API has no idempotency keys, so the SDK never retries a POST. After a network error, check `booking list` before sending again. |
| Webhooks | Not signed and delivered once, with no retries. Put a secret token in the URL (`safeEqual`) and reconcile through the API. |

MCP write tools (`create_customer`, `create_booking`, `request_cancellation`) are off unless `FERRY_MCP_ENABLE_WRITES=true`; each call is confirmed by the user, counted against a write budget and written to an audit log. Payments, ticket issuance, balances and organization administration are never available over MCP.

## API coverage

| Area | SDK | CLI | MCP |
|---|---|---|---|
| Locations, routes, operators | `locations`, `routes`, `operators` | `ferry locations`, `routes`, `operators` | `search_locations`, `list_routes` |
| Voyages, calendar | `voyages`, `voyageCounts` | `ferry voyages search`, `calendar` | `search_voyages`, `get_voyage_calendar` |
| Route prices | `prices.forRoute` | `ferry prices` | `get_route_prices` |
| Seat maps, prices | `boatLayouts` + `flattenSeatMap` | `ferry seats` | `get_seat_map` |
| Customers | `customers` | `ferry customers` | `find_customers`, `create_customer`* |
| Bookings | `bookings`, `bookingDrafts` | `ferry booking …` | `quote_booking`, `get_booking`, `list_bookings`, `create_booking`* |
| Issue tickets (**moves money**) | `bookings.confirmToIssue` | `ferry booking issue` (confirmed) | never |
| Orders | `orders` | `ferry orders` | via `get_booking` |
| Cancellations | `cancelTicketRequests` | `ferry cancel …` (confirmed) | `list_cancel_requests`, `request_cancellation`* |
| Organization, transactions, debts | `organization`, `transactions`, `debtLedger` | `ferry account`, `transactions`, `debts` | `get_account` |
| Vouchers | `vouchers` | `ferry vouchers` | `list_vouchers` |
| Disruptions | `disruptions` | `ferry disruptions` | `get_disruptions` |
| Webhooks | `parseWebhook`, `safeEqual` | — | — |
| Anything else | `ferry.request()` | `ferry api` | — |

\* only with `FERRY_MCP_ENABLE_WRITES=true` (over `--http`, also `FERRY_MCP_HTTP_ALLOW_WRITES=true`); every call is confirmed by the user.

## How the types stay correct

- `openapi/partner.json` is extracted from the backend source, not written by hand.
- `scripts/filter-openapi.ts` keeps only what an API key can call and corrects responses whose Swagger metadata is wrong; each correction is verified in the backend code and marked `x-ferry-sdk-patch`. The result is `openapi/sdk.json`.
- Types are generated from `openapi/sdk.json` with `openapi-typescript`; CI fails when they are stale.
- A nightly read-only contract suite ([`contract/`](contract)) runs against UAT to catch backend drift.

## Tiếng Việt

Bộ công cụ chính thức để đại lý, OTA, nhân viên nội bộ và AI agent làm việc với API đối tác của Ferry VN: tra cứu chuyến tàu cao tốc của các hãng, sơ đồ ghế, giá vé, tạo và quản lý đơn.

- **SDK** (`@ferryvn/sdk`): client TypeScript cho API đối tác (`/api/v1/...`), xác thực bằng header `Authorization: Bearer <key>`. Có timeout, chỉ tự retry GET, lỗi có kiểu kèm mã nghiệp vụ (`FerryErrorCode`) và `x-request-id` để tra log. **Booking builder**: chỉ cần mã chuyến, tên ghế và thông tin hành khách; SDK tự chọn loại vé theo tuổi (theo luật từng hãng), khớp giá, kiểm ghế trống và CCCD trùng *trước khi* gửi.
- **CLI** (`ferry`): `ferry voyages search --from "Rạch Giá" --to "Phú Quốc" --date tomorrow`, `ferry seats <voyageId>`, `ferry customers --search 0901234567`. `ferry booking draft ... --passengers khach.csv` đọc danh sách hành khách từ CSV (Excel: Save As → "CSV UTF-8") hoặc JSON; `ferry booking list --output csv > don.csv` xuất cho kế toán. Hỗ trợ nhiều profile (production / UAT).
- **MCP** (`ferry-mcp`): cho Claude Desktop / Claude Code tra cứu tuyến, chuyến, lịch chuyến, sơ đồ ghế, khách hàng, đơn hàng, sự cố thời tiết. Công cụ ghi chỉ bật khi `FERRY_MCP_ENABLE_WRITES=true` và lần ghi nào cũng phải được người dùng xác nhận. **Không bao giờ** có xuất vé, thanh toán, điều chỉnh số dư hay quản trị tổ chức.

Lưu ý:

- **API key** do quản trị viên đại lý tạo trên Dashboard, chỉ hiển thị một lần và có quyền quản trị tổ chức: chỉ dùng phía server.
- **UAT không phải sandbox:** xuất vé trên UAT kết nối thẳng tới hãng tàu và trừ tiền thật của tài khoản đại lý.
- **Tạo booking** không trừ tiền, không giữ ghế. **Xuất vé** (`confirmToIssue`) trừ số dư và hạn mức của tổ chức (phần khách thiếu ghi nợ, `PaidWithDebt`); CLI hỏi xác nhận, MCP không hỗ trợ.
- **Không có idempotency key** ⇒ SDK không bao giờ tự retry POST. Lỗi mạng thì kiểm tra `booking list` trước khi gửi lại.
- **Webhook** không ký và chỉ gửi một lần: đặt token bí mật trong URL và đối soát định kỳ qua API.

Tài liệu tích hợp: [docs.ferry.vn/developers](https://docs.ferry.vn/developers/).

## Contributing, security, support

- Development setup, the type-generation pipeline and the release process: [CONTRIBUTING.md](CONTRIBUTING.md). Changes: [CHANGELOG.md](CHANGELOG.md).
- Maintainer docs (architecture, code standards, codebase summary, deployment, roadmap): [`docs/`](docs).
- Vulnerabilities: report privately as described in [SECURITY.md](SECURITY.md), never in a public issue.
- Bugs in these packages: [GitHub issues](https://github.com/ferry-vn/ferry-sdk/issues). Account, API key or booking questions: [hi@ferry.vn](mailto:hi@ferry.vn).

## License

[Apache-2.0](LICENSE). Copyright © 2026 Ferry VN JSC. See [NOTICE](NOTICE).
