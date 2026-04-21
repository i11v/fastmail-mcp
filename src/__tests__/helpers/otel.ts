import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";

// `trace.setGlobalTracerProvider` can only register once per process — the 2nd
// call fails duplicate-registration and silently no-ops. We therefore install
// ONE provider per process and reset the exporter between tests rather than
// swapping providers. This keeps us on public OTEL API (no reaching into
// `_proxyTracerProvider` or `_delegate`).
let singleton: { exporter: InMemorySpanExporter } | undefined;

export function setupInMemoryTracing(): {
  exporter: InMemorySpanExporter;
  cleanup: () => void;
} {
  if (!singleton) {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
    singleton = { exporter };
  }
  const { exporter } = singleton;
  exporter.reset();
  return {
    exporter,
    cleanup: () => {
      exporter.reset();
    },
  };
}
