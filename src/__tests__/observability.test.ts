import { describe, it, expect, afterEach, vi } from "vitest";
import { trace } from "@opentelemetry/api";
import { setupInMemoryTracing } from "./helpers/otel.js";
import { recordEvent } from "../observability.js";

describe("recordEvent", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.restoreAllMocks();
  });

  it("adds a span event with attributes", () => {
    const { exporter, cleanup: c } = setupInMemoryTracing();
    cleanup = c;

    const span = trace.getTracer("test").startSpan("parent");
    recordEvent(span, "test.event", { key: "value", count: 3 });
    span.end();

    const finished = exporter.getFinishedSpans();
    expect(finished).toHaveLength(1);
    expect(finished[0].events).toHaveLength(1);
    expect(finished[0].events[0].name).toBe("test.event");
    expect(finished[0].events[0].attributes).toEqual({ key: "value", count: 3 });
  });

  it("does not log to console by default", () => {
    const { cleanup: c } = setupInMemoryTracing();
    cleanup = c;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const span = trace.getTracer("test").startSpan("parent");
    recordEvent(span, "test.event", { key: "value" });
    span.end();

    expect(errSpy).not.toHaveBeenCalled();
  });

  it("also console.errors a structured line when alsoLog is true", () => {
    const { cleanup: c } = setupInMemoryTracing();
    cleanup = c;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const span = trace.getTracer("test").startSpan("parent");
    recordEvent(span, "test.unexpected", { message: "boom" }, { alsoLog: true });
    span.end();

    expect(errSpy).toHaveBeenCalledTimes(1);
    const payload = errSpy.mock.calls[0][0];
    expect(payload).toMatchObject({ event: "test.unexpected", message: "boom" });
  });
});
