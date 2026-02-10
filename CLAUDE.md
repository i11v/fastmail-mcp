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
```

## Quality Commands

```bash
pnpm check        # Run ALL checks (typecheck + lint + fmt + test)
pnpm typecheck    # Type check without compilation
pnpm lint         # Lint with oxlint
pnpm lint:fix     # Lint and auto-fix
pnpm fmt          # Format with oxfmt (write)
pnpm fmt:check    # Check formatting without writing
pnpm test         # Run tests with vitest
pnpm test:watch   # Run tests in watch mode
```

**Always run `pnpm check` before committing.** Pre-commit hooks (lefthook) enforce this automatically.

## Source Files

- `src/index.ts` - Server setup, Hono routes, MCP initialization
- `src/tools.ts` - Tool implementations, Zod schemas, JMAP integration
- `src/format.ts` - Email formatting for LLM consumption (XML output, HTML→Markdown)
- `src/redis.ts` - Redis client setup, session caching

## Tooling

| Tool | Config | Purpose |
|------|--------|---------|
| `oxlint` | `.oxlintrc.json` | Linting (correctness, suspicious, perf rules) |
| `oxfmt` | `.oxfmtrc.json` | Formatting (Prettier-compatible) |
| `vitest` | `vitest.config.ts` | Testing |
| `lefthook` | `lefthook.yml` | Pre-commit hooks |
| `typescript` | `tsconfig.json` | Type checking (strict mode) |

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `hono` | Web framework |
| `@hono/mcp` | MCP integration |
| `@modelcontextprotocol/sdk` | MCP protocol SDK |
| `effect` | Functional programming |
| `effect-jmap` | JMAP client library |
| `zod` | Schema validation |

## Gotchas

### Zod `.refine()` breaks MCP tool input schemas

Do **not** use `.refine()` or `.superRefine()` on Zod schemas passed to `server.registerTool()`. These methods convert `ZodObject` into `ZodEffects`, which strips the property metadata the MCP SDK needs to generate JSON Schema for tool inputs. The MCP inspector will show no input fields.

**Bad:**
```ts
const MySchema = z.object({ ... }).refine(data => data.a || data.b);
```

**Good — validate at runtime instead:**
```ts
const MySchema = z.object({ ... });

async function myTool(args: z.infer<typeof MySchema>) {
  if (!args.a && !args.b) throw new Error("Need a or b");
  // ...
}
```
