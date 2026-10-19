# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/ferry-vn/ferry-sdk/security/advisories/new)
for this repository. Include the affected package and version, a description,
and steps to reproduce. We aim to acknowledge reports within 3 business days.

Vulnerabilities in the FerryVN API itself (not in these client packages) can be
reported the same way; they will be routed to the backend team.

## Supported versions

| Version | Supported |
|---|---|
| 1.x | ✔ |
| 0.x | ✘ |

## Handling API keys

- A partner API key acts with organization-admin power. Keep it server-side,
  in a secret manager or environment variable — never in browser code, mobile
  apps or source control. The SDK refuses to run in a browser with a key unless
  `dangerouslyAllowBrowser` is set.
- `ferry login` stores keys in a 0600 file in your OS config directory. Prefer
  `FERRY_API_KEY` in CI.
- Delete a leaked key in the FerryVN dashboard immediately; deletion takes
  effect at once.
- `ferry-mcp --http` acts with your key: keep it on loopback, or set
  `FERRY_MCP_HTTP_TOKEN` and put it behind TLS.
