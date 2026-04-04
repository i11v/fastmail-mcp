import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { trace, context, SpanStatusCode } from "@opentelemetry/api";
import type { MiddlewareHandler } from "hono";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as {
  version: string;
};

const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: "fastmail-mcp",
  [ATTR_SERVICE_VERSION]: pkg.version,
});

const apiKey = process.env.HONEYCOMB_API_KEY;

let spanProcessor: BatchSpanProcessor | undefined;

if (apiKey) {
  const exporter = new OTLPTraceExporter({
    url: "https://api.honeycomb.io/v1/traces",
    headers: {
      "x-honeycomb-team": apiKey,
    },
  });

  spanProcessor = new BatchSpanProcessor(exporter);

  const sdk = new NodeSDK({
    resource,
    spanProcessors: [spanProcessor],
  });

  sdk.start();
}

const tracer = trace.getTracer("fastmail-mcp");

export { tracer };

export function forceFlush(): Promise<void> {
  if (!spanProcessor) return Promise.resolve();
  return spanProcessor.forceFlush();
}

export function tracingMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const span = tracer.startSpan(`${c.req.method} ${c.req.routePath}`, {
      attributes: {
        "http.request.method": c.req.method,
        "http.route": c.req.routePath,
        "url.full": c.req.url,
      },
    });

    const ctx = trace.setSpan(context.active(), span);

    try {
      await context.with(ctx, () => next());
      span.setAttribute("http.response.status_code", c.res.status);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
      if (process.env.VERCEL) {
        await forceFlush();
      }
    }
  };
}
