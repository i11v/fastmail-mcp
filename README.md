# Fastmail MCP Server (Unofficial)

Unofficial Model Context Protocol server for Fastmail integration.

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

### `mailbox_get`
Get mailbox information (folders) - list all mailboxes or get specific ones by ID.

### `email_query`
Query emails with filters and sorting.
- `mailboxId` (optional): Mailbox ID to search in
- `limit` (optional, default: 10): Maximum number of emails to return
- `from` (optional): Filter by sender
- `to` (optional): Filter by recipient
- `subject` (optional): Filter by subject text
- `hasKeyword` (optional): Filter by keyword (e.g., `$seen`, `$flagged`)
- `notKeyword` (optional): Filter by absence of keyword
- `before` (optional): Filter by date (ISO format)
- `after` (optional): Filter by date (ISO format)
- `sort` (optional, default: `receivedAt`): Sort by property
- `ascending` (optional, default: false): Sort order

### `email_get`
Get specific emails by their IDs.
- `emailIds` (required): Array of email IDs to retrieve
- `accountId` (optional): Account ID (auto-detected if not provided)
- `properties` (optional): Specific properties to fetch
- `fetchTextBodyValues` (optional): Fetch text/plain body values
- `fetchHTMLBodyValues` (optional): Fetch text/html body values
- `fetchAllBodyValues` (optional): Fetch all text body values
- `maxBodyValueBytes` (optional): Maximum size in bytes for body values

### `email_send`
Send emails with support for plain text, HTML, or both.
- `to` (required): Recipient email address
- `subject` (required): Email subject
- `body` (required): Plain text body
- `htmlBody` (optional): HTML body for multipart/alternative emails
- `identityId` (optional): Identity ID to send from

### `email_move`
Move emails to a mailbox. For common actions use well-known names: `trash` (delete), `archive`, `inbox`, `junk`, `drafts`, `sent`. For other mailboxes, use `mailbox_get` to find the mailbox ID.
- `emailIds` (required): Array of email IDs to move (1-50)
- `mailboxId` (required): Target mailbox ID, or a well-known role: `trash`, `archive`, `inbox`, `drafts`, `junk`, `sent`
- `accountId` (optional): Account ID (auto-detected if not provided)

## API Endpoints

- `POST /mcp` - MCP protocol endpoint
- `GET /health` - Health check endpoint

## Development

```bash
pnpm install   # Install dependencies
pnpm dev       # Watch mode for TypeScript compilation
pnpm build     # Build for production
pnpm start     # Run local server
pnpm deploy    # Deploy to Vercel
```

---

This is an unofficial community project and is not affiliated with Fastmail.

Source code and issues: [GitHub](https://github.com/nicobrinkkemper/fastmail-mcp)
