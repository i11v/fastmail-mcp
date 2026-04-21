import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";
import { tracer as toolsTracer } from "../../tracing.js";

export function setupInMemoryTracing(): {
  exporter: InMemorySpanExporter;
  cleanup: () => void;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  // Two OTEL quirks make per-test swaps tricky:
  //
  // 1. `trace.setGlobalTracerProvider(...)` no-ops on subsequent calls
  //    (it fails duplicate-registration and leaves the previous delegate
  //    in place). So we reach into the internal ProxyTracerProvider and
  //    call `setDelegate` directly.
  //
  // 2. Consumer modules (e.g. src/tracing.ts) export a top-level `tracer`
  //    captured via `trace.getTracer(...)` at module load. That's a
  //    ProxyTracer which caches its delegate on first use and never
  //    refreshes. We clear its private `_delegate` so the next
  //    `startSpan` call re-resolves from the new provider.
  const internalProxyProvider = (
    trace as unknown as {
      _proxyTracerProvider: { setDelegate: (p: unknown) => void };
    }
  )._proxyTracerProvider;
  internalProxyProvider.setDelegate(provider);
  trace.setGlobalTracerProvider(provider); // first-call path (otherwise no-op)

  const cachedProxy = toolsTracer as unknown as { _delegate?: unknown };
  if ("_delegate" in cachedProxy) {
    cachedProxy._delegate = undefined;
  }

  return {
    exporter,
    cleanup: () => {
      exporter.reset();
    },
  };
}
