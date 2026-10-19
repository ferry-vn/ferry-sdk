# @ferryvn/mcp — `ferry-mcp`

Official [Model Context Protocol](https://modelcontextprotocol.io) server for FerryVN. It lets Claude and other AI agents search Vietnam ferry voyages, read seat maps and prices, find customers, and read bookings, cancellations and disruptions. Booking writes are opt-in and always confirmed by a human. Payments and ticket issuance are never exposed. Node.js ≥ 22.12.

## Install

**Claude Desktop (one click):**
1. Download `ferry-mcp.mcpb` from the [GitHub release](https://github.com/ferry-vn/ferry-sdk/releases) and open it.
2. Enter your API key.
3. Optionally allow writes.

**Claude Code:**

```bash
claude mcp add ferryvn -e FERRY_API_KEY=<key> -- npx -y @ferryvn/mcp
# allow create_customer / create_booking / request_cancellation:
claude mcp add ferryvn -e FERRY_API_KEY=<key> -e FERRY_MCP_ENABLE_WRITES=true -- npx -y @ferryvn/mcp
```

**Any MCP client (`mcpServers` JSON):**

```json
{
  "mcpServers": {
    "ferryvn": {
      "command": "npx",
      "args": ["-y", "@ferryvn/mcp"],
      "env": { "FERRY_API_KEY": "<partner api key>", "FERRY_ENV": "production" }
    }
  }
}
```

## Tools

| Tool | Kind | |
|---|---|---|
| `search_locations` | read | ports / islands, accent-insensitive |
| `list_routes` | read | routes and their operators |
| `search_voyages` | read | date or date range, time window, operators; unsellable voyages hidden unless `include_unavailable` |
| `get_voyage_calendar` | read | voyages (and bookable ones) per day |
| `get_route_prices` | read | selling prices of a route (per voyage × seat type × ticket type, harbor fee, age rules); `live` re-prices a few voyages from seat maps |
| `get_seat_map` | read | free seats grouped by seat type, prices per seat/ticket type, harbor fee, ticket-type rules |
| `quote_booking` | read | validates a booking (seats, ages → ticket types, nationality, operator input rules, vouchers) and returns the total — nothing is created |
| `find_customers` | read | by phone / email / name |
| `get_booking`, `list_bookings` | read | status, deadline, orders, tickets (`list_bookings` returns brief rows) |
| `list_cancel_requests` | read | |
| `get_disruptions` | read | delays / cancellations affecting your bookings |
| `get_account` | read | balances, credit, reservable credit |
| `list_vouchers` | read | |
| `create_customer` | **write** | |
| `create_booking` | **write** | seat names + passengers → validated booking (`Requested` / `NotPaid`; no money moves, no seat hold) |
| `request_cancellation` | **write** | holds the cancellation fee; tickets are cancelled at once |

Prompts: `plan_ferry_trip`, `check_booking`. Resource: `ferry://locations`.

Tool results include `structuredContent`, plus compact JSON text for clients that only read text.

## Safety model

- **Never exposed:** ticket issuance (`confirmToIssue`), payments, transactions, withdrawals, top-ups, balance/credit adjustments, debt ledgers, voucher and price CRUD, organization, user, API-key and webhook settings. A test enforces this.
- **Write tools exist only with `FERRY_MCP_ENABLE_WRITES=true`** (exactly that string). Over `--http` they also need `FERRY_MCP_HTTP_ALLOW_WRITES=true` (see below).
- **Every write needs a human confirmation.**
  - When the client supports MCP elicitation, the server shows a confirmation dialog that the model cannot answer on the user's behalf.
  - Otherwise the model must pass `user_confirmed: true` after showing the user exactly what will happen.
  - The confirmation names what changes: the booking's voyages, seats, passengers and total, or, for a cancellation, the voyage and the passengers whose tickets are cancelled. Unknown or already-cancelled ticket positions are refused before anything is asked.
- **Strict arguments:** unknown or misspelt arguments are rejected, never silently dropped (a dropped nationality would change the ticket type and price).
- **Write budget:** at most `FERRY_MCP_MAX_WRITES` write calls per process (default 20). This stops runaway agent loops.
- **Audit log:** each write attempt is logged as one JSON line on stderr, and also appended to `FERRY_MCP_AUDIT_FILE` if set. Ids and counts only, no passenger personal data.
- **Personal data in reads:** booking data contains personal data (names, ID numbers, phone numbers). The server instructions tell the model to share it only with the people it concerns.

## Configuration

| Env | |
|---|---|
| `FERRY_API_KEY` | partner API key (required except for locations/routes) |
| `FERRY_ENV` / `FERRY_BASE_URL` | `production` (default) or `uat` / explicit origin |
| `FERRY_MCP_ENABLE_WRITES` | `true` to register the write tools |
| `FERRY_MCP_MAX_WRITES` | write calls per process (default 20) |
| `FERRY_MCP_AUDIT_FILE` | append write audit lines to this file |
| `FERRY_MCP_DISABLED_TOOLS` | tools to leave out, comma-separated (e.g. `list_bookings,find_customers` to keep personal data out of reach) |
| `FERRY_MCP_HTTP_HOST`, `FERRY_MCP_HTTP_TOKEN`, `FERRY_MCP_HTTP_ALLOW_WRITES`, `FERRY_MCP_ALLOWED_HOSTS`, `FERRY_MCP_ALLOWED_ORIGINS` | `--http` only, see below |
| `FERRY_LANG`, `FERRY_TIMEOUT_MS` | optional |

Invalid values stop the server at startup with a clear message.

## Streamable HTTP

`ferry-mcp --http --port 3333` serves stateless MCP at `http://127.0.0.1:3333/mcp` (`GET /healthz` for health checks). The server acts with **your** API key, so:

- **DNS-rebinding protection:** the `Host` header must be a loopback name and a browser `Origin` must be a loopback origin. Add more (on top of the loopback defaults) with `FERRY_MCP_ALLOWED_HOSTS` / `FERRY_MCP_ALLOWED_ORIGINS`.
- **Bearer token:** `FERRY_MCP_HTTP_TOKEN` (≥ 16 characters) makes every request send `Authorization: Bearer <token>`. It is **mandatory** whenever anything but loopback can reach the server: a non-loopback bind (`FERRY_MCP_HTTP_HOST=0.0.0.0`), or a non-loopback entry in `FERRY_MCP_ALLOWED_HOSTS` (a reverse proxy) or `FERRY_MCP_ALLOWED_ORIGINS` (a web page). The server refuses to start without it.
- **Read-only by default:** the HTTP server is stateless, so the client's confirmation dialog is not available and a write would be confirmed only by the model's `user_confirmed` flag. Write tools are therefore left out over HTTP even with `FERRY_MCP_ENABLE_WRITES=true`, unless you also set `FERRY_MCP_HTTP_ALLOW_WRITES=true`.
- **Request limits:** POST only, 1 MB body limit.

Docker (HTTP mode, token required):

```bash
docker build -f packages/mcp/Dockerfile -t ferryvn-mcp .
docker run -p 3333:3333 -e FERRY_API_KEY=… -e FERRY_MCP_HTTP_TOKEN=$(openssl rand -hex 24) ferryvn-mcp
```

Put it behind TLS for anything beyond a private network.

The Claude Desktop bundle and the Docker image bundle the server's dependencies into one file; their licenses are in `THIRD_PARTY_NOTICES.txt` next to it.

## License

Apache-2.0
