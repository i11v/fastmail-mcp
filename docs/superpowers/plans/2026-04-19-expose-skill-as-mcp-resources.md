# Expose Fastmail Skill as MCP Resources — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the 13 files in `fastmail-skill/` as MCP resources under the `file:///fastmail-skill/<path>` scheme so resource-aware MCP clients can load the skill over the wire.

**Architecture:** Cloudflare Worker bundles each `.md` file at build time via wrangler's Text rule, imports them into a new `src/skill.ts` module that exposes a static `SKILL_FILES` array and a `registerSkillResources(server)` function. `SKILL.md` gets `priority: 1.0`; the 12 references get `priority: 0.5`. All resources tagged `audience: ["assistant"]`.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` v1.27+ (`McpServer.registerResource`), wrangler 4 (Text rule for `.md`), vitest, Hono, Cloudflare Workers.

**Spec:** [docs/superpowers/specs/2026-04-19-expose-skill-as-mcp-resources-design.md](../specs/2026-04-19-expose-skill-as-mcp-resources-design.md)

---

## Task 1: Add `.md` bundling support for wrangler **and** vitest

**Files:**
- Create: `src/md.d.ts`
- Modify: `wrangler.jsonc`
- Modify: `vitest.config.ts`

Wrangler and vitest use separate bundlers, so `.md` imports need to be taught to both.

- [ ] **Step 1: Create the TypeScript module declaration**

Create `src/md.d.ts` with:

```ts
declare module "*.md" {
  const content: string;
  export default content;
}
```

- [ ] **Step 2: Add a Text rule to wrangler.jsonc**

Open `wrangler.jsonc`. After the `"routes"` array (before the final `}`), add a `"rules"` field so wrangler bundles `.md` files as string modules. Full file should look like:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "fastmail-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-03",
  "compatibility_flags": ["nodejs_compat"],
  "vars": {
    "HONEYCOMB_SERVER": "https://api.eu1.honeycomb.io"
  },
  "observability": {
    "enabled": true
  },
  "upload_source_maps": true,
  "routes": [
    { "pattern": "fastmail-mcp.i11v.com", "custom_domain": true }
  ],
  "rules": [
    { "type": "Text", "globs": ["**/*.md"], "fallthrough": true }
  ]
}
```

- [ ] **Step 3: Teach vitest to load `.md` as text**

Replace `vitest.config.ts` with:

```ts
import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

// Mirrors wrangler's Text rule for `.md` so skill files import identically
// under test and under production bundling.
const mdAsText = {
  name: "md-as-text",
  transform(_code: string, id: string) {
    const path = id.split("?")[0];
    if (path.endsWith(".md")) {
      const src = readFileSync(path, "utf-8");
      return { code: `export default ${JSON.stringify(src)};`, map: null };
    }
    return null;
  },
};

