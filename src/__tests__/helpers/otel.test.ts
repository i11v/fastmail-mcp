import { describe, it, expect, afterEach } from "vitest";
import { trace } from "@opentelemetry/api";
import { setupInMemoryTracing } from "./otel.js";

describe("setupInMemoryTracing", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("captures spans created after setup", () => {
    const { exporter, cleanup: c } = setupInMemoryTracing();
    cleanup = c;

    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("unit");
    span.setAttribute("kind", "probe");
    span.end();

    const finished = exporter.getFinishedSpans();
    expect(finished).toHaveLength(1);
    expect(finished[0].name).toBe("unit");
    expect(finished[0].attributes.kind).toBe("probe");
  });
});
