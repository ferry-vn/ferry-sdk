# FerryVN SDK · CLI · MCP

Official TypeScript SDK, command-line tool and MCP server for the **FerryVN** ferry-ticket platform API (partner tier).

| Package | | |
|---|---|---|
| [`@ferryvn/sdk`](packages/sdk) | `npm i @ferryvn/sdk` | Zero-dependency `fetch` client (Node ≥ 20, Bun, Deno, edge), typed from the real API, booking builder, webhooks helpers |
| [`@ferryvn/cli`](packages/cli) | `npm i -g @ferryvn/cli` | `ferry`: voyages, seat maps, bookings from a spreadsheet, customers, cancellations; table/JSON/CSV output |
| [`@ferryvn/mcp`](packages/mcp) | `npx -y @ferryvn/mcp` | MCP server (`ferry-mcp`) for Claude and other AI agents; read-only by default, confirmed writes are opt-in |

Licensed under [Apache-2.0](LICENSE).

---

## Tiếng Việt

Bộ công cụ chính thức cho đối tác (đại lý, OTA), nhân viên nội bộ và AI agent làm việc với API bán vé tàu cao tốc FerryVN.

- **SDK** (`@ferryvn/sdk`): client TypeScript cho API tier đối tác (`/api/v1/...`).
  - Xác thực bằng API key qua header `Authorization: Bearer <key>`. Key do admin tổ chức tạo trong dashboard.
  - Có timeout, tự retry riêng cho GET, lỗi có kiểu kèm mã lỗi nghiệp vụ (`FerryErrorCode`) và `x-request-id` để tra log.
  - **Booking builder**: chỉ cần mã chuyến, tên ghế và thông tin hành khách. SDK tự chọn loại vé theo tuổi (người lớn / trẻ em / người cao tuổi, theo luật của từng hãng), khớp giá và kiểm ghế trống, CCCD trùng, *trước khi* gửi.
- **CLI** (`ferry`):
  - Ví dụ: `ferry voyages search --from "Rạch Giá" --to "Phú Quốc" --date tomorrow`, `ferry seats <voyageId>`, `ferry customers --search 0901234567`.
  - `ferry booking draft ... --passengers khach.csv` đọc danh sách hành khách từ file CSV (từ Excel: Save As → "CSV UTF-8") hoặc JSON.
  - `ferry booking list --output csv > don.csv` xuất danh sách cho kế toán.
  - Hỗ trợ nhiều profile (production / UAT).
- **MCP** (`ferry-mcp`): cho Claude Desktop / Claude Code tra cứu tuyến, chuyến, lịch chuyến, sơ đồ ghế, khách hàng, đơn hàng, sự cố thời tiết.
  - Công cụ ghi (tạo khách hàng, tạo đơn, yêu cầu huỷ) **chỉ bật khi** `FERRY_MCP_ENABLE_WRITES=true`.
  - Mỗi lần ghi đều phải được người dùng xác nhận, có hạn mức số lần ghi và audit log.
  - **Không bao giờ** có xuất vé / thanh toán / rút tiền / điều chỉnh số dư / quản trị tổ chức.

Lưu ý quan trọng (đã kiểm chứng trong mã backend):

- **Tạo booking:** **không** trừ tiền, **không** giữ ghế.
- **Xuất vé (`confirmToIssue`):**
  - Trừ số dư và hạn mức của tổ chức; phần khách thiếu được ghi nợ (`PaidWithDebt`).
  - Với hãng tự động có thể mất vài phút.
  - CLI yêu cầu xác nhận; MCP không hỗ trợ.
- **Không có idempotency key:** backend không hỗ trợ ⇒ SDK không bao giờ tự retry POST. Nếu lỗi mạng, kiểm tra `booking list` trước khi gửi lại.
- **Webhook:** backend **không ký** và chỉ gửi **một lần**. Đặt token bí mật trong URL và đối soát định kỳ bằng API.

---

## Quick start

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

```bash
ferry login
ferry voyages search --from "Rạch Giá" --to "Phú Quốc" --date tomorrow
ferry seats <voyageId>
ferry booking draft --customer 1001 --orderer-name "Nguyễn Văn A" --email a@example.com \
  --voyage <voyageId> --seats A1,A2 --passengers passengers.csv --out booking.json
ferry booking create --file booking.json
```

```bash
claude mcp add ferryvn -e FERRY_API_KEY=<key> -- npx -y @ferryvn/mcp
```

