# @ferryvn/cli — `ferry`

Official command-line tool for the FerryVN ferry-ticket partner API: search voyages, seat maps, build and manage bookings, customers, cancellations. Node.js ≥ 22.12.

```bash
npm install -g @ferryvn/cli     # or: npx @ferryvn/cli <command>
ferry login                     # paste the API key (hidden); verifies it and stores it 0600
ferry voyages search --from "Rạch Giá" --to "Phú Quốc" --date tomorrow
```

## Commands

```
ferry login [--api-key-stdin] [--no-verify]      verify + store a key in a profile
ferry logout | whoami [--check] | profiles [list|use <name>]
ferry doctor                                     config, connectivity and key checks
ferry locations [query]
ferry routes [--from <loc>] [--to <loc>] [--all]
ferry operators [list] | operators nationals <operatorId>
ferry voyages search --from <loc> --to <loc> --date <YYYY-MM-DD|today|tomorrow> [--until …] [--after HH:mm] [--before HH:mm] [--operator <id…>] [--include-unavailable] [--all]
ferry calendar --from <loc> --to <loc> [--start <date>] [--days 14]
ferry prices --from <loc> --to <loc> [--date <date>] [--until <date>] [--live [n]] [--summary] [--vehicles] [--all-ticket-types]
ferry seats <voyageId> [--all] [--stored]
ferry customers [--search <text>] [--phone …] [--email …] [--all] | customers get <id> | customers create --first-name … [--phone …]
ferry booking draft --customer <id> --orderer-name … --email … --voyage <id> [--seats A1,A2] --passengers <file.csv|json> [--return-voyage <id>] [--out booking.json] [--create]
ferry booking create --file booking.json|- [--dry-run]
ferry booking get <id> | booking public <id> | booking update <id> --file …
ferry booking list [--status Requested,Booked] [--payment NotPaid] [--search …] [--depart-from …] [--oldest-first] [--all]
ferry booking issue <id> [--yes]                 ⚠ charges balance/credit and issues real tickets
ferry booking tickets <id> [--refresh]           ticket file URLs
ferry orders list [--status …] | orders get <id>
ferry cancel request --order <id> --positions 101,102 --reason "…" [--yes]   ⚠ holds the cancellation fee
ferry cancel list [--order <id>] [--booking <id>] [--status processing,accept] | cancel get <id>
ferry account                                    organization, balances, reservable credit
ferry transactions [--booking …] [--type PB,RF] [--all] | debts [--status borrowing]
ferry vouchers [--code …] | disruptions [--since <iso>] [--state active] | disruptions get <id>
ferry api <METHOD> <path> [-q key=value…] [-d json|@file|-]    raw request with your credentials
ferry completion bash|zsh
```

`booking issue` and `cancel request` need `--yes`. On an interactive terminal you can type the booking or order id back instead; before you confirm, `booking issue` shows the total and your reservable credit.

## Building a booking from a spreadsheet

`ferry booking draft` takes seat names and a passenger list (CSV exported from Excel or Google Sheets, or JSON). It:
- picks each ticket type from the passenger's age, using the operator's own rules;
- matches prices;
- checks seats and duplicate ID numbers.

Nothing is sent until you pass `--create` or run `booking create`.

```csv
name,date_of_birth,social_id,home_town,gender
Nguyễn Văn A,1990-05-01,079090000001,Cần Thơ,nam
Nguyễn Văn B,2018-03-02,079090000001,Cần Thơ,nam
```

Columns: `name`, `date_of_birth`, `social_id`, `home_town`, `gender` (male/female, nam/nữ, 1/0), optional `national_id` (default Vietnam, see `ferry operators nationals`), `ticket_type_id` (default: by age), `plate_number`, `passport_expired_at`. Vietnamese headers `ho_ten`, `ngay_sinh`, `cccd`, `que_quan`, `gioi_tinh` work too. The separator is `,`, or `;` when the header row uses semicolons (Excel in Vietnamese locale).

## Global options

| Flag | Env | |
|---|---|---|
| `--json`, `-o, --output table\|json\|ndjson\|csv` | | CSV has a UTF-8 BOM (Excel) and neutralises formula injection |
| `-p, --profile <name>` | `FERRY_PROFILE` | stored profile (default: the current one) |
| `--api-key <key>` | `FERRY_API_KEY` | overrides the profile (flags are visible in shell history; prefer `login` or the env var) |
| `--env production\|uat`, `--base-url <url>` | `FERRY_ENV`, `FERRY_BASE_URL` | |
| `--timeout <ms>` | `FERRY_TIMEOUT_MS` | |
| `--debug` | `FERRY_DEBUG=1` | HTTP log to stderr, key redacted |
| | `FERRY_LANG` | backend message language (`vi`, `en`) |

Precedence: flags > environment variables > profile > production. The endpoint (`--base-url`/`--env`) resolves as one unit, so `--env uat` always wins over a URL saved in a profile.

Profiles live in `config.json` (mode 0600):
- Linux: `~/.config/ferry/` (honours `XDG_CONFIG_HOME`)
- macOS: `~/Library/Application Support/ferry/`
- Windows: `%APPDATA%\ferry\`
- Override with `FERRY_CONFIG_DIR`.

```bash
ferry login --profile uat --env uat     # second key for UAT
ferry --profile uat voyages search …
ferry profiles use uat
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | API, server or network error (also `doctor` with failed checks) |
| 2 | usage error (bad flags, invalid input, not confirmed) |
| 3 | authentication / permission (401, 403) |
| 4 | not found (404) |
| 5 | rate limited (429) |

## License

Apache-2.0