export default defineConfig({
  plugins: [mdAsText],
  test: {
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Sanity-check that `.md` imports typecheck AND run under vitest**

Temporarily add these lines at the bottom of `src/index.ts`:

```ts
import _skillMd from "../fastmail-skill/SKILL.md";
void _skillMd;
```

Run: `pnpm typecheck`
Expected: PASS (no type errors).

Next, create a throwaway test `src/__tests__/md-bundling.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import skill from "../../fastmail-skill/SKILL.md";

describe("md-bundling smoke test", () => {
  it("loads SKILL.md as a string", () => {
    expect(typeof skill).toBe("string");
    expect(skill).toContain("JMAP Mail Skill");
  });
});
```

Run: `pnpm test src/__tests__/md-bundling.test.ts`
Expected: PASS.

Remove the throwaway test file and the temporary import in `src/index.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/md.d.ts wrangler.jsonc vitest.config.ts
git commit -m "feat(build): bundle .md files as text for wrangler and vitest"
```

---

## Task 2: Define `SKILL_FILES` data model (TDD)

**Files:**
- Create: `src/__tests__/skill.test.ts`
- Create: `src/skill.ts`

- [ ] **Step 1: Write a failing test for the `SKILL_FILES` shape**

Create `src/__tests__/skill.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SKILL_FILES } from "../skill.js";

const EXPECTED_URIS = [
  "file:///fastmail-skill/SKILL.md",
  "file:///fastmail-skill/core/request-format.md",
  "file:///fastmail-skill/core/error-handling.md",
  "file:///fastmail-skill/email/querying.md",
  "file:///fastmail-skill/email/reading.md",
  "file:///fastmail-skill/email/writing.md",
  "file:///fastmail-skill/email/search.md",
  "file:///fastmail-skill/mailbox/overview.md",
  "file:///fastmail-skill/patterns/unread-inbox.md",
  "file:///fastmail-skill/patterns/move-archive.md",
  "file:///fastmail-skill/patterns/reply.md",
  "file:///fastmail-skill/sending/workflow.md",
  "file:///fastmail-skill/thread/overview.md",
] as const;

describe("SKILL_FILES", () => {
  it("contains exactly 13 entries", () => {
    expect(SKILL_FILES).toHaveLength(13);
  });

  it("registers every expected URI", () => {
    const uris = new Set(SKILL_FILES.map((f) => f.uri));
    for (const uri of EXPECTED_URIS) {
      expect(uris.has(uri)).toBe(true);
    }
  });

  it("has unique URIs and unique names", () => {
    const uris = new Set(SKILL_FILES.map((f) => f.uri));
    const names = new Set(SKILL_FILES.map((f) => f.name));
    expect(uris.size).toBe(SKILL_FILES.length);
    expect(names.size).toBe(SKILL_FILES.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/__tests__/skill.test.ts`
Expected: FAIL — `Cannot find module '../skill.js'` (or similar).

- [ ] **Step 3: Implement `src/skill.ts` with the `SKILL_FILES` array**

Create `src/skill.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import skillMd from "../fastmail-skill/SKILL.md";
import coreRequestFormat from "../fastmail-skill/core/request-format.md";
import coreErrorHandling from "../fastmail-skill/core/error-handling.md";
import emailQuerying from "../fastmail-skill/email/querying.md";
import emailReading from "../fastmail-skill/email/reading.md";
import emailWriting from "../fastmail-skill/email/writing.md";
import emailSearch from "../fastmail-skill/email/search.md";
import mailboxOverview from "../fastmail-skill/mailbox/overview.md";
import patternsUnreadInbox from "../fastmail-skill/patterns/unread-inbox.md";
import patternsMoveArchive from "../fastmail-skill/patterns/move-archive.md";
import patternsReply from "../fastmail-skill/patterns/reply.md";
import sendingWorkflow from "../fastmail-skill/sending/workflow.md";
import threadOverview from "../fastmail-skill/thread/overview.md";

export interface SkillFile {
  /** Resource URI, e.g. "file:///fastmail-skill/email/querying.md". */
  uri: string;
  /** Unique, machine-friendly name. Full relative path so basename collisions are avoided. */
  name: string;
  /** Human-readable label. */
  title: string;
  /** One-line purpose. */
  description: string;
  /** Markdown body. */
  content: string;
  /** MCP annotation. 1.0 for SKILL.md, 0.5 for references. */
  priority: number;
}

export const SKILL_FILES: readonly SkillFile[] = [
  {
    uri: "file:///fastmail-skill/SKILL.md",
    name: "SKILL.md",
    title: "Fastmail Skill (entry point)",
    description: "JMAP methods, rules, and UI tools. Start here.",
    content: skillMd,
    priority: 1.0,
  },
  {
    uri: "file:///fastmail-skill/core/request-format.md",
    name: "core/request-format.md",
    title: "Core: request format",
    description: "Method-call triples, back-references, callId rules.",
    content: coreRequestFormat,
    priority: 0.5,
  },
  {
    uri: "file:///fastmail-skill/core/error-handling.md",
    name: "core/error-handling.md",
    title: "Core: error handling",
    description: "How JMAP errors surface and how to recover.",
    content: coreErrorHandling,
    priority: 0.5,
  },
  {
    uri: "file:///fastmail-skill/email/querying.md",
    name: "email/querying.md",
    title: "Email: querying",
    description: "Filter and sort emails with Email/query.",
    content: emailQuerying,
    priority: 0.5,
  },
  {
    uri: "file:///fastmail-skill/email/reading.md",
    name: "email/reading.md",
    title: "Email: reading",
    description: "Fetch email content with Email/get.",
    content: emailReading,
    priority: 0.5,
  },
  {
    uri: "file:///fastmail-skill/email/writing.md",
    name: "email/writing.md",
    title: "Email: writing",
    description: "Create drafts, update flags, move, delete.",
    content: emailWriting,
    priority: 0.5,
  },
  {
    uri: "file:///fastmail-skill/email/search.md",
    name: "email/search.md",
    title: "Email: search",
    description: "Full-text search highlights via SearchSnippet/get.",
    content: emailSearch,
    priority: 0.5,
  },
  {
    uri: "file:///fastmail-skill/mailbox/overview.md",
    name: "mailbox/overview.md",
    title: "Mailbox: overview",
    description: "List, find, create, update, and delete mailboxes.",
    content: mailboxOverview,
    priority: 0.5,
  },
  {
    uri: "file:///fastmail-skill/patterns/unread-inbox.md",
    name: "patterns/unread-inbox.md",
    title: "Pattern: unread inbox",
    description: "Show unread messages in the inbox.",
    content: patternsUnreadInbox,
    priority: 0.5,
  },
  {
    uri: "file:///fastmail-skill/patterns/move-archive.md",
    name: "patterns/move-archive.md",
    title: "Pattern: move / archive",
    description: "Move or archive emails between mailboxes.",
    content: patternsMoveArchive,
    priority: 0.5,
  },
  {
    uri: "file:///fastmail-skill/patterns/reply.md",
    name: "patterns/reply.md",
    title: "Pattern: reply",
    description: "Compose a reply to an existing email.",
    content: patternsReply,
    priority: 0.5,
  },
  {
    uri: "file:///fastmail-skill/sending/workflow.md",
    name: "sending/workflow.md",
    title: "Sending: workflow",
    description: "End-to-end flow for sending via EmailSubmission/set.",
    content: sendingWorkflow,
    priority: 0.5,
  },
  {
    uri: "file:///fastmail-skill/thread/overview.md",
    name: "thread/overview.md",
    title: "Thread: overview",
    description: "Fetch conversation threads with Thread/get.",
    content: threadOverview,
    priority: 0.5,
  },
];

export function registerSkillResources(_server: McpServer): void {
  // Filled in by Task 5.
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/__tests__/skill.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/skill.ts src/__tests__/skill.test.ts
git commit -m "feat(skill): define SKILL_FILES data model"
```

---

## Task 3: Test metadata shape (priority, audience, mime, non-empty title/description)

**Files:**
- Modify: `src/__tests__/skill.test.ts`

- [ ] **Step 1: Add metadata tests**

Append to `src/__tests__/skill.test.ts`:

```ts
describe("SKILL_FILES metadata", () => {
  it("marks SKILL.md with priority 1.0", () => {
    const skillMd = SKILL_FILES.find((f) => f.name === "SKILL.md");
    expect(skillMd).toBeDefined();
    expect(skillMd?.priority).toBe(1.0);
  });

  it("marks every other file with priority 0.5", () => {
    for (const f of SKILL_FILES) {
      if (f.name === "SKILL.md") continue;
      expect(f.priority).toBe(0.5);
    }
  });

  it("has non-empty title and description on every file", () => {
    for (const f of SKILL_FILES) {
      expect(f.title.length).toBeGreaterThan(0);
      expect(f.description.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm test src/__tests__/skill.test.ts`
Expected: PASS (3 new tests pass; 6 total).

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/skill.test.ts
git commit -m "test(skill): verify SKILL_FILES metadata shape"
```

---

## Task 4: Test content integrity and SKILL.md link coverage

**Files:**
- Modify: `src/__tests__/skill.test.ts`

- [ ] **Step 1: Add content + link-coverage tests**

Append to `src/__tests__/skill.test.ts`:

```ts
describe("SKILL_FILES content", () => {
  it("loads SKILL.md content via bundled import", () => {
    const f = SKILL_FILES.find((f) => f.name === "SKILL.md");
    expect(f?.content).toContain("JMAP Mail Skill");
    expect(f?.content.length).toBeGreaterThan(100);
  });

  it("loads a subdirectory file (email/querying.md)", () => {
    const f = SKILL_FILES.find((f) => f.name === "email/querying.md");
    expect(f?.content.length).toBeGreaterThan(50);
  });

  it("every (X.md) link in SKILL.md is registered as a resource", () => {
    const skill = SKILL_FILES.find((f) => f.name === "SKILL.md");
    expect(skill).toBeDefined();
    // Match markdown links ending in .md — e.g. (email/querying.md)
    const linkRe = /\(([^)\s]+\.md)\)/g;
    const linkedPaths = new Set<string>();
    for (const match of skill!.content.matchAll(linkRe)) {
      linkedPaths.add(match[1]);
    }
    expect(linkedPaths.size).toBeGreaterThan(0);

    const registeredPaths = new Set(
      SKILL_FILES.map((f) => f.uri.replace("file:///fastmail-skill/", "")),
    );
    for (const path of linkedPaths) {
      expect(registeredPaths.has(path)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm test src/__tests__/skill.test.ts`
Expected: PASS (3 new tests pass; 9 total). If the link-coverage test fails, the failure message will list which linked path is missing from `SKILL_FILES` — fix the array accordingly.

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/skill.test.ts
git commit -m "test(skill): verify content and link coverage"
```

---

## Task 5: Implement `registerSkillResources` and wire it in

**Files:**
- Modify: `src/skill.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Fill in `registerSkillResources`**

Replace the placeholder `registerSkillResources` in `src/skill.ts` with:

```ts
export function registerSkillResources(server: McpServer): void {
  for (const file of SKILL_FILES) {
    server.registerResource(
      file.name,
      file.uri,
      {
        title: file.title,
        description: file.description,
        mimeType: "text/markdown",
        annotations: {
          audience: ["assistant"],
          priority: file.priority,
        },
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: file.content,
          },
        ],
      }),
    );
  }
}
```

- [ ] **Step 2: Wire into `src/index.ts`**

In `src/index.ts`, add an import next to the existing ones:

```ts
import { registerSkillResources } from "./skill.js";
```

Then add a registration call after `registerApps(mcpServer);`:

```ts
registerTools(mcpServer);
registerApps(mcpServer);
registerSkillResources(mcpServer);
```

- [ ] **Step 3: Run full check**

Run: `pnpm check`
Expected: PASS — typecheck, lint, format, tests all green.

- [ ] **Step 4: Commit**

```bash
git add src/skill.ts src/index.ts
git commit -m "feat(mcp): expose fastmail skill as MCP resources"
```

---

## Task 6: Update documentation

**Files:**
- Modify: `README.md`
- Modify: `public/landing.html`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add "Available Resources" section to README.md**

In `README.md`, insert this section immediately **after** the `read_email` tool section and **before** the `## API Endpoints` heading:

```markdown
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
```

- [ ] **Step 2: Update `public/landing.html`**

In `public/landing.html`, immediately **after** the closing `</div>` for the `tools-list` (currently around line 111) and **before** the `<h2>API Endpoints</h2>` heading, insert:

```html
  <h2>Available Resources</h2>
  <p>Resource-aware MCP clients automatically receive the Fastmail skill — a progressive-disclosure markdown corpus that teaches the LLM how to drive the <code>execute</code> JMAP tool. 13 files total, namespaced under <code>file:///fastmail-skill/</code>. <code>SKILL.md</code> is the entry point (priority 1.0); reference files are loaded on demand.</p>
```

- [ ] **Step 3: Update CLAUDE.md**

In `CLAUDE.md`, replace the existing "Documentation" section:

```markdown
## Documentation

When adding, removing, or renaming tools, update **all three locations**:

1. `src/tools.ts` — `toolDefinitions` object and `registerTools()` function
2. `README.md` — "Available Tools" section
3. `public/landing.html` — tools list in the landing page
```

with:

```markdown
## Documentation

When adding, removing, or renaming **tools**, update **all three locations**:

1. `src/tools.ts` — `toolDefinitions` object and `registerTools()` function
2. `README.md` — "Available Tools" section
3. `public/landing.html` — tools list in the landing page

When adding, removing, or renaming **skill files** under `fastmail-skill/`:

1. `src/skill.ts` — `SKILL_FILES` array (add/remove the corresponding entry and import)
2. `README.md` — "Available Resources" table
3. The `src/__tests__/skill.test.ts` link-coverage test will catch references that exist in `SKILL.md` but are not registered.
```

- [ ] **Step 4: Run full check**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md public/landing.html CLAUDE.md
git commit -m "docs: document fastmail skill as MCP resources"
```

---

## Task 7: Manual verification with dev server

**Files:** none (runtime verification only).

- [ ] **Step 1: Start the dev server**

Run: `pnpm dev`
Expected: wrangler dev server starts, listens on a local port (typically 8787).

- [ ] **Step 2: Verify resources/list returns 13 entries**

In a separate terminal, initialize a session and list resources. First initialize:

```bash
curl -sS -X POST http://127.0.0.1:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -D /tmp/mcp-headers.txt \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"plan-verify","version":"0"}}}'
```

Grab the session ID from the response headers:

```bash
SESSION=$(grep -i '^mcp-session-id:' /tmp/mcp-headers.txt | awk '{print $2}' | tr -d '\r')
```

Send the `initialized` notification:

```bash
curl -sS -X POST http://127.0.0.1:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
```

List resources:

```bash
curl -sS -X POST http://127.0.0.1:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":2,"method":"resources/list"}'
```

Expected: response contains 13 resource entries under `result.resources`, each with `uri`, `name`, `title`, `description`, `mimeType: "text/markdown"`, `annotations.audience: ["assistant"]`, and `annotations.priority` (1.0 for `SKILL.md`, 0.5 for the rest).

- [ ] **Step 3: Verify resources/read returns SKILL.md content**

```bash
curl -sS -X POST http://127.0.0.1:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":3,"method":"resources/read","params":{"uri":"file:///fastmail-skill/SKILL.md"}}'
```

Expected: response contains `result.contents[0].text` starting with `# JMAP Mail Skill` and running to the full SKILL.md body. `mimeType` is `text/markdown`.

- [ ] **Step 4: Spot-check one subdirectory file**

```bash
curl -sS -X POST http://127.0.0.1:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":4,"method":"resources/read","params":{"uri":"file:///fastmail-skill/email/querying.md"}}'
```

Expected: response contains the full `email/querying.md` body.

- [ ] **Step 5: Stop the dev server**

In the dev-server terminal, Ctrl+C.

- [ ] **Step 6: Final sanity — full check one more time**

Run: `pnpm check`
Expected: PASS across typecheck, lint, format, and tests.

No commit for this task — it is verification only.

---

## Self-Review Notes

Before handing off, this plan has been self-reviewed against the spec:

- ✅ URI scheme `file:///fastmail-skill/<path>` — Task 2 SKILL_FILES array
- ✅ 13 resources — Tasks 2 & 3 tests
- ✅ Metadata: title, description, mimeType, audience, priority — Task 3, Task 5
- ✅ Bundling via wrangler Text rule — Task 1
- ✅ Code layout: `src/skill.ts` + wire into `src/index.ts` — Tasks 2 & 5
- ✅ Tests (listing, reading, link coverage) — Tasks 2, 3, 4
- ✅ Docs: README, landing.html, CLAUDE.md — Task 6
- ✅ Manual verification — Task 7

No placeholders, no TBDs, no "similar to Task N" references. Code blocks are complete.
