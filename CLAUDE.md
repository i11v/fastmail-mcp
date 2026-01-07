# Claude Code Guidelines

## Project Overview

This is an **unofficial Model Context Protocol (MCP) server** for Fastmail integration. It enables AI assistants like Claude to interact with Fastmail accounts through the MCP standard, providing tools for email management, querying, and sending.

- **Name:** fastmail-mcp-unofficial
- **Version:** 0.5.0
- **License:** MIT
- **Node.js:** v24.x (see `.nvmrc`)
- **Deployment:** Vercel (https://fastmail-mcp.vercel.app)

## Package Manager

Always use `pnpm` instead of `npm` for this project.

```bash
pnpm install      # Install dependencies
pnpm build        # Build TypeScript to dist/
pnpm start        # Run local server on port 3000
pnpm deploy       # Deploy to Vercel (production)
pnpm typecheck    # Type check without compilation
```

## Directory Structure

```
/
├── src/
│   ├── index.ts       # Server entry point, Hono app, MCP initialization
│   └── tools.ts       # Tool implementations, Zod schemas, JMAP integration
├── public/
│   └── landing.html   # User-facing setup instructions page
├── dist/              # Compiled JavaScript output (generated)
├── package.json       # Dependencies and scripts
├── tsconfig.json      # TypeScript configuration
├── pnpm-lock.yaml     # Dependency lock file
├── .nvmrc             # Node version specification (v24.12.0)
└── vercel.json        # Vercel deployment configuration (if present)
```

## Architecture

### Technology Stack

- **Hono** - Lightweight web framework for HTTP routing and middleware
- **Effect** - Functional programming library for composable async operations
- **effect-jmap** - JMAP protocol library built on Effect
- **@hono/mcp** - MCP protocol integration for Hono
- **@modelcontextprotocol/sdk** - Official MCP SDK
- **Zod** - TypeScript-first schema validation

### Request Flow

1. Client sends request to `/mcp` endpoint with `Authorization: Bearer <FASTMAIL_API_TOKEN>`
2. Hono routes request through CORS middleware
3. MCP server handles request via StreamableHTTPTransport
4. Tool handler extracts token, initializes JMAP session
5. JMAP operations execute against Fastmail API (`https://api.fastmail.com/jmap/session`)
6. Results returned through MCP protocol

### Key Components

#### `src/index.ts`
- Initializes Hono app with CORS (allows all origins)
- Sets up MCP server with name "fastmail-mcp"
- Routes:
  - `POST /mcp` - MCP protocol endpoint (bidirectional streaming)
  - `GET /health` - Health check returning `{ status: "ok" }`
  - `GET /` - Serves landing.html

#### `src/tools.ts`
- **SessionManager** - Caches JMAP layers, session, and account ID per bearer token
- **Zod Schemas** - Input validation for all tool parameters
- **Tool implementations:**
  - `mailbox_get` - List all mailboxes/folders
  - `email_query` - Search emails with filters and sorting
  - `email_get` - Retrieve specific emails by ID
  - `email_send` - Send emails (plain text and/or HTML)
- **Helper functions:**
  - `getDefaultIdentity()` - Get default sending identity
  - `uploadBlob()` - Upload RFC 5322 message to JMAP
  - `buildEmailMessage()` - Construct properly formatted email

## Development Workflow

### Local Development

```bash
# Install dependencies
pnpm install

# Build and run
pnpm build
pnpm start

# Server runs at http://localhost:3000
# MCP endpoint: http://localhost:3000/mcp
# Health check: http://localhost:3000/health
```

### Type Checking

```bash
pnpm typecheck  # Run tsc --noEmit
```

### Deployment

```bash
pnpm deploy     # Deploy to Vercel production
```

## Code Conventions

### TypeScript

- **Strict mode enabled** - All strict compiler options active
- **ES2022 target** - Uses modern JavaScript features
- **ESNext modules** - Uses bundler moduleResolution
- **Effect language service plugin** - Enhanced IDE support for Effect

### Error Handling

- Wrap JMAP operations in try-catch blocks
- Return user-friendly error messages via MCP
- Log errors for debugging

### Schema Validation

All tool inputs are validated with Zod schemas before processing:

```typescript
const EmailQuerySchema = z.object({
  accountId: z.string().optional(),
  mailboxId: z.string().optional(),
  limit: z.number().min(1).max(100).default(10),
  // ...
});
```

### Effect Patterns

The codebase uses Effect for functional, composable operations:

```typescript
// Effect layers for JMAP services
const layers = NodeLive.pipe(Layer.merge(JMAPLive))

// Running effects
const result = await Effect.runPromise(
  program.pipe(Effect.provide(layers))
)
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FASTMAIL_API_TOKEN` | Yes (runtime) | Bearer token passed via MCP Authorization header |
| `PORT` | No | Local development port (default: 3000) |
| `VERCEL` | Auto | Set by Vercel platform |

## API Reference

### MCP Tools

#### `mailbox_get`
List all mailboxes/folders in the account.

**Parameters:** None required
**Returns:** Array of mailbox objects with id, name, role, totalEmails, etc.

#### `email_query`
Search and query emails with filters.

**Parameters:**
- `mailboxId` (optional) - Filter by mailbox
- `limit` (1-100, default: 10) - Number of results
- `from`, `to`, `subject` (optional) - Text filters
- `hasKeyword`, `notKeyword` (optional) - Keyword filters
- `before`, `after` (optional) - Date filters (ISO 8601)
- `sort` (optional) - Sort field: receivedAt, sentAt, subject, from
- `ascending` (optional, default: false) - Sort order

#### `email_get`
Retrieve full email content by ID.

**Parameters:**
- `emailIds` (required) - Array of email IDs (1-50)
- `properties` (optional) - Specific properties to fetch
- `fetchTextBodyValues`, `fetchHTMLBodyValues`, `fetchAllBodyValues` (optional)
- `maxBodyValueBytes` (optional) - Limit body size

#### `email_send`
Send an email through Fastmail.

**Parameters:**
- `to` (required) - Recipient email address
- `subject` (required) - Email subject
- `body` (required) - Plain text body
- `htmlBody` (optional) - HTML body (creates multipart/alternative)
- `identityId` (optional) - Sending identity (uses default if omitted)

### HTTP Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/mcp` | MCP protocol endpoint |
| GET | `/health` | Health check |
| GET | `/` | Landing page with setup instructions |

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `hono` | Web framework |
| `@hono/mcp` | MCP integration |
| `@modelcontextprotocol/sdk` | MCP protocol SDK |
| `effect` | Functional programming |
| `effect-jmap` | JMAP client library |
| `zod` | Schema validation |

## Testing

Currently no automated test suite is configured. Manual testing can be done via:

1. Start local server: `pnpm start`
2. Use Claude Code or MCP client to test tool invocations
3. Check `/health` endpoint for server status

## Common Tasks

### Adding a New Tool

1. Define Zod schema in `src/tools.ts`:
   ```typescript
   const MyToolSchema = z.object({ /* ... */ });
   ```

2. Implement the tool function:
   ```typescript
   const myTool = async (bearerToken: string, params: z.infer<typeof MyToolSchema>) => {
     // Implementation
   };
   ```

3. Register with MCP server:
   ```typescript
   server.tool(
     "my_tool",
     "Description of what the tool does",
     MyToolSchema.shape,
     async ({ /* params */ }, { authInfo }) => {
       // Handler
     }
   );
   ```

### Modifying Email Query Filters

Edit the filter construction in `emailQuery()` function in `src/tools.ts`. Filters follow JMAP Email/query specification.

### Updating Landing Page

Edit `/public/landing.html` - this is served at the root URL and contains setup instructions for users.
