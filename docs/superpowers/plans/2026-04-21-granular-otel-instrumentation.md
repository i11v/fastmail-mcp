# Granular OTEL Instrumentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand OTEL tracing on MCP tool calls (`execute`, `read_email`, `compose_email`) so each call produces a queryable trace of network I/O, user elicitation, JMAP-level errors, and every unhappy-path outcome — per the design spec `docs/superpowers/specs/2026-04-19-granular-otel-instrumentation-design.md`.

**Architecture:** Each tool handler continues to own a root span (per ADR-001). Two new child-span types are added: `jmap_request` (wraps the Fastmail POST inside `runJMAPDirect`) and `elicit_input` (wraps the destructive-action gate when it fires). Parent context is passed explicitly as function arguments — never via `AsyncLocalStorage`, because the MCP SDK breaks it. Unhappy paths are recorded as span events through a small helper `src/observability.ts`, and one `console.error` in the outer `catch` survives OTEL flush loss on truly unexpected errors.

**Tech Stack:** TypeScript, `@opentelemetry/api`, `@opentelemetry/sdk-trace-base` (`InMemorySpanExporter` for tests), vitest, Cloudflare Workers runtime, Hono, `@modelcontextprotocol/sdk`.

---

## File Structure

**New files:**
- `src/observability.ts` — `recordEvent(span, name, attrs, opts?)` helper.
- `src/__tests__/helpers/otel.ts` — test helper that installs an `InMemorySpanExporter` as the global tracer provider and exposes it for assertions.
- `src/__tests__/observability.test.ts` — unit tests for `recordEvent`.
- `src/__tests__/execute.trace.test.ts` — integration tests for `tool:execute` tracing (validation failures, JMAP response errors, elicitation paths).
- `src/__tests__/apps.trace.test.ts` — integration tests for `tool:read_email` and `tool:compose_email` tracing.

**Modified files:**
- `src/tools.ts` — extract `executeHandler` as a testable export, add pre-validation attribute labeling, wrap the POST in `runJMAPDirect` with a `jmap_request` span (single-read body + HTTP attrs + `jmap.response_error` events), wrap the destructive gate in an `elicit_input` span, record `error.class` + span events on every known unhappy path.
- `src/apps.ts` — extract `readEmailHandler` and `composeEmailHandler`, add root spans with full attribute coverage. `composeEmailHandler` gains `extra` to read the bearer token for `user.id`.

---

## Task 1: Refactor tool handlers into exported functions

**Why:** Tests need to call handlers directly. Right now they only exist as inline closures inside `registerTools` / `registerApps`. This task is a pure refactor — no behavior changes, existing tests must still pass.

**Files:**
- Modify: `src/tools.ts`
- Modify: `src/apps.ts`

- [ ] **Step 1: Run existing tests to confirm green baseline**

Run: `pnpm test`
Expected: all tests pass (execute.test.ts, format.test.ts, tools.test.ts).

- [ ] **Step 2: Extract `executeHandler` from `registerTools` in `src/tools.ts`**

Add this export above `registerTools`:

```ts
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Elicitation dependency is passed in so the handler can be unit-tested
// without constructing a full McpServer.
export type ElicitInputFn = (params: {
  message: string;
  requestedSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}) => Promise<{ action: string; content?: Record<string, unknown> }>;

export async function executeHandler(
  args: z.infer<typeof ExecuteSchema>,
  extra: RequestHandlerExtra<any, any>,
  deps: { elicitInput: ElicitInputFn },
): Promise<CallToolResult> {
  const span = tracer.startSpan("tool:execute");
  try {
    const validated = validateStructure(args.methodCalls);
    validateResultReferences(validated);
    validateHygiene(validated);

    const safety = classifySafety(validated);
    span.setAttributes({
      "mcp.tool": "execute",
      "jmap.method_count": validated.length,
      "jmap.methods": validated.map(([m]) => m).join(", "),
      "jmap.safety": safety,
    });

    if (safety === "destructive") {
      if (!args.confirmed) {
        try {
          const elicitResult = await deps.elicitInput({
            message: `This will ${describeDestructiveAction(validated)}. Proceed?`,
            requestedSchema: {
              type: "object" as const,
              properties: {
                confirmed: {
                  type: "boolean" as const,
                  description: "Confirm the destructive operation",
                },
              },
              required: ["confirmed"],
            },
          });
          if (elicitResult.action !== "accept" || !elicitResult.content?.confirmed) {
            span.setAttribute("mcp.outcome", "cancelled");
            return { content: [{ type: "text", text: "Operation cancelled by user." }] };
          }
        } catch {
          const description = describeDestructiveAction(validated);
          span.setAttribute("mcp.outcome", "awaiting_confirmation");
          return {
            content: [
              {
                type: "text",
                text:
                  `⚠️ Confirmation required: this will ${description}. ` +
                  `IMPORTANT: Do NOT proceed automatically — you MUST ask the user for explicit confirmation first. ` +
                  `Only if the user confirms, call this tool again with the same methodCalls and confirmed: true.`,
              },
            ],
          };
        }
      }
    }

    const result = await runJMAP(validated, extra, span);
    span.setAttribute("mcp.outcome", "success");
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  } finally {
    span.end();
    await forceFlush();
  }
}
```

Replace the inline handler inside `registerTools` with:

```ts
async (args, extra) =>
  executeHandler(args, extra, {
    elicitInput: server.server.elicitInput.bind(server.server),
  }),
```

- [ ] **Step 3: Extract `readEmailHandler` and `composeEmailHandler` from `src/apps.ts`**

Add these exports above `registerApps`:

