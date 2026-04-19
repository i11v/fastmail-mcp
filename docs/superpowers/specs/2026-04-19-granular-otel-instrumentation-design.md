# Granular OTEL Instrumentation for MCP Tools

**Status:** Draft
**Date:** 2026-04-19
**Related:** [ADR-001 OpenTelemetry Tracing in MCP Tool Handlers](../../decisions/001-otel-context-propagation.md)

## Goal

Today, a single `tool:execute` span with a handful of attributes is the only
signal we get per call. We cannot tell how long Fastmail takes, which method
in a batch failed, whether a 200 response contained JMAP-level errors, or what
happened on unhappy paths like validation failures or declined elicitations.
`tool:read_email` and `tool:compose_email` are not instrumented at all.

Produce a trace per MCP tool call that captures the full picture: network
latency to Fastmail, user elicitation timing, JMAP-level errors hiding inside
HTTP 200s, and every unhappy-path outcome — all queryable in Honeycomb.

## Scope

**In scope**
- Enrich `tool:execute` with full attribute coverage and pre-validation labels.
- Add child spans `jmap_request` (HTTP POST to Fastmail) and `elicit_input`
  (destructive-action gate).
- Instrument `tool:read_email` and `tool:compose_email` as root spans matching
  the `execute` pattern.
- Add span events for every known unhappy path so they are queryable.
- Single `console.error` in the outer `catch` for truly unexpected errors
  (belt-and-suspenders against OTEL flush loss on crash paths).

**Out of scope**
- A parallel `console.log` / structured-logging system. OTEL span events serve
  as the structured log. Cloudflare Workers Logs of unexpected errors via the
  single `console.error` above is the only deliberate non-OTEL sink.
- Logging or attaching raw JMAP argument bodies. We record shapes (method
  names, counts, indices), not values — `Email/set.create` drafts can contain
  user content.
- Changing the root-span model from [ADR-001](../../decisions/001-otel-context-propagation.md).
  Tool handlers remain the root; new child spans use explicit context
  propagation via `trace.setSpan(context.active(), parentSpan)`.

## Span skeleton

```
tool:execute (root, existing — enriched)
├── fetchSession (existing, unchanged)
├── elicit_input (NEW, only when destructive gate fires)
└── jmap_request (NEW, wraps the POST in runJMAPDirect)

tool:read_email (NEW, root)
├── fetchSession
└── jmap_request

tool:compose_email (NEW, root — no children, UI handoff only)
```

`jmap_request` wraps the POST inside `runJMAPDirect`, so a single
instrumentation site covers both `execute` and `read_email`. Validation,
safety classification, response cleaning, and account-ID injection remain
span-less — they are sub-millisecond CPU work and their outcomes are
captured as attributes/events on the parent.

Child spans must receive the parent context explicitly. `runJMAPDirect`
currently takes `session` and `bearerToken`; it gains an optional
`parentSpan?: Span` parameter (same pattern as `getSession`).

## Attribute schema

### `tool:execute`

Set **before** validation runs (from raw `args.methodCalls`) so a validation
failure still produces a shaped, filterable span:

- `mcp.tool` = `"execute"`
- `jmap.method_count` — derived from `args.methodCalls.length` before validation
- `jmap.methods` — **`string[]`**, derived from `args.methodCalls.map(c => c[0])`
  before validation, with non-string entries coerced to `"<invalid>"`

Set after validation passes:
- `jmap.safety` — `read | write | destructive`
- `mcp.confirmed` (bool) — whether `confirmed: true` was passed

Set on completion:
- `user.id` (hashed, existing)
- `mcp.outcome` — `success | error | cancelled | awaiting_confirmation`
- `jmap.error_count` — count of method responses shaped `["error", ...]`
- `error.class` (only on failure) — `validation | auth | session | jmap_http | jmap_response | elicitation | unknown`

### `jmap_request`

- `http.request.method` = `"POST"`
- `server.address` — host of `session.apiUrl`
- `url.path` — path of `session.apiUrl`
- `http.request.body.size` — bytes of serialized request
- `http.response.status_code`
- `http.response.body.size` — byte length of the response body. Implementation
  reads the body once as text (`await response.text()`) to capture size, then
  `JSON.parse`s it; this replaces the current `response.json()` call so we do
  not consume the body twice.
- `jmap.method_count`
- `jmap.methods` (`string[]`)
- `jmap.error_count`

### `elicit_input`

- `mcp.elicit.supported` (bool) — `false` if the SDK call threw and we fell
  back to the two-step confirmation path
- `mcp.elicit.action` — `accept | decline | cancel` (only when supported)
- `mcp.elicit.confirmed` (bool) — only when supported

