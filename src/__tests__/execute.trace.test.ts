import { describe, it, expect, afterEach, vi } from "vitest";
import { setupInMemoryTracing } from "./helpers/otel.js";
import { executeHandler } from "../tools.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";

const fakeExtra = {
  requestInfo: { headers: { authorization: "Bearer test-token" } },
} as unknown as RequestHandlerExtra<any, any>;

const noopElicit = vi.fn().mockResolvedValue({ action: "accept", content: { confirmed: true } });

describe("tool:execute — pre-validation labels", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sets jmap.method_count and jmap.methods[] even when validation fails", async () => {
    const exporter = setupInMemoryTracing();

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
    const exporter = setupInMemoryTracing();

    await executeHandler(
      {
        // @ts-expect-error — testing defensive labeling against malformed input
        methodCalls: [[42, {}, "call-0"]],
      },
      fakeExtra,
      { elicitInput: noopElicit },
    );

    const root = exporter.getFinishedSpans().find((s) => s.name === "tool:execute");
    expect(root).toBeDefined();
    expect(root!.attributes["jmap.methods"]).toEqual(["<unknown>"]);
  });
});

describe("tool:execute — unhappy-path span events", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("emits execute.validation_failed with stage=hygiene when /query lacks limit", async () => {
    const exporter = setupInMemoryTracing();

    await executeHandler(
      {
        methodCalls: [["Email/query", {}, "call-0"]], // hygiene fails: no limit
      },
      fakeExtra,
      { elicitInput: noopElicit },
    );

    const root = exporter.getFinishedSpans().find((s) => s.name === "tool:execute");
    expect(root).toBeDefined();

    const event = root!.events.find((e) => e.name === "execute.validation_failed");
    expect(event).toBeDefined();
    expect(event!.attributes).toMatchObject({
      stage: "hygiene",
      index: 0,
      method: "Email/query",
    });
    expect(root!.attributes["error.class"]).toBe("validation");
    expect(root!.attributes["mcp.outcome"]).toBe("error");
  });

  it("emits execute.auth_missing when Authorization header is absent", async () => {
    const exporter = setupInMemoryTracing();
    vi.stubGlobal("fetch", vi.fn());

    const extraNoAuth = {
      requestInfo: { headers: {} },
    } as unknown as RequestHandlerExtra<any, any>;

    await executeHandler(
      {
        methodCalls: [["Email/get", { ids: ["x"], properties: ["subject"] }, "call-0"]],
      },
      extraNoAuth,
      { elicitInput: noopElicit },
    );

    const root = exporter.getFinishedSpans().find((s) => s.name === "tool:execute");
    expect(root).toBeDefined();

    const event = root!.events.find((e) => e.name === "execute.auth_missing");
    expect(event).toBeDefined();
    expect(event!.attributes).toMatchObject({ reason: "no_header" });
    expect(root!.attributes["error.class"]).toBe("auth");
  });
});

describe("jmap_request span", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mockFetch(sessionBody: object, jmapResponse: object | string, jmapStatus = 200) {
    const body = typeof jmapResponse === "string" ? jmapResponse : JSON.stringify(jmapResponse);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/jmap/session")) {
          return new Response(JSON.stringify(sessionBody), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(body, {
          status: jmapStatus,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
  }

  const session = {
    apiUrl: "https://api.fastmail.com/jmap/api",
    uploadUrl: "https://api.fastmail.com/upload",
    primaryAccounts: { "urn:ietf:params:jmap:mail": "acct-1" },
  };

  it("creates a jmap_request child span with HTTP + JMAP attributes on success", async () => {
    const exporter = setupInMemoryTracing();
    mockFetch(session, { methodResponses: [["Email/get", { list: [] }, "call-0"]] });

    await executeHandler(
      { methodCalls: [["Email/get", { ids: ["x"], properties: ["subject"] }, "call-0"]] },
      fakeExtra,
      { elicitInput: noopElicit },
    );

    const jmap = exporter.getFinishedSpans().find((s) => s.name === "jmap_request");
    expect(jmap).toBeDefined();
    expect(jmap!.attributes["http.request.method"]).toBe("POST");
    expect(jmap!.attributes["http.response.status_code"]).toBe(200);
    expect(jmap!.attributes["server.address"]).toBe("api.fastmail.com");
    expect(jmap!.attributes["url.path"]).toBe("/jmap/api");
    expect(jmap!.attributes["jmap.methods"]).toEqual(["Email/get"]);
    expect(jmap!.attributes["jmap.error_count"]).toBe(0);
    expect(typeof jmap!.attributes["http.request.body.size"]).toBe("number");
    expect(typeof jmap!.attributes["http.response.body.size"]).toBe("number");
  });

  it("emits one jmap.response_error event per JMAP-level error in a 200 response", async () => {
    const exporter = setupInMemoryTracing();
    mockFetch(session, {
      methodResponses: [
        ["error", { type: "invalidArguments", description: "bad id" }, "call-0"],
        ["Email/get", { list: [] }, "call-1"],
      ],
    });

    await executeHandler(
      {
        methodCalls: [
          ["Email/get", { ids: ["x"], properties: ["subject"] }, "call-0"],
          ["Email/get", { ids: ["y"], properties: ["subject"] }, "call-1"],
        ],
      },
      fakeExtra,
      { elicitInput: noopElicit },
    );

    const jmap = exporter.getFinishedSpans().find((s) => s.name === "jmap_request")!;
    expect(jmap.attributes["jmap.error_count"]).toBe(1);
    const errorEvents = jmap.events.filter((e) => e.name === "jmap.response_error");
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].attributes).toMatchObject({
      method: "error",
      callId: "call-0",
      type: "invalidArguments",
      description: "bad id",
    });

    const root = exporter.getFinishedSpans().find((s) => s.name === "tool:execute")!;
    expect(root.attributes["jmap.error_count"]).toBe(1);
  });

  it("emits jmap.http_error and error.class=jmap_http on non-200", async () => {
    const exporter = setupInMemoryTracing();
    mockFetch(session, "internal error", 500);

    await executeHandler(
      { methodCalls: [["Email/get", { ids: ["x"], properties: ["subject"] }, "call-0"]] },
      fakeExtra,
      { elicitInput: noopElicit },
    );

    const jmap = exporter.getFinishedSpans().find((s) => s.name === "jmap_request")!;
    expect(jmap.attributes["http.response.status_code"]).toBe(500);
    const evt = jmap.events.find((e) => e.name === "jmap.http_error");
    expect(evt).toBeDefined();
    expect(evt!.attributes).toMatchObject({ status: 500 });
    expect((evt!.attributes.body_preview as string).length).toBeLessThanOrEqual(500);

    const root = exporter.getFinishedSpans().find((s) => s.name === "tool:execute")!;
    expect(root.attributes["error.class"]).toBe("jmap_http");
  });
});
