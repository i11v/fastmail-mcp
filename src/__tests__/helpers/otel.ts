import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";

// `trace.setGlobalTracerProvider` can only register once per process — the 2nd
// call fails duplicate-registration and silently no-ops. We therefore install
// ONE provider per process and reset the exporter on each call rather than
// swapping providers. This keeps us on public OTEL API (no reaching into
// `_proxyTracerProvider` or `_delegate`).
//
// Test isolation: call this at the top of each test. The exporter is reset on
// every call, so there is no separate cleanup step. This assumes vitest's
// default worker model (one worker per file, sequential tests within a file).
// If we ever run tests concurrently within a file, revisit — two tests would
// share the same exporter and race on reset.
let singleton: { exporter: InMemorySpanExporter } | undefined;

export function setupInMemoryTracing(): InMemorySpanExporter {
  if (!singleton) {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
    singleton = { exporter };
  }
  singleton.exporter.reset();
  return singleton.exporter;
}
