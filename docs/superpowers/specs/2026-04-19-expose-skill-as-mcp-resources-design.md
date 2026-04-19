# Expose the Fastmail Skill as MCP Resources

**Date:** 2026-04-19
**Status:** Design

## Problem

The `fastmail-skill/` directory contains a progressive-disclosure skill: a top-level
`SKILL.md` and 12 reference `.md` files (in `core/`, `email/`, `mailbox/`,
`patterns/`, `sending/`, `thread/`). It teaches an LLM how to drive the `execute`
JMAP tool.

Today the skill ships only as on-disk content — clients whose users manually install
the plugin get it, everyone else does not. MCP clients that support **resources** are
increasingly common (Claude Desktop, Cursor, etc.) and the MCP spec's `file://`
scheme is purpose-built for this use case. We can expose the skill over the wire so
any resource-aware client can load it without a separate installation step.

## Goals

- Resource-aware MCP clients can discover and read the full skill over the MCP
  protocol.
- Preserve the skill's progressive-disclosure design — clients that honor resource
  priority load `SKILL.md` first and follow its links lazily rather than pulling all
  ~25 KB up front.
- No runtime disk access — the server is a Cloudflare Worker with no filesystem.
  Skill content is bundled at build time.
- No duplication: the canonical source remains `fastmail-skill/*.md`. The MCP
  exposure reads from those same files.

## Non-Goals

- No resource subscriptions. Skill content changes only on deploy, so
  `notifications/resources/updated` would be noise.
- No dynamic templates. The file set is known at build time — a flat listing is
  simpler and matches spec guidance for finite known resources.
- No link rewriting. Relative paths inside `SKILL.md` (e.g. `email/querying.md`)
  stay as-is; RFC 3986 resolution against our chosen URI base yields the correct
  sibling resource URI, so a client can follow them without server assistance.

## Design

### URI Scheme

Per the [MCP resources spec (2025-06-18)][mcp-resources], `file://` is the standard
scheme for resources that behave like a filesystem, with the explicit note that the
resources "do not need to map to an actual physical filesystem." That is exactly
this case.

Each skill file gets a URI of the form:

```
file:///fastmail-skill/<relative-path>
```

So the 13 URIs are:

| URI | Source |
|---|---|
| `file:///fastmail-skill/SKILL.md` | `fastmail-skill/SKILL.md` |
| `file:///fastmail-skill/core/request-format.md` | `fastmail-skill/core/request-format.md` |
| `file:///fastmail-skill/core/error-handling.md` | `fastmail-skill/core/error-handling.md` |
| `file:///fastmail-skill/email/querying.md` | `fastmail-skill/email/querying.md` |
| `file:///fastmail-skill/email/reading.md` | `fastmail-skill/email/reading.md` |
| `file:///fastmail-skill/email/writing.md` | `fastmail-skill/email/writing.md` |
| `file:///fastmail-skill/email/search.md` | `fastmail-skill/email/search.md` |
| `file:///fastmail-skill/mailbox/overview.md` | `fastmail-skill/mailbox/overview.md` |
| `file:///fastmail-skill/patterns/unread-inbox.md` | `fastmail-skill/patterns/unread-inbox.md` |
| `file:///fastmail-skill/patterns/move-archive.md` | `fastmail-skill/patterns/move-archive.md` |
| `file:///fastmail-skill/patterns/reply.md` | `fastmail-skill/patterns/reply.md` |
| `file:///fastmail-skill/sending/workflow.md` | `fastmail-skill/sending/workflow.md` |
| `file:///fastmail-skill/thread/overview.md` | `fastmail-skill/thread/overview.md` |

### Metadata

Each resource is registered with:

- `name`: the file's base name (`SKILL.md`, `querying.md`, …).
- `title`: human-readable label, per the table below.
- `description`: one-line purpose, lifted from SKILL.md's own vocabulary so
  terms stay consistent.
- `mimeType`: `"text/markdown"` for every file.
- `annotations.audience`: `["assistant"]` — these files are written for the LLM,
  not the human user.
- `annotations.priority`: `1.0` for `SKILL.md`, `0.5` for the 12 references.

Full metadata for all 13 resources:

| URI suffix | title | description |
|---|---|---|
| `SKILL.md` | Fastmail Skill (entry point) | JMAP methods, rules, and UI tools. Start here. |
| `core/request-format.md` | Core: request format | Method-call triples, back-references, callId rules. |
| `core/error-handling.md` | Core: error handling | How JMAP errors surface and how to recover. |
| `email/querying.md` | Email: querying | Filter and sort emails with `Email/query`. |
| `email/reading.md` | Email: reading | Fetch email content with `Email/get`. |
| `email/writing.md` | Email: writing | Create drafts, update flags, move, delete. |
| `email/search.md` | Email: search | Full-text search highlights via `SearchSnippet/get`. |
| `mailbox/overview.md` | Mailbox: overview | List, find, create, update, and delete mailboxes. |
| `patterns/unread-inbox.md` | Pattern: unread inbox | Show unread messages in the inbox. |
| `patterns/move-archive.md` | Pattern: move / archive | Move or archive emails between mailboxes. |
| `patterns/reply.md` | Pattern: reply | Compose a reply to an existing email. |
| `sending/workflow.md` | Sending: workflow | End-to-end flow for sending via `EmailSubmission/set`. |
| `thread/overview.md` | Thread: overview | Fetch conversation threads with `Thread/get`. |