```ts
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";

export async function readEmailHandler(
  args: { emailId: string },
  extra: RequestHandlerExtra<any, any>,
): Promise<CallToolResult> {
  try {
    const { session, bearerToken } = await getSession(extra);
    const result = await runJMAPDirect(
      [
        [
          "Email/get",
          {
            ids: [args.emailId],
            properties: [
              "id",
              "threadId",
              "from",
              "to",
              "cc",
              "bcc",
              "replyTo",
              "subject",
              "receivedAt",
              "sentAt",
              "keywords",
              "hasAttachment",
              "htmlBody",
              "textBody",
              "bodyValues",
            ],
            fetchHTMLBodyValues: true,
            fetchTextBodyValues: true,
          },
          "get",
        ],
      ],
      session,
      bearerToken,
    );

    const getResult = result[0] as [string, { list?: any[] }, string] | undefined;
    const email = getResult?.[1]?.list?.[0];

    if (!email) {
      return {
        content: [{ type: "text", text: `Error: Email with ID "${args.emailId}" not found.` }],
        isError: true,
      };
    }

    const body = formatEmailBody(email);

    const emailData = {
      id: email.id,
      threadId: email.threadId,
      from: email.from,
      to: email.to,
      cc: email.cc,
      bcc: email.bcc,
      replyTo: email.replyTo,
      subject: email.subject,
      receivedAt: email.receivedAt,
      sentAt: email.sentAt,
      keywords: email.keywords,
      hasAttachment: email.hasAttachment,
      htmlBody: body.html,
      textBody: body.text,
      body: body.content,
    };

    const from = email.from?.[0];
    const fromStr = from
      ? from.name
        ? `${from.name} <${from.email}>`
        : from.email
      : "unknown";
    const summary = [
      `Email displayed in widget.`,
      `From: ${fromStr}`,
      `Subject: ${email.subject ?? "(no subject)"}`,
      `Date: ${email.sentAt ?? email.receivedAt ?? "unknown"}`,
      email.hasAttachment ? "Has attachments." : "",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      content: [{ type: "text", text: summary }],
      structuredContent: emailData,
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

export async function composeEmailHandler(
  args: {
    to?: string;
    cc?: string;
    bcc?: string;
    subject?: string;
    body?: string;
  },
  _extra: RequestHandlerExtra<any, any>,
): Promise<CallToolResult> {
  const prefill: Record<string, string> = {};
  if (args.to) prefill.to = args.to;
  if (args.cc) prefill.cc = args.cc;
  if (args.bcc) prefill.bcc = args.bcc;
  if (args.subject) prefill.subject = args.subject;
  if (args.body) prefill.body = args.body;

  const text =
    Object.keys(prefill).length > 0
      ? `Opening compose form with pre-filled fields: ${Object.keys(prefill).join(", ")}`
      : "Opening compose form.";

  return {
    content: [
      { type: "text", text: JSON.stringify(prefill) },
      { type: "text", text },
    ],
    structuredContent: prefill,
  };
}
```

Replace the inline handlers inside `registerApps` with:

```ts
registerAppTool(server, "compose_email", { ... }, composeEmailHandler);
registerAppTool(server, "read_email", { ... }, readEmailHandler);
```

(Keep the existing tool metadata objects unchanged — only the handler function changes.)

- [ ] **Step 4: Run `pnpm check` to verify refactor is clean**

Run: `pnpm check`
Expected: typecheck passes, lint passes, format passes, all existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts src/apps.ts
git commit -m "refactor: extract tool handlers as exported functions"
```

---

## Task 2: OTEL test-helper module

**Why:** Trace assertions need an `InMemorySpanExporter` registered as the global tracer provider. Centralizing setup keeps test files short.

**Files:**
- Create: `src/__tests__/helpers/otel.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/helpers/otel.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { trace } from "@opentelemetry/api";
import { setupInMemoryTracing } from "./otel.js";

