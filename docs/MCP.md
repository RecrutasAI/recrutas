# Recrutas MCP connector

Use your Recrutas job search from Claude Code, Cursor or any MCP client. The full guide is at **https://www.recrutas.ai/docs**; this file is the same reference for contributors.

## Connect

1. Sign up at https://www.recrutas.ai and upload a resume.
2. Dashboard → **Settings → Connect your AI tools** → create a token (shown once).
3. Add the connector:

```bash
# Claude Code
claude mcp add --transport http recrutas https://www.recrutas.ai/api/mcp \
  --header "Authorization: Bearer YOUR_TOKEN"
```

```json
// Cursor (~/.cursor/mcp.json) and other clients
{ "mcpServers": { "recrutas": { "url": "https://www.recrutas.ai/api/mcp", "headers": { "Authorization": "Bearer YOUR_TOKEN" } } } }
```

## Tools

| Tool | What it does |
|---|---|
| `search_my_matches` | Up to 100 live matches with score and Apply / Stretch / Skip verdict; filter by verdict, `posted_within_days`, `location`, `work_type`; 20 per page |
| `get_job` | Requirements, your verdict, live status, description excerpt, apply link |
| `list_my_applications` | Applications with posting state (still posted / taken down / reposted) |
| `record_application` | Record that you applied (only after you confirm); idempotent |
| `why_no_replies` | Diagnosis of your applications and one next step |

The connector never applies on your behalf.

## Limits and security

- Tokens: `rk_` + 256 random bits; only a SHA-256 hash is stored (`api_tokens`); max 10 active per user; revocable immediately.
- 500 requests per user per day (HTTP 429 after).
- 401 for a missing, unknown or revoked token.

## Implementation

- Route: `POST /api/mcp` in `server/routes.ts` (Streamable HTTP, stateless; one server per request).
- Server and tools: `server/mcp/recrutas-mcp.ts` (reuses the feed, verdicts, applications and diagnosis code).
- Tokens: `server/services/api-token.service.ts`; table `migrations/add-api-tokens.sql`.
- Tests: `test/mcp-server.test.ts` (in-memory client), `client/src/__tests__/AiConnectorSettings.test.tsx`.
