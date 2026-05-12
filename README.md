# Fastmail MCP Server (Unofficial)

Unofficial Model Context Protocol server for Fastmail integration. Exposes a single `execute` tool that acts as a validated JMAP proxy — the LLM writes raw JMAP method calls, and the server handles validation, authentication, and response cleaning.

## Setup Instructions

### 1. Get Your Fastmail API Token

1. Log in to [Fastmail](https://www.fastmail.com)
2. Go to **Settings** → **Privacy & Security** → **API tokens**
3. Click **New API token**
4. Give it a name (e.g., "Claude MCP")
5. Select the required scopes: `Mail` (read/write as needed)
6. Copy the generated token

### 2. Configure Claude Code

Add the following to your Claude Code MCP settings (`~/.claude/claude_desktop_config.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "fastmail": {
      "type": "url",
      "url": "https://fastmail-mcp.i11v.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_FASTMAIL_API_TOKEN"
      }
    }
  }
}
```

> **Security Note:** Keep your API token secure. Never commit it to version control. Consider using environment variables or a secrets manager.

## Available Tools

### `execute`

Execute JMAP method calls against Fastmail. Accepts an array of JMAP method call triples `[methodName, args, callId]`.

**Input:**
```json
{
  "methodCalls": [
    ["Email/query", {
      "filter": { "inMailbox": "INBOX_ID" },
      "sort": [{ "property": "receivedAt", "isAscending": false }],
      "limit": 10
    }, "call-0"],
    ["Email/get", {
      "ids": { "resultOf": "call-0", "name": "Email/query", "path": "/ids" },
      "properties": ["from", "subject", "receivedAt", "preview"]
    }, "call-1"]
  ]
}
```

**What the server does:**
- Validates structure, method names, and hygiene rules
- Injects `accountId` automatically
- Sends to Fastmail's JMAP API
- Strips protocol noise (`state`, `queryState`, `canCalculateChanges`, etc.)
- Returns cleaned `methodResponses`

**Allowed JMAP methods:**
- `Core/echo`
- `Mailbox/get`, `Mailbox/query`, `Mailbox/queryChanges`, `Mailbox/set`
- `Email/get`, `Email/query`, `Email/queryChanges`, `Email/set`
- `Thread/get`
- `SearchSnippet/get`
- `Identity/get`
- `EmailSubmission/get`, `EmailSubmission/query`, `EmailSubmission/set`

**Validation rules:**
- Every `/get` call (except `Mailbox/get`, `Identity/get`) must include a `properties` array
- Every `/query` call must include a `limit`
- `ids: null` on `/get` calls is rejected (use `/query` first)
- Destructive operations (`destroy`, `EmailSubmission/set`) return an error asking for user confirmation

### `compose_email` (MCP App)

Open an interactive email compose form. Optionally pre-fill fields (to, cc, bcc, subject, body). On hosts that support MCP Apps, renders an inline compose UI with send and save-draft buttons. Falls back to structured text on other hosts.

**Input:**
```json
{
  "to": "recipient@example.com",
  "subject": "Hello",
  "body": "Message text..."
}
```

### `read_email` (MCP App)

Display the full content of an email in a rich reader view. Fetches the email by JMAP ID and renders headers, sanitized body, and action buttons (reply, reply all, forward). Falls back to structured text on hosts without MCP Apps support.

**Input:**
```json
{
  "emailId": "M1234abcd"
}
```

## Available Resources

Resource-aware MCP clients automatically receive the Fastmail skill — a set of
markdown files teaching the LLM how to drive the `execute` JMAP tool. Clients
that support resource priority will load `SKILL.md` first and follow its links
lazily.

All resources use the `file:///fastmail-skill/<path>` URI scheme and
`text/markdown` mime type. Tagged `audience: ["assistant"]`.

| URI | Priority | Purpose |
|---|---|---|
| `file:///fastmail-skill/SKILL.md` | 1.0 | Entry point — JMAP methods, rules, UI tools |
| `file:///fastmail-skill/core/request-format.md` | 0.5 | Method-call triples, back-references, callId |
| `file:///fastmail-skill/core/error-handling.md` | 0.5 | JMAP error handling |
| `file:///fastmail-skill/email/querying.md` | 0.5 | Email/query filters and sort |
| `file:///fastmail-skill/email/reading.md` | 0.5 | Email/get body fetching |
| `file:///fastmail-skill/email/writing.md` | 0.5 | Drafts, flags, move, delete |
| `file:///fastmail-skill/email/search.md` | 0.5 | SearchSnippet/get highlights |
| `file:///fastmail-skill/mailbox/overview.md` | 0.5 | Mailbox CRUD |
| `file:///fastmail-skill/patterns/unread-inbox.md` | 0.5 | Show unread inbox |
| `file:///fastmail-skill/patterns/move-archive.md` | 0.5 | Move / archive |
| `file:///fastmail-skill/patterns/reply.md` | 0.5 | Reply pattern |
| `file:///fastmail-skill/sending/workflow.md` | 0.5 | EmailSubmission/set workflow |
| `file:///fastmail-skill/thread/overview.md` | 0.5 | Thread/get |

## Benchmarks

Head-to-head comparison against the official Fastmail MCP server, run on
2026-05-12. Harness, datasets, and results live in
[i11v/fastmail-mcp-comparison](https://github.com/i11v/fastmail-mcp-comparison).

**Setup:** identical seeded mailbox (186 messages), Claude Sonnet 4.6 as
the agent, 25 tasks × 5 passes per server (125 runs each), mailbox reset
between passes. Tasks span read, aggregate, search, write, batch-write,
compose, and ambiguity categories.

| | this server (i11v) | official |
|---|---|---|
| Runs completed | 125 / 125 | 125 / 125 |
| Step-budget exceeded | 0 | 2 (both on `ambiguity-02`) |
| Tool calls — median / max | 2 / **9** | 2 / **104** |
| Steps — median / max | 3 / 10 | 3 / 7 |
| Latency p50 / max | 10.2s / 33.6s | 8.8s / **123s** |
| Total wall time | ~21 min | ~31 min |

The biggest gaps are on multi-message work — `write-batch-03` averaged
3.4 tool calls here vs 57.2 on the official server; `write-batch-02`
averaged 2.0 vs 27.8. Batching multiple JMAP method calls into one
`execute` request lets the agent finish in one round-trip where a
one-tool-call-per-action server forces many.

**What this doesn't measure:** answer correctness. These numbers cover
efficiency only (tool calls, steps, latency, ability to finish within
the step budget). A verifier-side correctness pass is the next step in
the comparison harness.

## API Endpoints

- `POST /mcp` - MCP protocol endpoint
- `GET /health` - Health check endpoint

## Environment Variables

Copy `.env.example` to `.env.development.local` and fill in the values:

```bash
cp .env.example .env.development.local
```

| Variable | Required | Description |
|----------|----------|-------------|
| `HONEYCOMB_API_KEY` | No | Honeycomb ingest key for OpenTelemetry tracing |
| `HONEYCOMB_SERVER` | No | Honeycomb API server (default: `https://api.honeycomb.io`, EU: `https://api.eu1.honeycomb.io`) |

## Development

```bash
pnpm install   # Install dependencies
pnpm dev       # Run local dev server (wrangler)
pnpm check     # Run all checks (typecheck + lint + fmt + test)
pnpm run deploy:prod  # Deploy to Cloudflare
```

---

This is an unofficial community project and is not affiliated with Fastmail.

Source code and issues: [GitHub](https://github.com/nicobrinkkemper/fastmail-mcp)