### `tool:read_email`

- `mcp.tool` = `"read_email"`
- `user.id`
- `email.id` — from `args.emailId`
- `email.found` (bool)
- `mcp.outcome` — `success | error`
- `error.class` (on failure)

### `tool:compose_email`

- `mcp.tool` = `"compose_email"`
- `user.id`
- `mcp.prefill_fields` (`string[]`) — which of `to | cc | bcc | subject | body` were passed
- `mcp.outcome` — `success | error`

## Span events (unhappy paths)

Recorded via `span.addEvent(name, attributes)`. Names use dot notation scoped
by tool so they group cleanly in Honeycomb.

On `tool:execute`:
- `execute.validation_failed` — `{ stage: "structure" | "references" | "hygiene", index: number, method?: string, message: string }`
- `execute.auth_missing` — `{ reason: "no_header" | "malformed" }`
- `execute.elicit_declined` — `{ action: "decline" | "cancel" }`
- `execute.elicit_unsupported` — `{}` — fires on the two-step fallback path;
  useful for tracking clients without elicitation support

On `jmap_request`:
- `jmap.response_error` — one event per JMAP-level error in the response:
  `{ method: string, callId: string, type?: string, description?: string }`
  (`type` and `description` pulled from the error object when present)
- `jmap.http_error` — `{ status: number, body_preview: string }` where
  `body_preview` is the first 500 bytes of the response body for debugging

On `fetchSession`:
- `session.fetch_failed` — `{ status: number }`

On `tool:read_email`:
- `read_email.not_found` — `{ emailId: string }`

## Module structure

New file `src/observability.ts` with a thin helper that wraps the
`addEvent` + log-on-truly-unexpected pattern so call sites stay clean:

```ts
// Fire-and-forget: adds a span event with attributes.
// For the single unexpected-error path, callers pass `alsoLog: true`
// to additionally console.error a structured line as OTEL-flush insurance.
export function recordEvent(
  span: Span,
  name: string,
  attrs: Record<string, AttributeValue>,
  opts?: { alsoLog?: boolean },
): void;
```

- `src/tracing.ts` — unchanged (SDK setup, `tracer`, `forceFlush`).
- `src/observability.ts` — new; exports `recordEvent`.
- `src/tools.ts` — enriches `tool:execute`, adds `jmap_request` span inside
  `runJMAPDirect`, adds `elicit_input` span in the destructive-action branch,
  replaces ad-hoc `span.setAttribute` calls on error with `recordEvent`.
  `runJMAPDirect` gains `parentSpan?: Span`.
- `src/apps.ts` — wraps `read_email` and `compose_email` handlers with root
  spans; `compose_email` handler signature gains `extra` to read the bearer
  token for `user.id`.

## Breaking changes

1. **`jmap.methods` attribute type.** Changes from a comma-joined string to a
   `string[]`. Any Honeycomb query, board, or trigger that filters on
   `jmap.methods` as a string needs to be updated to use the array form (e.g.
   `CONTAINS`). This is a one-time migration — document in the PR description.

2. **`compose_email` handler signature.** Currently takes only `args`; gains
   `extra` so it can extract the bearer token for `user.id`. Purely additive
   for the MCP SDK, which always provides `extra`.

## Testing

Vitest coverage mirrors the existing test style in the repo:
- Unit-test `recordEvent` adds the event with the right shape.
- Integration-test each tool handler with a mocked `fetch` to assert:
  - Pre-validation attributes (`jmap.methods` as array, `jmap.method_count`)
    are set on the span even when validation throws.
  - `jmap_request` span is created with the documented attributes on
    success.
  - `jmap.response_error` events are emitted when JMAP returns errors inside
    a 200.
  - `elicit_input` span fires only on the destructive path; `mcp.outcome`
    reflects `cancelled | awaiting_confirmation | success` correctly.
  - `tool:read_email` sets `email.found = false` and emits
    `read_email.not_found` for unknown IDs.

Tests should use the in-memory span exporter (`InMemorySpanExporter` from
`@opentelemetry/sdk-trace-base`) rather than asserting on Honeycomb output.

## Non-goals / deferred

- **No env-gated raw-input dumping.** If debugging needs raw JMAP args later,
  add a `DEBUG_TRACE_INPUTS=1` gate; do not include it in this change.
- **No metrics.** Spans only. Metrics can be derived in Honeycomb from the
  attributes we emit.
- **No propagation across tools in one HTTP request.** Per ADR-001, each tool
  call is a separate trace root. Revisit when the MCP SDK fixes async context.

## Rollout

Single PR. No feature flag — instrumentation is additive except for the one
documented breaking attribute type change, which only affects internal
Honeycomb queries.