describe("setupInMemoryTracing", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("captures spans created after setup", () => {
    const { exporter, cleanup: c } = setupInMemoryTracing();
    cleanup = c;

    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("unit");
    span.setAttribute("kind", "probe");
    span.end();

    const finished = exporter.getFinishedSpans();
    expect(finished).toHaveLength(1);
    expect(finished[0].name).toBe("unit");
    expect(finished[0].attributes.kind).toBe("probe");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- otel.test`
Expected: FAIL — module `./otel.js` cannot be resolved.

- [ ] **Step 3: Create the helper**

Create `src/__tests__/helpers/otel.ts`:

```ts
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";

export function setupInMemoryTracing(): {
  exporter: InMemorySpanExporter;
  cleanup: () => void;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  return {
    exporter,
    cleanup: () => {
      trace.disable();
      exporter.reset();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- otel.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/helpers/otel.ts src/__tests__/helpers/otel.test.ts
git commit -m "test: add in-memory OTEL tracing helper"
```

---

## Task 3: `recordEvent` observability helper

**Why:** Every unhappy-path record is a `span.addEvent(name, attrs)` call, plus a single `console.error` for truly unexpected errors. The helper wraps both so call sites stay one line.

**Files:**
- Create: `src/observability.ts`
- Create: `src/__tests__/observability.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/observability.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { trace } from "@opentelemetry/api";
import { setupInMemoryTracing } from "./helpers/otel.js";
import { recordEvent } from "../observability.js";

describe("recordEvent", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.restoreAllMocks();
  });

  it("adds a span event with attributes", () => {
    const { exporter, cleanup: c } = setupInMemoryTracing();
    cleanup = c;

    const span = trace.getTracer("test").startSpan("parent");
    recordEvent(span, "test.event", { key: "value", count: 3 });
    span.end();

    const finished = exporter.getFinishedSpans();
    expect(finished).toHaveLength(1);
    expect(finished[0].events).toHaveLength(1);
    expect(finished[0].events[0].name).toBe("test.event");
    expect(finished[0].events[0].attributes).toEqual({ key: "value", count: 3 });
  });

  it("does not log to console by default", () => {
    const { cleanup: c } = setupInMemoryTracing();
    cleanup = c;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const span = trace.getTracer("test").startSpan("parent");
    recordEvent(span, "test.event", { key: "value" });
    span.end();

    expect(errSpy).not.toHaveBeenCalled();
  });

  it("also console.errors a structured line when alsoLog is true", () => {
    const { cleanup: c } = setupInMemoryTracing();
    cleanup = c;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const span = trace.getTracer("test").startSpan("parent");
    recordEvent(span, "test.unexpected", { message: "boom" }, { alsoLog: true });
    span.end();

    expect(errSpy).toHaveBeenCalledTimes(1);
    const payload = errSpy.mock.calls[0][0];
    expect(payload).toMatchObject({ event: "test.unexpected", message: "boom" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- observability`
Expected: FAIL — `../observability.js` cannot be resolved.

- [ ] **Step 3: Create `src/observability.ts`**

```ts
import type { AttributeValue, Span } from "@opentelemetry/api";

/**
 * Adds a span event with structured attributes.
 *
 * For truly unexpected errors — paths that don't have a known `error.class`
 * — pass `{ alsoLog: true }` to also emit a structured `console.error`
 * line. On Cloudflare Workers this is captured by Workers Logs and
 * survives OTEL flush loss on crash paths.
 *
 * Every other unhappy path is span-event only.
 */
export function recordEvent(
  span: Span,
  name: string,
  attrs: Record<string, AttributeValue>,
  opts?: { alsoLog?: boolean },
): void {
  span.addEvent(name, attrs);
  if (opts?.alsoLog) {
    console.error({ event: name, ...attrs });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- observability`
Expected: PASS (all 3 cases).

- [ ] **Step 5: Commit**

```bash
git add src/observability.ts src/__tests__/observability.test.ts
git commit -m "feat(obs): add recordEvent helper for span events"
```

---

## Task 4: `tool:execute` — pre-validation labels + `jmap.methods` array

**Why:** Right now all `tool:execute` attributes are set *after* validation. A validation failure leaves the span unlabeled. Moving `jmap.method_count` and `jmap.methods` to before validation gives us filterable spans on every failure. This task also migrates `jmap.methods` from comma-joined string to `string[]` (breaking change noted in the spec).

**Files:**
- Modify: `src/tools.ts` (inside `executeHandler`)
- Create: `src/__tests__/execute.trace.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/execute.trace.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { setupInMemoryTracing } from "./helpers/otel.js";
import { executeHandler } from "../tools.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";

const fakeExtra = {
  requestInfo: { headers: { authorization: "Bearer test-token" } },
} as unknown as RequestHandlerExtra<any, any>;

const noopElicit = vi.fn().mockResolvedValue({ action: "accept", content: { confirmed: true } });

describe("tool:execute — pre-validation labels", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.restoreAllMocks();
  });

  it("sets jmap.method_count and jmap.methods[] even when validation fails", async () => {
    const { exporter, cleanup: c } = setupInMemoryTracing();
    cleanup = c;

    await executeHandler(
      {
        methodCalls: [
          ["Email/query", {}, "call-0"], // fails hygiene: no limit
          ["Email/get", { ids: ["x"], properties: ["subject"] }, "call-1"],
        ],
      },
      fakeExtra,
      { elicitInput: noopElicit },
    );

    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === "tool:execute");
    expect(root).toBeDefined();
    expect(root!.attributes["jmap.method_count"]).toBe(2);
    expect(root!.attributes["jmap.methods"]).toEqual(["Email/query", "Email/get"]);
  });

  it("records jmap.methods[] as array of strings even for non-string entries", async () => {
    const { exporter, cleanup: c } = setupInMemoryTracing();
    cleanup = c;

    await executeHandler(
      {
        // @ts-expect-error — testing defensive labeling against malformed input
        methodCalls: [[42, {}, "call-0"]],
      },
      fakeExtra,
      { elicitInput: noopElicit },
    );

    const root = exporter.getFinishedSpans().find((s) => s.name === "tool:execute")!;
    expect(root.attributes["jmap.methods"]).toEqual(["<invalid>"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- execute.trace`
Expected: FAIL — either `jmap.methods` is still a string or the attributes are missing because validation threw first.

- [ ] **Step 3: Move labeling before validation in `executeHandler`**

In `src/tools.ts`, inside `executeHandler`, replace the existing label block:

```ts
// BEFORE:
const validated = validateStructure(args.methodCalls);
validateResultReferences(validated);
validateHygiene(validated);

const safety = classifySafety(validated);
span.setAttributes({
  "mcp.tool": "execute",
  "jmap.method_count": validated.length,
  "jmap.methods": validated.map(([m]) => m).join(", "),
  "jmap.safety": safety,
});
```

with:

```ts
// AFTER:
span.setAttribute("mcp.tool", "execute");
const rawCalls = Array.isArray(args.methodCalls) ? args.methodCalls : [];
span.setAttribute("jmap.method_count", rawCalls.length);
span.setAttribute(
  "jmap.methods",
  rawCalls.map((c) => (Array.isArray(c) && typeof c[0] === "string" ? c[0] : "<invalid>")),
);

const validated = validateStructure(args.methodCalls);
validateResultReferences(validated);
validateHygiene(validated);

const safety = classifySafety(validated);
span.setAttribute("jmap.safety", safety);
span.setAttribute("mcp.confirmed", args.confirmed === true);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- execute.trace`
Expected: PASS.

- [ ] **Step 5: Run full check and fix any regression**

Run: `pnpm check`
Expected: all pass. If any existing test asserted on `jmap.methods` as a comma-joined string, it will fail — none currently do, but verify.

- [ ] **Step 6: Commit**

```bash
git add src/tools.ts src/__tests__/execute.trace.test.ts
git commit -m "feat(otel): label execute span before validation, jmap.methods as string[]

BREAKING CHANGE: jmap.methods attribute is now a string[] instead of a
comma-joined string. Any Honeycomb query filtering on this attribute
needs to switch to array-contains semantics."
```

---

## Task 5: `tool:execute` — validation span events + `error.class` + auth event

**Why:** Without these, a failed `execute` call only records the thrown `Error` with no structured breakdown of *which* stage failed. Span events make each unhappy path filterable.

**Files:**
- Modify: `src/tools.ts` (inside `executeHandler` and validation helpers)
- Modify: `src/__tests__/execute.trace.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/execute.trace.test.ts`:

```ts
describe("tool:execute — unhappy-path span events", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.restoreAllMocks();
  });

  it("emits execute.validation_failed with stage=hygiene when /query lacks limit", async () => {
    const { exporter, cleanup: c } = setupInMemoryTracing();
    cleanup = c;

    await executeHandler(
      { methodCalls: [["Email/query", {}, "call-0"]] },
      fakeExtra,
      { elicitInput: noopElicit },
    );

    const root = exporter.getFinishedSpans().find((s) => s.name === "tool:execute")!;
    const evt = root.events.find((e) => e.name === "execute.validation_failed");
    expect(evt).toBeDefined();
    expect(evt!.attributes).toMatchObject({
      stage: "hygiene",
      index: 0,
      method: "Email/query",
    });
    expect(root.attributes["error.class"]).toBe("validation");
    expect(root.attributes["mcp.outcome"]).toBe("error");
  });

  it("emits execute.auth_missing when Authorization header is absent", async () => {
    const { exporter, cleanup: c } = setupInMemoryTracing();
    cleanup = c;

    // Mock fetch so no real network call happens; we expect the auth check
    // to trip first.
    vi.stubGlobal("fetch", vi.fn());

    const extraNoAuth = { requestInfo: { headers: {} } } as unknown as RequestHandlerExtra<
      any,
      any
    >;

    await executeHandler(
      {
        methodCalls: [
          ["Email/get", { ids: ["x"], properties: ["subject"] }, "call-0"],
        ],
      },
      extraNoAuth,
      { elicitInput: noopElicit },
    );

    const root = exporter.getFinishedSpans().find((s) => s.name === "tool:execute")!;
    const evt = root.events.find((e) => e.name === "execute.auth_missing");
    expect(evt).toBeDefined();
    expect(evt!.attributes).toMatchObject({ reason: "no_header" });
    expect(root.attributes["error.class"]).toBe("auth");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- execute.trace`
Expected: FAIL — `execute.validation_failed` / `execute.auth_missing` events are not emitted, and `error.class` is undefined.

- [ ] **Step 3: Tag validation errors with stage/index/method**

In `src/tools.ts`, change the validation helpers to throw a richer error. Add a local error class near the top of the file (after imports):

```ts
export class ValidationError extends Error {
  constructor(
    public stage: "structure" | "references" | "hygiene",
    public index: number,
    public method: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}
```

Update each throw inside `validateStructure`, `validateResultReferences`, and `validateHygiene` to throw `ValidationError` instead of `Error`. Example for `validateStructure`'s "must be a triple" branch:

```ts
throw new ValidationError(
  "structure",
  i,
  undefined,
  `methodCalls[${i}]: must be a triple [methodName, args, callId]. Got ${JSON.stringify(call)}`,
);
```

Apply the same transformation to every other throw inside the three validators, preserving the original message but setting the appropriate `stage`, `index`, and `method` (use `method` when it's a valid string, otherwise `undefined`). For `validateHygiene`, `method` is always the first element of the triple.

Update `extractBearerToken` to throw a tagged error so the handler can classify it:

```ts
export class AuthError extends Error {
  constructor(public reason: "no_header" | "malformed", message: string) {
    super(message);
    this.name = "AuthError";
  }
}

function extractBearerToken(extra: RequestHandlerExtra<any, any>): string {
  const headers = extra.requestInfo?.headers;
  if (!headers) {
    throw new AuthError("no_header", "Missing request headers.");
  }
  const authHeader = headers["authorization"] || headers["Authorization"];
  if (!authHeader || typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    throw new AuthError(
      authHeader ? "malformed" : "no_header",
      "Missing bearer token. Ensure Authorization header is set with 'Bearer <token>' format.",
    );
  }
  return authHeader.substring(7);
}
```

- [ ] **Step 4: Classify errors and emit span events in `executeHandler`**

Replace the outer `catch` block in `executeHandler` with:

```ts
} catch (error) {
  let errorClass: string = "unknown";
  if (error instanceof ValidationError) {
    errorClass = "validation";
    recordEvent(span, "execute.validation_failed", {
      stage: error.stage,
      index: error.index,
      method: error.method ?? "<unknown>",
      message: error.message,
    });
  } else if (error instanceof AuthError) {
    errorClass = "auth";
    recordEvent(span, "execute.auth_missing", { reason: error.reason });
  } else {
    recordEvent(
      span,
      "execute.unexpected_error",
      {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? (error.stack ?? "") : "",
      },
      { alsoLog: true },
    );
  }
  span.setAttribute("error.class", errorClass);
  span.setAttribute("mcp.outcome", "error");
  span.recordException(error as Error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
  return {
    content: [
      {
        type: "text",
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
    isError: true,
  };
}
```

Add the import at the top of `src/tools.ts`:

```ts
import { recordEvent } from "./observability.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- execute.trace`
Expected: PASS.

- [ ] **Step 6: Run full check**

Run: `pnpm check`
Expected: all pass (existing validation tests still pass because `ValidationError extends Error` and messages are preserved).

- [ ] **Step 7: Commit**

```bash
git add src/tools.ts src/__tests__/execute.trace.test.ts
git commit -m "feat(otel): tag validation/auth failures with error.class and span events"
```

---

## Task 6: `jmap_request` child span + single-read body + response-error events

**Why:** The JMAP POST is the biggest black box in today's traces. This task wraps it in its own span with full HTTP attributes, counts JMAP-level errors inside HTTP 200s, and emits one event per error. Because it wraps `runJMAPDirect`, both `execute` and `read_email` get instrumented.

**Files:**
- Modify: `src/tools.ts` (`runJMAPDirect` and its call sites)
- Modify: `src/__tests__/execute.trace.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/execute.trace.test.ts`:

```ts
describe("jmap_request span", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mockFetch(sessionBody: object, jmapResponse: object | string, jmapStatus = 200) {
    const body = typeof jmapResponse === "string" ? jmapResponse : JSON.stringify(jmapResponse);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/jmap/session")) {
          return new Response(JSON.stringify(sessionBody), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(body, {
          status: jmapStatus,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
  }

  const session = {
    apiUrl: "https://api.fastmail.com/jmap/api",
    uploadUrl: "https://api.fastmail.com/upload",
    primaryAccounts: { "urn:ietf:params:jmap:mail": "acct-1" },
  };

  it("creates a jmap_request child span with HTTP + JMAP attributes on success", async () => {
    const { exporter, cleanup: c } = setupInMemoryTracing();
    cleanup = c;

    mockFetch(session, {
      methodResponses: [["Email/get", { list: [] }, "call-0"]],
    });

    await executeHandler(
      { methodCalls: [["Email/get", { ids: ["x"], properties: ["subject"] }, "call-0"]] },
      fakeExtra,
      { elicitInput: noopElicit },
    );

    const jmap = exporter.getFinishedSpans().find((s) => s.name === "jmap_request");
    expect(jmap).toBeDefined();
    expect(jmap!.attributes["http.request.method"]).toBe("POST");
    expect(jmap!.attributes["http.response.status_code"]).toBe(200);
    expect(jmap!.attributes["server.address"]).toBe("api.fastmail.com");
    expect(jmap!.attributes["url.path"]).toBe("/jmap/api");
    expect(jmap!.attributes["jmap.methods"]).toEqual(["Email/get"]);
    expect(jmap!.attributes["jmap.error_count"]).toBe(0);
    expect(typeof jmap!.attributes["http.request.body.size"]).toBe("number");
    expect(typeof jmap!.attributes["http.response.body.size"]).toBe("number");
  });

  it("emits one jmap.response_error event per JMAP-level error in a 200 response", async () => {
    const { exporter, cleanup: c } = setupInMemoryTracing();
    cleanup = c;

    mockFetch(session, {
      methodResponses: [
        ["error", { type: "invalidArguments", description: "bad id" }, "call-0"],
        ["Email/get", { list: [] }, "call-1"],
      ],
    });

    await executeHandler(
      {
        methodCalls: [
          ["Email/get", { ids: ["x"], properties: ["subject"] }, "call-0"],
          ["Email/get", { ids: ["y"], properties: ["subject"] }, "call-1"],
        ],
      },
      fakeExtra,
      { elicitInput: noopElicit },
    );

    const jmap = exporter.getFinishedSpans().find((s) => s.name === "jmap_request")!;
    expect(jmap.attributes["jmap.error_count"]).toBe(1);
    const errorEvents = jmap.events.filter((e) => e.name === "jmap.response_error");
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].attributes).toMatchObject({
      method: "error",
      callId: "call-0",
      type: "invalidArguments",
      description: "bad id",
    });

    const root = exporter.getFinishedSpans().find((s) => s.name === "tool:execute")!;
    expect(root.attributes["jmap.error_count"]).toBe(1);
  });

  it("emits jmap.http_error and error.class=jmap_http on non-200", async () => {
    const { exporter, cleanup: c } = setupInMemoryTracing();
    cleanup = c;

    mockFetch(session, "internal error", 500);

    await executeHandler(
      { methodCalls: [["Email/get", { ids: ["x"], properties: ["subject"] }, "call-0"]] },
      fakeExtra,
      { elicitInput: noopElicit },
    );

    const jmap = exporter.getFinishedSpans().find((s) => s.name === "jmap_request")!;
    expect(jmap.attributes["http.response.status_code"]).toBe(500);
    const evt = jmap.events.find((e) => e.name === "jmap.http_error");
    expect(evt).toBeDefined();
    expect(evt!.attributes).toMatchObject({ status: 500 });
    expect((evt!.attributes.body_preview as string).length).toBeLessThanOrEqual(500);

    const root = exporter.getFinishedSpans().find((s) => s.name === "tool:execute")!;
    expect(root.attributes["error.class"]).toBe("jmap_http");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- execute.trace`
Expected: FAIL — no `jmap_request` span, no events, no attributes.

- [ ] **Step 3: Add `JMAPHttpError` and rewrite `runJMAPDirect`**

In `src/tools.ts`, add the error class near `ValidationError`:

```ts
export class JMAPHttpError extends Error {
  constructor(public status: number, public bodyPreview: string) {
    super(`JMAP request failed: HTTP ${status}`);
    this.name = "JMAPHttpError";
  }
}
```

Replace `runJMAPDirect` with the instrumented version:

```ts
export async function runJMAPDirect(
  methodCalls: MethodCall[],
  session: JMAPSession,
  bearerToken: string,
  parentSpan?: Span,
): Promise<unknown[]> {
  const injectedCalls = injectAccountId(methodCalls, session.accountId);
  const requestBody = JSON.stringify({ using: JMAP_USING, methodCalls: injectedCalls });

  const parentCtx = parentSpan ? trace.setSpan(context.active(), parentSpan) : context.active();

  return tracer.startActiveSpan("jmap_request", {}, parentCtx, async (span) => {
    try {
      const url = new URL(session.apiUrl);
      span.setAttributes({
        "http.request.method": "POST",
        "server.address": url.host,
        "url.path": url.pathname,
        "http.request.body.size": requestBody.length,
        "jmap.method_count": methodCalls.length,
        "jmap.methods": methodCalls.map(([m]) => m),
      });

      const response = await fetch(session.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearerToken}`,
        },
        body: requestBody,
      });

      const responseText = await response.text();
      span.setAttribute("http.response.status_code", response.status);
      span.setAttribute("http.response.body.size", responseText.length);

      if (!response.ok) {
        const preview = responseText.slice(0, 500);
        recordEvent(span, "jmap.http_error", { status: response.status, body_preview: preview });
        span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${response.status}` });
        throw new JMAPHttpError(response.status, preview);
      }

      const jmapResponse = JSON.parse(responseText) as { methodResponses: unknown[] };
      const cleaned = cleanResponse(jmapResponse.methodResponses);

      // Count and report JMAP-level errors (["error", {...}, callId]).
      let errorCount = 0;
      for (const resp of cleaned) {
        if (Array.isArray(resp) && resp[0] === "error") {
          errorCount += 1;
          const [method, payload, callId] = resp as [string, Record<string, unknown>, string];
          recordEvent(span, "jmap.response_error", {
            method,
            callId,
            type: typeof payload?.type === "string" ? (payload.type as string) : "<unknown>",
            description:
              typeof payload?.description === "string" ? (payload.description as string) : "",
          });
        }
      }
      span.setAttribute("jmap.error_count", errorCount);
      parentSpan?.setAttribute("jmap.error_count", errorCount);

      return cleaned;
    } catch (error) {
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  });
}
```

- [ ] **Step 4: Update outer `catch` in `executeHandler` to classify JMAP errors**

Extend the `error.class` branch in `executeHandler`'s catch (added in Task 5) with:

```ts
} else if (error instanceof JMAPHttpError) {
  errorClass = "jmap_http";
  // span event already emitted on the child span inside runJMAPDirect
}
```

Place this branch before the `else` (unknown) branch.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- execute.trace`
Expected: PASS.

- [ ] **Step 6: Run full check**

Run: `pnpm check`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/tools.ts src/__tests__/execute.trace.test.ts
git commit -m "feat(otel): jmap_request child span with HTTP and JMAP error attributes"
```

---

## Task 7: `elicit_input` child span

**Why:** The destructive-action safety gate awaits user input and can dominate wall-clock time on destructive calls. A dedicated span captures user think-time and the elicit outcome separately from the rest of `execute`.

**Files:**
- Modify: `src/tools.ts` (inside `executeHandler` destructive branch)
- Modify: `src/__tests__/execute.trace.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/execute.trace.test.ts`:

```ts
describe("elicit_input span", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const destructiveCalls = [
    ["Email/set", { destroy: ["id1"] }, "call-0"],
  ] as const;

  it("creates elicit_input span with accept outcome", async () => {
    const { exporter, cleanup: c } = setupInMemoryTracing();
    cleanup = c;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/jmap/session")) {
          return new Response(
            JSON.stringify({
              apiUrl: "https://api.fastmail.com/jmap/api",
              uploadUrl: "https://api.fastmail.com/upload",
              primaryAccounts: { "urn:ietf:params:jmap:mail": "acct-1" },
            }),
          );
        }
        return new Response(
          JSON.stringify({ methodResponses: [["Email/set", { destroyed: ["id1"] }, "call-0"]] }),
        );
      }),
    );

    const elicit = vi.fn().mockResolvedValue({ action: "accept", content: { confirmed: true } });

    await executeHandler(
      { methodCalls: [...destructiveCalls] as any },
      fakeExtra,
      { elicitInput: elicit },
    );

    const elicitSpan = exporter.getFinishedSpans().find((s) => s.name === "elicit_input");
    expect(elicitSpan).toBeDefined();
    expect(elicitSpan!.attributes["mcp.elicit.supported"]).toBe(true);
    expect(elicitSpan!.attributes["mcp.elicit.action"]).toBe("accept");
    expect(elicitSpan!.attributes["mcp.elicit.confirmed"]).toBe(true);
  });

  it("records decline action and cancels the operation", async () => {
    const { exporter, cleanup: c } = setupInMemoryTracing();
    cleanup = c;

    const elicit = vi.fn().mockResolvedValue({ action: "decline" });

    await executeHandler(
      { methodCalls: [...destructiveCalls] as any },
      fakeExtra,
      { elicitInput: elicit },
    );

    const elicitSpan = exporter.getFinishedSpans().find((s) => s.name === "elicit_input")!;
    expect(elicitSpan.attributes["mcp.elicit.action"]).toBe("decline");

    const root = exporter.getFinishedSpans().find((s) => s.name === "tool:execute")!;
    expect(root.attributes["mcp.outcome"]).toBe("cancelled");
  });

  it("records mcp.elicit.supported=false on elicit throw and falls back to two-step", async () => {
    const { exporter, cleanup: c } = setupInMemoryTracing();
    cleanup = c;

    const elicit = vi.fn().mockRejectedValue(new Error("not supported"));

    const result = await executeHandler(
      { methodCalls: [...destructiveCalls] as any },
      fakeExtra,
      { elicitInput: elicit },
    );

    const elicitSpan = exporter.getFinishedSpans().find((s) => s.name === "elicit_input")!;
    expect(elicitSpan.attributes["mcp.elicit.supported"]).toBe(false);

    const root = exporter.getFinishedSpans().find((s) => s.name === "tool:execute")!;
    expect(root.attributes["mcp.outcome"]).toBe("awaiting_confirmation");
    expect(result.content[0]).toMatchObject({ type: "text" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- execute.trace`
Expected: FAIL — no `elicit_input` span exists yet.

- [ ] **Step 3: Wrap the destructive gate in a child span**

In `executeHandler`, replace the existing destructive branch:

```ts
if (safety === "destructive") {
  if (!args.confirmed) {
    const parentCtx = trace.setSpan(context.active(), span);
    const gateResult = await tracer.startActiveSpan(
      "elicit_input",
      {},
      parentCtx,
      async (elicitSpan) => {
        try {
          const elicitResult = await deps.elicitInput({
            message: `This will ${describeDestructiveAction(validated)}. Proceed?`,
            requestedSchema: {
              type: "object" as const,
              properties: {
                confirmed: {
                  type: "boolean" as const,
                  description: "Confirm the destructive operation",
                },
              },
              required: ["confirmed"],
            },
          });
          elicitSpan.setAttributes({
            "mcp.elicit.supported": true,
            "mcp.elicit.action": elicitResult.action,
            "mcp.elicit.confirmed": Boolean(elicitResult.content?.confirmed),
          });
          if (elicitResult.action !== "accept" || !elicitResult.content?.confirmed) {
            return { kind: "cancelled" as const };
          }
          return { kind: "proceed" as const };
        } catch {
          elicitSpan.setAttribute("mcp.elicit.supported", false);
          return { kind: "awaiting" as const };
        } finally {
          elicitSpan.end();
        }
      },
    );

    if (gateResult.kind === "cancelled") {
      span.setAttribute("mcp.outcome", "cancelled");
      return { content: [{ type: "text", text: "Operation cancelled by user." }] };
    }
    if (gateResult.kind === "awaiting") {
      const description = describeDestructiveAction(validated);
      span.setAttribute("mcp.outcome", "awaiting_confirmation");
      return {
        content: [
          {
            type: "text",
            text:
              `⚠️ Confirmation required: this will ${description}. ` +
              `IMPORTANT: Do NOT proceed automatically — you MUST ask the user for explicit confirmation first. ` +
              `Only if the user confirms, call this tool again with the same methodCalls and confirmed: true.`,
          },
        ],
      };
    }
    // else kind === "proceed": fall through to JMAP execution
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- execute.trace`
Expected: PASS.

- [ ] **Step 5: Run full check**

Run: `pnpm check`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/tools.ts src/__tests__/execute.trace.test.ts
git commit -m "feat(otel): elicit_input child span for destructive-action gate"
```

---

## Task 8: `tool:read_email` root span

**Why:** `read_email` currently has zero tracing. Parity with `execute` means a root span, full attribute coverage, and a `read_email.not_found` event for unknown IDs. Because `read_email` already calls `runJMAPDirect`, JMAP-level instrumentation is already in place from Task 6 — we just need to thread the parent span through.

**Files:**
- Modify: `src/apps.ts` (`readEmailHandler`)
- Modify: `src/tools.ts` (`getSession` now receives a parent span)
- Create: `src/__tests__/apps.trace.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/apps.trace.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { setupInMemoryTracing } from "./helpers/otel.js";
import { readEmailHandler } from "../apps.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";

const fakeExtra = {
  requestInfo: { headers: { authorization: "Bearer test-token" } },
} as unknown as RequestHandlerExtra<any, any>;

function stubFetch(emailList: object[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/jmap/session")) {
        return new Response(
          JSON.stringify({
            apiUrl: "https://api.fastmail.com/jmap/api",
            uploadUrl: "https://api.fastmail.com/upload",
            primaryAccounts: { "urn:ietf:params:jmap:mail": "acct-1" },
          }),
        );
      }
      return new Response(
        JSON.stringify({ methodResponses: [["Email/get", { list: emailList }, "get"]] }),
      );
    }),
  );
}

describe("tool:read_email tracing", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates tool:read_email root span with email.found=true on success", async () => {
    const { exporter, cleanup: c } = setupInMemoryTracing();
    cleanup = c;

    stubFetch([
      {
        id: "m1",
        threadId: "t1",
        from: [{ email: "a@b", name: "A" }],
        subject: "hi",
        receivedAt: "2026-04-20T00:00:00Z",
        hasAttachment: false,
      },
    ]);

    await readEmailHandler({ emailId: "m1" }, fakeExtra);

    const root = exporter.getFinishedSpans().find((s) => s.name === "tool:read_email");
    expect(root).toBeDefined();
    expect(root!.attributes["mcp.tool"]).toBe("read_email");
    expect(root!.attributes["email.id"]).toBe("m1");
    expect(root!.attributes["email.found"]).toBe(true);
    expect(root!.attributes["mcp.outcome"]).toBe("success");
    expect(typeof root!.attributes["user.id"]).toBe("string");
  });

  it("emits read_email.not_found and email.found=false when ID is unknown", async () => {
    const { exporter, cleanup: c } = setupInMemoryTracing();
    cleanup = c;

    stubFetch([]);

    await readEmailHandler({ emailId: "missing" }, fakeExtra);

    const root = exporter.getFinishedSpans().find((s) => s.name === "tool:read_email")!;
    expect(root.attributes["email.found"]).toBe(false);
    const evt = root.events.find((e) => e.name === "read_email.not_found");
    expect(evt).toBeDefined();
    expect(evt!.attributes).toMatchObject({ emailId: "missing" });
  });

  it("contains a jmap_request child span from runJMAPDirect", async () => {
    const { exporter, cleanup: c } = setupInMemoryTracing();
    cleanup = c;

    stubFetch([{ id: "m1", subject: "hi" }]);

    await readEmailHandler({ emailId: "m1" }, fakeExtra);

    const jmap = exporter.getFinishedSpans().find((s) => s.name === "jmap_request");
    expect(jmap).toBeDefined();
    const root = exporter.getFinishedSpans().find((s) => s.name === "tool:read_email")!;
    expect(jmap!.parentSpanId).toBe(root.spanContext().spanId);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- apps.trace`
Expected: FAIL — `tool:read_email` span does not exist yet.

- [ ] **Step 3: Wrap `readEmailHandler` in a root span**

In `src/apps.ts`, replace `readEmailHandler` with the instrumented version:

```ts
import { SpanStatusCode } from "@opentelemetry/api";
import { tracer, forceFlush, getSession, runJMAPDirect } from "./tools.js";
import { recordEvent } from "./observability.js";

export async function readEmailHandler(
  args: { emailId: string },
  extra: RequestHandlerExtra<any, any>,
): Promise<CallToolResult> {
  const span = tracer.startSpan("tool:read_email");
  span.setAttribute("mcp.tool", "read_email");
  span.setAttribute("email.id", args.emailId);

  try {
    const { session, bearerToken } = await getSession(extra, span);
    const result = await runJMAPDirect(
      [
        [
          "Email/get",
          {
            ids: [args.emailId],
            properties: [
              "id",
              "threadId",
              "from",
              "to",
              "cc",
              "bcc",
              "replyTo",
              "subject",
              "receivedAt",
              "sentAt",
              "keywords",
              "hasAttachment",
              "htmlBody",
              "textBody",
              "bodyValues",
            ],
            fetchHTMLBodyValues: true,
            fetchTextBodyValues: true,
          },
          "get",
        ],
      ],
      session,
      bearerToken,
      span,
    );

    const getResult = result[0] as [string, { list?: any[] }, string] | undefined;
    const email = getResult?.[1]?.list?.[0];

    if (!email) {
      span.setAttribute("email.found", false);
      span.setAttribute("mcp.outcome", "error");
      span.setAttribute("error.class", "not_found");
      recordEvent(span, "read_email.not_found", { emailId: args.emailId });
      return {
        content: [{ type: "text", text: `Error: Email with ID "${args.emailId}" not found.` }],
        isError: true,
      };
    }

    span.setAttribute("email.found", true);

    const body = formatEmailBody(email);
    const emailData = {
      id: email.id,
      threadId: email.threadId,
      from: email.from,
      to: email.to,
      cc: email.cc,
      bcc: email.bcc,
      replyTo: email.replyTo,
      subject: email.subject,
      receivedAt: email.receivedAt,
      sentAt: email.sentAt,
      keywords: email.keywords,
      hasAttachment: email.hasAttachment,
      htmlBody: body.html,
      textBody: body.text,
      body: body.content,
    };

    const from = email.from?.[0];
    const fromStr = from
      ? from.name
        ? `${from.name} <${from.email}>`
        : from.email
      : "unknown";
    const summary = [
      `Email displayed in widget.`,
      `From: ${fromStr}`,
      `Subject: ${email.subject ?? "(no subject)"}`,
      `Date: ${email.sentAt ?? email.receivedAt ?? "unknown"}`,
      email.hasAttachment ? "Has attachments." : "",
    ]
      .filter(Boolean)
      .join("\n");

    span.setAttribute("mcp.outcome", "success");
    return {
      content: [{ type: "text", text: summary }],
      structuredContent: emailData,
    };
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
    span.setAttribute("mcp.outcome", "error");
    span.setAttribute("error.class", "unknown");
    recordEvent(
      span,
      "read_email.unexpected_error",
      { message: error instanceof Error ? error.message : String(error) },
      { alsoLog: true },
    );
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  } finally {
    span.end();
    await forceFlush();
  }
}
```

Update the top of `src/apps.ts` with the new imports and remove the now-unused `getSession` import duplicate if present.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- apps.trace`
Expected: PASS.

- [ ] **Step 5: Run full check**

Run: `pnpm check`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/apps.ts src/__tests__/apps.trace.test.ts
git commit -m "feat(otel): tool:read_email root span + not_found event"
```

---

## Task 9: `tool:compose_email` root span

**Why:** Minimal instrumentation for parity. `compose_email` has no JMAP calls — it's a UI handoff — so the root span carries only `mcp.tool`, `user.id`, `mcp.prefill_fields`, and `mcp.outcome`.

**Files:**
- Modify: `src/apps.ts` (`composeEmailHandler`)
- Modify: `src/__tests__/apps.trace.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/apps.trace.test.ts`:

```ts
import { composeEmailHandler } from "../apps.js";

describe("tool:compose_email tracing", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.restoreAllMocks();
  });

  it("records mcp.prefill_fields as the provided keys", async () => {
    const { exporter, cleanup: c } = setupInMemoryTracing();
    cleanup = c;

    await composeEmailHandler(
      { to: "x@y.z", subject: "hi" },
      fakeExtra,
    );

    const root = exporter.getFinishedSpans().find((s) => s.name === "tool:compose_email");
    expect(root).toBeDefined();
    expect(root!.attributes["mcp.tool"]).toBe("compose_email");
    expect(root!.attributes["mcp.prefill_fields"]).toEqual(["to", "subject"]);
    expect(root!.attributes["mcp.outcome"]).toBe("success");
    expect(typeof root!.attributes["user.id"]).toBe("string");
  });

  it("records empty prefill_fields when nothing is passed", async () => {
    const { exporter, cleanup: c } = setupInMemoryTracing();
    cleanup = c;

    await composeEmailHandler({}, fakeExtra);

    const root = exporter.getFinishedSpans().find((s) => s.name === "tool:compose_email")!;
    expect(root.attributes["mcp.prefill_fields"]).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- apps.trace`
Expected: FAIL — `tool:compose_email` span does not exist.

- [ ] **Step 3: Instrument `composeEmailHandler`**

Replace `composeEmailHandler` in `src/apps.ts` with:

```ts
import { hashToken } from "./utils.js";

export async function composeEmailHandler(
  args: {
    to?: string;
    cc?: string;
    bcc?: string;
    subject?: string;
    body?: string;
  },
  extra: RequestHandlerExtra<any, any>,
): Promise<CallToolResult> {
  const span = tracer.startSpan("tool:compose_email");
  span.setAttribute("mcp.tool", "compose_email");
  try {
    // Best-effort user.id — do not fail the UI handoff if auth is missing.
    const authHeader =
      extra.requestInfo?.headers?.["authorization"] ||
      extra.requestInfo?.headers?.["Authorization"];
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      span.setAttribute("user.id", hashToken(authHeader.substring(7)));
    }

    const prefill: Record<string, string> = {};
    if (args.to) prefill.to = args.to;
    if (args.cc) prefill.cc = args.cc;
    if (args.bcc) prefill.bcc = args.bcc;
    if (args.subject) prefill.subject = args.subject;
    if (args.body) prefill.body = args.body;

    span.setAttribute("mcp.prefill_fields", Object.keys(prefill));

    const text =
      Object.keys(prefill).length > 0
        ? `Opening compose form with pre-filled fields: ${Object.keys(prefill).join(", ")}`
        : "Opening compose form.";

    span.setAttribute("mcp.outcome", "success");
    return {
      content: [
        { type: "text", text: JSON.stringify(prefill) },
        { type: "text", text },
      ],
      structuredContent: prefill,
    };
  } finally {
    span.end();
    await forceFlush();
  }
}
```

Update the registration in `registerApps` to pass the handler reference (it already accepts `(args, extra)` now):

```ts
registerAppTool(server, "compose_email", { ...toolMetadata }, composeEmailHandler);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- apps.trace`
Expected: PASS.

- [ ] **Step 5: Run full check**

Run: `pnpm check`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/apps.ts src/__tests__/apps.trace.test.ts
git commit -m "feat(otel): tool:compose_email root span with prefill_fields"
```

---

## Task 10: Final verification

**Why:** Confirm the complete instrumentation works end-to-end and there are no lingering typecheck / lint / format / test regressions before the PR.

- [ ] **Step 1: Run the full check suite**

Run: `pnpm check`
Expected: typecheck, lint, fmt:check, and all tests pass.

- [ ] **Step 2: Confirm the three root span types and their expected children are exported in a single test run**

Run: `pnpm test`
Expected: all trace tests pass. The test suite exercises every span in the skeleton:
- `tool:execute` with children `jmap_request` (Task 6), `elicit_input` (Task 7), `fetchSession` (pre-existing).
- `tool:read_email` with children `jmap_request`, `fetchSession`.
- `tool:compose_email` with no children.

- [ ] **Step 3: Manual smoke test against a real Fastmail account (optional, only if `HONEYCOMB_API_KEY` is set locally)**

Run: `pnpm dev`
Action: send one of each tool call (an `execute` with an `Email/query`, a `read_email` on a known ID, a `compose_email` with pre-fill) via an MCP client or curl with `Authorization: Bearer <FASTMAIL_TOKEN>`.
Expected: spans appear in Honeycomb with the documented attributes.

- [ ] **Step 4: Update ADR-001 cross-reference**

Edit `docs/decisions/001-otel-context-propagation.md` and append a short paragraph to "Surface area" referencing the new spans:

```markdown
As of 2026-04-21, tool handlers emit child spans (`jmap_request`,
`elicit_input`) via explicit parent-context passing. `tool:read_email` and
`tool:compose_email` are also root spans, same pattern.
```

Commit:

```bash
git add docs/decisions/001-otel-context-propagation.md
git commit -m "docs: note new child spans in ADR-001"
```

- [ ] **Step 5: Push the branch when ready and open a PR**

```bash
git push -u origin claude/lucid-benz-9d0ce4
gh pr create --title "Granular OTEL instrumentation for MCP tools" --body "$(cat <<'EOF'
## Summary
- Enriches `tool:execute` with pre-validation attributes, `error.class`, and span events for every unhappy path (validation, auth, JMAP HTTP, JMAP response, elicit).
- Adds `jmap_request` child span inside `runJMAPDirect` with full HTTP + JMAP attributes and per-error events on HTTP 200s that contain JMAP-level errors.
- Adds `elicit_input` child span capturing user think-time and elicit outcome.
- Adds `tool:read_email` and `tool:compose_email` root spans (previously untraced).
- Introduces `src/observability.ts::recordEvent` helper used across all call sites.

## Breaking change
- `jmap.methods` OTEL attribute is now `string[]` (was a comma-joined string). Honeycomb queries filtering on it need to switch to array-contains semantics.

## Test plan
- [ ] `pnpm check` passes locally
- [ ] Manual smoke test with real Fastmail account produces expected spans in Honeycomb
- [ ] Validation failure, JMAP 500, JMAP-level error, destructive-decline, and `read_email` not-found all appear as distinct filterable events
EOF
)"
```

---

## Self-review notes

- **Spec coverage:** every section of the spec has a task — attribute schema (Tasks 4 + 6 + 8 + 9), span skeleton (Tasks 6 + 7 + 8 + 9), span events (Tasks 5 + 6 + 8), `recordEvent` helper (Task 3), breaking change on `jmap.methods` (Task 4), `compose_email` extra parameter (Task 9), test strategy using `InMemorySpanExporter` (Task 2). Rollout notes (single PR, no flag) captured in Task 10.
- **Signature consistency:** `runJMAPDirect(methodCalls, session, bearerToken, parentSpan?)` is the signature introduced in Task 6 and used by Task 8's `readEmailHandler`. `executeHandler(args, extra, { elicitInput })` is stable from Task 1 onward. `recordEvent(span, name, attrs, opts?)` is stable from Task 3 onward.
- **Error types:** `ValidationError`, `AuthError`, `JMAPHttpError` — all defined in `src/tools.ts`, all `extends Error`, all preserve original messages so existing validation tests that assert on message substrings still pass.
