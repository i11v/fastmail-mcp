# Claude Code Guidelines

## Project Overview

Unofficial MCP server for Fastmail integration. Enables AI assistants to interact with Fastmail accounts through the Model Context Protocol for email management, querying, and sending.

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

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `hono` | Web framework |
| `@hono/mcp` | MCP integration |
| `@modelcontextprotocol/sdk` | MCP protocol SDK |
| `effect` | Functional programming |
| `effect-jmap` | JMAP client library |
| `zod` | Schema validation |
