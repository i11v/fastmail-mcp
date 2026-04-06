# ADR-001: OpenTelemetry Context Propagation in MCP Tool Handlers

**Status:** Accepted
**Date:** 2026-04-06

## Context

We use OpenTelemetry to trace requests through the Fastmail MCP server. The
tracing middleware creates a root HTTP span, and each tool handler creates a
child span for the tool invocation.

The MCP TypeScript SDK (v1.x) dispatches tool handlers via a detached
`Promise.resolve().then()` chain in `Protocol._onrequest`. This breaks Node.js
`AsyncLocalStorage` context propagation, which the OpenTelemetry JS SDK relies
on. As a result:

- `trace.getActiveSpan()` returns `undefined` inside tool handlers.
- `tracer.startSpan()` creates orphaned root spans instead of children of the
  HTTP request span.
- Traces in Honeycomb appear as disconnected events rather than a single
  request tree.

There is no built-in OTel support in the MCP SDK today. Native support is
tracked in [modelcontextprotocol/typescript-sdk#1264][issue-1264] (P2, v2
milestone, no active PR). The `Promise.resolve().then()` pattern persists on
both the `v1.x` branch and `main` as of 2026-04-06.

## Decision

We work around the broken context propagation by passing the OTel `Context`
through a per-request nonce injected into HTTP request headers.

### How it works

1. The tracing middleware generates a random nonce and stores the active OTel
   `Context` in an in-memory `Map<string, Context>`.
2. The nonce is injected into the raw request headers (`x-otel-ctx-nonce`).
3. The `@hono/mcp` `StreamableHTTPTransport` copies all request headers into
   `extra.requestInfo.headers` when dispatching to tool handlers.
4. Tool handlers call `startToolSpan(name, extra.requestInfo?.headers)` which
   looks up the parent context via the nonce and creates a properly-parented
   span.
5. The middleware cleans up the nonce entry in its `finally` block.

### Surface area

- `src/tracing.ts` -- `startToolSpan()`, nonce storage, middleware changes
- `src/tools.ts` -- tool handlers call `startToolSpan()` instead of
  `tracer.startSpan()`

## Consequences

**Positive:**
- Tool spans are proper children of the HTTP root span in Honeycomb.
- `user.id` appears on the root HTTP span (extracted in the middleware).
- The workaround is contained in `startToolSpan()` -- tool handlers don't need
  to know about the nonce mechanism.

**Negative:**
- Relies on the `@hono/mcp` transport forwarding all request headers to
  `extra.requestInfo.headers`. If the transport changes this behavior, the
  workaround breaks silently (spans become orphaned again, no errors).
- Small in-memory map of active contexts. Cleaned up per-request, so only a
  concern under extreme concurrency.

## When to Remove

Replace this workaround when either:

1. The MCP SDK ships native OTel support ([#1264][issue-1264]).
2. The `Promise.resolve().then()` pattern in `Protocol._onrequest` is replaced
   with context-preserving async dispatch.

At that point, `startToolSpan()` can be replaced with a plain
`tracer.startSpan(name)` call and the nonce machinery removed.

[issue-1264]: https://github.com/modelcontextprotocol/typescript-sdk/issues/1264
