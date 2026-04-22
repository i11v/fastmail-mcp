# ADR-001: OpenTelemetry Tracing in MCP Tool Handlers

**Status:** Accepted
**Date:** 2026-04-06

## Context

We use OpenTelemetry to trace requests through the Fastmail MCP server, sending
spans to Honeycomb.

The MCP TypeScript SDK (v1.x) has two behaviors that prevent standard
middleware-based tracing:

1. **Broken async context.** `Protocol._onrequest` dispatches tool handlers via
   a detached `Promise.resolve().then()` chain, which breaks Node.js
   `AsyncLocalStorage` context propagation. `trace.getActiveSpan()` returns
   `undefined` inside tool handlers, so child spans cannot find a parent.

2. **SSE response timing.** The `@hono/mcp` `StreamableHTTPTransport` returns
   an SSE streaming response without awaiting the tool handler callback
   (`streamSSE`'s `run()` is not awaited). Hono middleware completes — including
   cleanup and `span.end()` — before the tool handler even starts. This makes
   middleware-scoped spans have wrong durations and breaks any context-passing
   mechanism that relies on middleware cleanup (nonces, maps, etc.).

There is no built-in OTel support in the MCP SDK. Native support is tracked in
[modelcontextprotocol/typescript-sdk#1264][issue-1264] (P2, v2 milestone).

## Decision

Each tool handler creates and owns its own **root span**. There is no HTTP
middleware span and no parent-child relationship to maintain.

- Tool handlers call `tracer.startSpan()` at the start and `span.end()` in
  their `finally` block.
- `user.id` is set on the tool span via `getSession()`, which hashes the bearer
  token.
- On Vercel, each tool handler calls `forceFlush()` in its `finally` block to
  ensure spans are exported before the function freezes.
- `NodeSDK` is initialized with `instrumentations: []` to prevent
  auto-instrumented HTTP spans from duplicating our manual spans.

### Surface area

- `src/tracing.ts` — SDK setup, `getTracer()` and `forceFlush` exports
- `src/tools.ts` — `tool:execute` root span; `runJMAPDirect` wraps JMAP POSTs
  in `jmap_request` child spans; `executeHandler` creates `elicit_input` child
  spans around the destructive-action gate
- `src/apps.ts` — `tool:read_email` and `tool:compose_email` root spans
- `src/observability.ts` — `recordEvent()` helper for span events (used for
  structured logs like `execute.validation_failed`, `jmap.http_error`,
  `read_email.not_found`, and the `alsoLog: true` `*.unexpected_error`
  variants)

As of 2026-04-21, tool handlers emit child spans (`jmap_request`,
`elicit_input`, `fetchSession`) via explicit parent-context passing —
`parentCtx = trace.setSpan(context.active(), parentSpan)` threaded through
`tracer.startActiveSpan(name, {}, parentCtx, cb)`. The detached Promise chain
still breaks implicit context propagation, so the parent span is passed as an
argument through function signatures (`runJMAPDirect(..., parentSpan?)`,
`getSession(extra, parentSpan?)`).

## Consequences

**Positive:**
- Correct span timing — each span covers exactly the tool's execution.
- `user.id` and all MCP attributes appear on every span.
- No race conditions or cleanup timing issues.
- Simple — no middleware, no context maps, no nonces.

**Negative:**
- No cross-tool trace structure — each tool invocation is a separate root
  span. Multiple tools called in one HTTP request appear as separate traces
  in Honeycomb rather than a single tree. (Within a single tool invocation,
  child spans DO parent correctly via explicit-context passing — see Surface
  area above.)
- No HTTP-level span (method, route, status code). In practice this is always
  `POST /mcp 200` so the information loss is minimal.
- Every child-span call site must explicitly thread the parent span through
  function signatures. Forgetting to do so silently produces an orphaned
  span (no parent link). Mitigated by the pattern being concentrated in a
  handful of helpers (`runJMAPDirect`, `getSession`, the destructive-gate
  block in `executeHandler`) and exercised by in-memory-exporter tests that
  assert `parentSpanContext?.spanId` equals the root's `spanId`.

## When to Revisit

Replace this approach when either:

1. The MCP SDK ships native OTel support ([#1264][issue-1264]).
2. The `Promise.resolve().then()` in `Protocol._onrequest` is replaced with
   context-preserving async dispatch, AND the transport awaits the handler
   before returning the response.

At that point, a standard middleware span can parent tool spans via automatic
context propagation.

[issue-1264]: https://github.com/modelcontextprotocol/typescript-sdk/issues/1264
