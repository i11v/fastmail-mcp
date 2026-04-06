import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import {
  trace,
  context,
  SpanStatusCode,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  type Context,
} from "@opentelemetry/api";
import type { MiddlewareHandler } from "hono";
import { hashToken } from "./utils.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as {
  version: string;
};

const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: "fastmail-mcp",
  [ATTR_SERVICE_VERSION]: pkg.version,
});

const apiKey = process.env.HONEYCOMB_API_KEY;
const honeycombEndpoint = process.env.HONEYCOMB_SERVER ?? "https://api.honeycomb.io";

let spanProcessor: BatchSpanProcessor | undefined;

if (apiKey) {
  const exporter = new OTLPTraceExporter({
    url: `${honeycombEndpoint}/v1/traces`,
    headers: {
      "x-honeycomb-team": apiKey,
    },
  });

  spanProcessor = new BatchSpanProcessor(exporter, {
    exportTimeoutMillis: 5000,
  });

  const sdk = new NodeSDK({
    resource,
    spanProcessors: [spanProcessor],
  });

  sdk.start();

  // Log export errors (e.g. invalid API key) instead of crashing
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
}

const tracer = trace.getTracer("fastmail-mcp");

export { tracer };

export async function forceFlush(): Promise<void> {
  if (!spanProcessor) return;
  try {
    await spanProcessor.forceFlush();
  } catch {
    // Silently ignore flush errors — tracing should never break the server
  }
}

// ---------------------------------------------------------------------------
// OTel context propagation workaround
// ---------------------------------------------------------------------------
// The MCP SDK dispatches tool handlers via a detached Promise.resolve().then()
// chain (Protocol._onrequest), which breaks Node.js AsyncLocalStorage context
// propagation. This means trace.getActiveSpan() and tracer.startSpan() cannot
// find the parent HTTP span inside tool handlers.
//
// Workaround: the tracing middleware injects a nonce into the request headers.
// The MCP transport copies headers into extra.requestInfo.headers, so tool
// handlers can recover the parent OTel context via startToolSpan().
//
// Tracking issue: https://github.com/modelcontextprotocol/typescript-sdk/issues/1264
// See also: docs/decisions/001-otel-context-propagation.md
// ---------------------------------------------------------------------------

const NONCE_HEADER = "x-otel-ctx-nonce";
const activeContexts = new Map<string, Context>();

/**
 * Create a span that is properly parented to the HTTP root span.
 *
 * Call this instead of `tracer.startSpan()` inside MCP tool handlers.
 * Pass `extra.requestInfo?.headers` so the parent context can be recovered.
 *
 * When the MCP SDK gains native OTel support, replace the implementation
 * with a plain `tracer.startSpan(name)` call.
 */
export function startToolSpan(
  name: string,
  headers?: Record<string, string | string[] | undefined>,
) {
  const nonce = headers?.[NONCE_HEADER];
  const parentCtx = typeof nonce === "string" ? activeContexts.get(nonce) : undefined;
  return tracer.startSpan(name, {}, parentCtx ?? context.active());
}

export function tracingMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    // Extract user.id from bearer token on the root span
    const auth = c.req.header("authorization");
    const userId = auth?.startsWith("Bearer ") ? hashToken(auth.substring(7)) : undefined;

    const span = tracer.startSpan(`${c.req.method} ${c.req.routePath}`, {
      attributes: {
        "http.request.method": c.req.method,
        "http.route": c.req.routePath,
        "url.full": c.req.url,
        "user.id": userId,
      },
    });

    const ctx = trace.setSpan(context.active(), span);

    // Inject nonce so tool handlers can recover this context (see startToolSpan)
    const nonce = crypto.randomUUID();
    c.req.raw.headers.set(NONCE_HEADER, nonce);
    activeContexts.set(nonce, ctx);

    try {
      await context.with(ctx, () => next());
      span.setAttribute("http.response.status_code", c.res.status);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (err as Error).message,
      });
      throw err;
    } finally {
      activeContexts.delete(nonce);
      span.end();
      if (process.env.VERCEL) {
        await forceFlush();
      }
    }
  };
}
