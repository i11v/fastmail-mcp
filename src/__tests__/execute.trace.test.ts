import { describe, it, expect, afterEach, vi } from "vitest";
import { setupInMemoryTracing } from "./helpers/otel.js";
import { executeHandler } from "../tools.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";

const fakeExtra = {
  requestInfo: { headers: { authorization: "Bearer test-token" } },
} as unknown as RequestHandlerExtra<any, any>;

const noopElicit = vi.fn().mockResolvedValue({ action: "accept", content: { confirmed: true } });

describe("tool:execute — pre-validation labels", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.restoreAllMocks();
  });

  it("sets jmap.method_count and jmap.methods[] even when validation fails", async () => {
    const { exporter, cleanup: c } = setupInMemoryTracing();
    cleanup = c;

    await executeHandler(
      {
        methodCalls: [
          ["Email/query", {}, "call-0"], // fails hygiene: no limit
          ["Email/get", { ids: ["x"], properties: ["subject"] }, "call-1"],
        ],
      },
      fakeExtra,
      { elicitInput: noopElicit },
    );

    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === "tool:execute");
    expect(root).toBeDefined();
    expect(root!.attributes["jmap.method_count"]).toBe(2);
    expect(root!.attributes["jmap.methods"]).toEqual(["Email/query", "Email/get"]);
  });

  it("records jmap.methods[] as array of strings even for non-string entries", async () => {
    const { exporter, cleanup: c } = setupInMemoryTracing();
    cleanup = c;

    await executeHandler(
      {
        // @ts-expect-error — testing defensive labeling against malformed input
        methodCalls: [[42, {}, "call-0"]],
      },
      fakeExtra,
      { elicitInput: noopElicit },
    );

    const root = exporter.getFinishedSpans().find((s) => s.name === "tool:execute")!;
    expect(root.attributes["jmap.methods"]).toEqual(["<invalid>"]);
  });
});
