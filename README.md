# Fastmail MCP Server (Unofficial)

An unofficial MCP (Model Context Protocol) server that provides access to Fastmail email via [effect-jmap](https://github.com/i11v/effect-jmap).

## Connect to a client

### Claude Desktop

```bash
claude mcp add fastmail --env FASTMAIL_API_TOKEN=<YOUR_TOKEN> npx fastmail-mcp-unofficial
```

Or manually add this to your Claude Desktop configuration:

```json
{
  "mcpServers": {
    "fastmail": {
      "command": "npx",
      "args": ["fastmail-mcp-unofficial"],
      "env": {
        "FASTMAIL_API_TOKEN": "your_token_here"
      }
    }
  }
}
```

## Tools

This MCP server provides the following tools:

### `mailbox_get`
Retrieves all mailboxes from the account.
- No parameters required
- Returns array of mailbox objects with metadata

### `email_get`
Gets specific emails by their IDs.
- `emailIds` (required): Array of email IDs to retrieve
- `accountId` (optional): Account ID to retrieve emails from (auto-detected if not provided)
- `properties` (optional): Specific properties to fetch
- `fetchTextBodyValues` (optional): Fetch text/plain body values
- `fetchHTMLBodyValues` (optional): Fetch text/html body values
- `fetchAllBodyValues` (optional): Fetch all text body values
- `maxBodyValueBytes` (optional): Maximum size in bytes for body values

### `email_query`
Queries emails with filters and sorting.
- `mailboxId` (optional): Mailbox ID to search in
- `limit` (optional, default: 10): Maximum number of emails to return
- `from` (optional): Filter by sender
- `to` (optional): Filter by recipient
- `subject` (optional): Filter by subject text
- `hasKeyword` (optional): Filter by keyword (e.g., '$seen', '$flagged')
- `notKeyword` (optional): Filter by absence of keyword
- `before` (optional): Filter by date (ISO format)
- `after` (optional): Filter by date (ISO format)
- `sort` (optional, default: 'receivedAt'): Sort by property
- `ascending` (optional, default: false): Sort order

## Development

- `pnpm dev` - Watch mode for TypeScript compilation
- `pnpm typecheck` - Type check without emitting files
- `pnpm build` - Build for production

## Getting Your Fastmail API Token

The server requires a Fastmail API token to be provided via the MCP client configuration (see above).

To create your API token:
1. Go to Fastmail Settings
2. Navigate to Privacy & Security
3. Under "Connected apps & API tokens", click "Manage API tokens"
4. Create a new API token with appropriate permissions

The JMAP session endpoint is hardcoded to `https://api.fastmail.com/jmap/session`.
