import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { trace, diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";

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
    // Disable default auto-instrumentations — we create spans manually in
    // tool handlers. Auto-instrumented HTTP spans would duplicate our spans
    // without the MCP-specific attributes (user.id, mcp.tool, etc.).
    instrumentations: [],
  });

  sdk.start();

  // Log export errors (e.g. invalid API key) instead of crashing
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
}

export const tracer = trace.getTracer("fastmail-mcp");

// ---------------------------------------------------------------------------
// Why tool handlers own their spans (not middleware)
// ---------------------------------------------------------------------------
// The MCP SDK dispatches tool handlers via a detached Promise.resolve().then()
// chain (Protocol._onrequest), and the @hono/mcp transport returns an SSE
// response without awaiting the handler callback. This means:
//
// 1. AsyncLocalStorage context is lost — tracer.startSpan() in tool handlers
//    cannot find a parent span from middleware.
// 2. Middleware runs to completion (including cleanup) BEFORE the tool handler
//    even starts — so middleware-scoped spans have wrong timing and any
//    context-passing mechanism (nonces, maps) gets cleaned up too early.
//
// Each tool handler creates its own root span and calls forceFlush() in its
// finally block to ensure export on serverless (Vercel).
//
// Tracking: https://github.com/modelcontextprotocol/typescript-sdk/issues/1264
// See also: docs/decisions/001-otel-context-propagation.md
// ---------------------------------------------------------------------------

export async function forceFlush(): Promise<void> {
  if (!spanProcessor) return;
  try {
    await spanProcessor.forceFlush();
  } catch {
    // Silently ignore flush errors — tracing should never break the server
  }
}
