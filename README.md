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
      "url": "https://fastmail-mcp.vercel.app/mcp",
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

## API Endpoints

- `POST /mcp` - MCP protocol endpoint
- `GET /health` - Health check endpoint

## Development

```bash
pnpm install   # Install dependencies
pnpm build     # Build for production
pnpm start     # Run local server
pnpm check     # Run all checks (typecheck + lint + fmt + test)
pnpm deploy    # Deploy to Vercel
```

---

This is an unofficial community project and is not affiliated with Fastmail.

Source code and issues: [GitHub](https://github.com/nicobrinkkemper/fastmail-mcp)