### Relative link resolution

`SKILL.md` contains markdown links like `[email/querying](email/querying.md)`.
Under RFC 3986, resolving `email/querying.md` against
`file:///fastmail-skill/SKILL.md` produces
`file:///fastmail-skill/email/querying.md` — exactly the URI we register for that
file. So clients that follow links get matching URIs without any rewriting.

### Bundling

Skill files are imported at build time using the same mechanism already used for
HTML:

1. Add `declare module "*.md" { const content: string; export default content; }`
   to a new `src/md.d.ts` file (alongside the existing `src/html.d.ts`).
2. Add a Text rule to `wrangler.jsonc` so wrangler bundles `.md` files as
   strings. Wrangler bundles `.html` as text by default but does not do so for
   `.md`, so the rule is required:
   ```jsonc
   "rules": [{"type": "Text", "globs": ["**/*.md"], "fallthrough": true}]
   ```
   The implementation plan will verify this empirically (by running a local
   dev server) and update this section if the default handling turns out to
   cover `.md` already.
3. Each skill file is imported individually:
   ```ts
   import skillMd from "../fastmail-skill/SKILL.md";
   import emailQuerying from "../fastmail-skill/email/querying.md";
   // …11 more
   ```

Thirteen imports is tolerable and matches how `compose.html` / `read-email.html`
are already handled in `src/apps.ts`. If the skill grows substantially, a
prebuild script that emits a generated bundle (`src/skill-bundle.ts`) becomes
worthwhile — but that's not needed now (YAGNI).

### Code Layout

A new file `src/skill.ts` exports `registerSkillResources(server: McpServer)`.
It is wired in from `src/index.ts`:

```ts
registerTools(mcpServer);
registerApps(mcpServer);
registerSkillResources(mcpServer);
```

Inside `src/skill.ts`, a single `SKILL_FILES` array drives everything:

```ts
const SKILL_FILES: readonly SkillFile[] = [
  {
    uri: "file:///fastmail-skill/SKILL.md",
    name: "SKILL.md",
    title: "Fastmail Skill (entry point)",
    description: "Overview of JMAP methods, rules, and UI tools. Start here.",
    content: skillMd,
    priority: 1.0,
  },
  // …12 more
];
```

Registration uses the SDK's `server.registerResource(...)` — not the MCP Apps
`registerAppResource` helper, since these are not app UIs. Each entry registers a
static resource with the fields above and a `read` handler that returns
`{ contents: [{ uri, mimeType: "text/markdown", text: content }] }`.

### Data Flow

1. Client calls `resources/list` → server returns all 13 entries with name, title,
   description, mimeType, and annotations (priority + audience).
2. A priority- and audience-aware client sorts by priority, identifies `SKILL.md`
   as the top entry for the assistant, reads it.
3. `SKILL.md` references `email/querying.md` etc. in markdown. The client
   (or assistant prompted by the client) issues `resources/read` for the resolved
   sibling URI when the relevant topic comes up.

### Error Handling

The registration is entirely static — content is embedded at build time, so
`resources/read` cannot fail for a registered URI. Unknown URIs are handled by
the SDK's default "resource not found" path, which returns JSON-RPC `-32002` per
spec.

### Testing

New test file `src/__tests__/skill.test.ts`:

1. All 13 URIs are registered with the expected `uri`, `mimeType`, and
   `audience`/`priority` annotations.
2. `resources/list` returns exactly 13 entries.
3. `resources/read` for a sample URI (`SKILL.md` plus one subdirectory file)
   returns the exact text from the source `.md` file — confirming the build-time
   import actually plumbs through.
4. Every link target referenced from `SKILL.md` of the form `(<path>.md)` is
   present in the registered URI set. This catches the case where SKILL.md
   references a file we forgot to register.

### Documentation

- `README.md`: add an "Available Resources" section parallel to "Available Tools",
  listing the 13 URIs and explaining that resource-aware clients get the skill
  automatically.
- `public/landing.html`: a short note in the setup instructions that the skill is
  exposed as MCP resources (no need to list all 13 files on the landing page).
- `CLAUDE.md`: extend the "Documentation" section to note that when skill files
  are added/removed/renamed, `src/skill.ts` and `README.md` must be updated.

## Alternatives Considered

- **Custom scheme (`skill://fastmail/...`)** — rejected. The spec blesses `file://`
  for virtual filesystems, and the skill's own relative links use filesystem
  semantics.
- **Single merged resource** — rejected. Forces every client to load ~25 KB up
  front, defeating the progressive-disclosure design of SKILL.md.
- **Resource template (`file:///fastmail-skill/{path}`)** — rejected. Weaker
  client support; static listing works in every resource-aware client and is
  simpler to implement and test.
- **Generated `skill-bundle.ts` via prebuild** — deferred. With 13 files that
  change infrequently, individual imports are simpler. Revisit if the skill grows
  substantially.

[mcp-resources]: https://modelcontextprotocol.io/specification/2025-06-18/server/resources
