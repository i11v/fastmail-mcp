import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { trace, diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";

const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: "fastmail-mcp",
  [ATTR_SERVICE_VERSION]: "0.5.0",
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

  const provider = new BasicTracerProvider({
    resource,
    spanProcessors: [spanProcessor],
  });

  // Register as the global tracer provider
  trace.setGlobalTracerProvider(provider);

  // Log export errors (e.g. invalid API key) instead of crashing
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
}

export const tracer = trace.getTracer("fastmail-mcp");

export async function forceFlush(): Promise<void> {
  if (!spanProcessor) return;
  try {
    await spanProcessor.forceFlush();
  } catch {
    // Silently ignore flush errors — tracing should never break the server
  }
}
