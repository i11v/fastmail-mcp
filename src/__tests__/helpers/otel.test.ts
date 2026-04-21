import { describe, it, expect } from "vitest";
import { trace } from "@opentelemetry/api";
import { setupInMemoryTracing } from "./otel.js";

describe("setupInMemoryTracing", () => {
  it("captures spans created after setup", () => {
    const exporter = setupInMemoryTracing();

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