Each package README has the full reference: [SDK](packages/sdk/README.md) · [CLI](packages/cli/README.md) · [MCP](packages/mcp/README.md).

## API surface

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

\* only with `FERRY_MCP_ENABLE_WRITES=true` (over `--http` also `FERRY_MCP_HTTP_ALLOW_WRITES=true`), and each call is confirmed by the user.

## How the types stay correct

- **Extraction:** `openapi/partner.json` is extracted from the backend source, not written by hand. `scripts/extract-openapi.ts` boots the NestJS app in preview mode, so no database is needed.
- **Filtering:** `scripts/filter-openapi.ts` keeps the operations an API key can actually call, and corrects responses whose Swagger metadata is wrong. Corrections are marked `x-ferry-sdk-patch` and were verified in the backend code. The result is written to `openapi/sdk.json`.
- **Generation:** types are generated from `openapi/sdk.json` with `openapi-typescript`. CI fails if the generated files are stale.
- **Drift detection:** a nightly read-only contract suite (`contract/`) runs against UAT to catch backend drift.

```bash
npm run openapi:extract -- --backend ../ferry-ticket-back-end   # needs a backend checkout with node_modules
npm run generate                                                # filter + generate types
```

## Development

```bash
npm ci
npm run verify   # version check, lint, typecheck, tests + coverage, build, smoke tests, package checks
```

| Script | |
|---|---|
| `npm test`, `npm run test:coverage` | Vitest with mocked fetch, no network |
| `npm run lint` / `lint:fix` | Biome |
| `npm run smoke:sdk` / `smoke:cli` / `smoke:mcp` | Built SDK (ESM + CJS); CLI help; MCP over stdio, with writes, and over HTTP (including DNS-rebinding rejection) |
| `npm run pack:check` | publint, are-the-types-wrong, `npm pack` + install + run |
| `npm run mcpb:pack` | Claude Desktop bundle `packages/mcp/ferry-mcp.mcpb` |
| `FERRY_UAT_API_KEY=… npm run test:contract` | live read-only checks against UAT |

Node ≥ 22.12 for development; the SDK runtime supports Node ≥ 20 (CI smoke-tests it on Node 20).

## Releasing

All three packages share one version.

```bash
npm run version:set -- 1.0.1 && npm install   # bumps manifests, version constants, server.json, MCPB manifest
# update CHANGELOG.md, commit, merge to main, then:
git tag v1.0.1 && git push origin v1.0.1
```

Pushing the tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml). It:
1. runs the full CI;
2. checks that the tag matches every package version;
3. **only when the repository variable `NPM_PUBLISH` is `true`**, publishes `@ferryvn/sdk` → `@ferryvn/cli` → `@ferryvn/mcp` to npm (`latest`; `next` for versions with a `-`, e.g. `1.1.0-rc.1`), with provenance when the repository is public — versions already on npm are skipped, so a failed run can be re-run;
4. creates the GitHub release (a pre-release for `-` versions) with the `.mcpb` bundle attached. While the packages are not on npm, its notes say so.

Running the workflow by hand on a branch is a dry run (build, `.mcpb`, `npm pack --dry-run`). To release without pushing a tag yourself, run it by hand on `main` with `release_tag` set (e.g. `v1.0.1`): it creates the tag on that commit together with the GitHub release. npm publishing only ever runs from a tag.

**GitHub first, npm later:** push the tag with `NPM_PUBLISH` unset to get only the GitHub release. When npm is ready, set `NPM_PUBLISH=true` (Settings → Secrets and variables → Actions → Variables) and run the Release workflow by hand on the tag (Actions → Release → Run workflow → `Use workflow from: Tags: vX.Y.Z`); it publishes to npm and refreshes the release notes.

One-time npm setup:
1. Create the `ferryvn` organization on npmjs.com (owns the `@ferryvn` scope).
2. In GitHub → Settings → Environments, create the `npm` environment (optionally with required reviewers, so every publish waits for an approval).
3. First release: create an npm **granular access token** with read and write access to the `@ferryvn` packages and store it as the `NPM_TOKEN` secret of that environment.
4. Once the packages exist: on npmjs.com, add a trusted publisher for each package (GitHub Actions, repository `ferry-vn/ferry-sdk`, workflow `release.yml`, environment `npm`), then delete the token.

## License

[Apache-2.0](LICENSE) © 2026 KDIGI. See [NOTICE](NOTICE).
