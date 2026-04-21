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
