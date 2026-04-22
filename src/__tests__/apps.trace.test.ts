import { describe, it, expect, afterEach, vi } from "vitest";
import { setupInMemoryTracing } from "./helpers/otel.js";
import { readEmailHandler, composeEmailHandler } from "../apps.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";

const fakeExtra = {
  requestInfo: { headers: { authorization: "Bearer test-token" } },
} as unknown as RequestHandlerExtra<any, any>;

function stubFetch(emailList: object[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/jmap/session")) {
        return new Response(
          JSON.stringify({
            apiUrl: "https://api.fastmail.com/jmap/api",
            uploadUrl: "https://api.fastmail.com/upload",
            primaryAccounts: { "urn:ietf:params:jmap:mail": "acct-1" },
          }),
        );
      }
      return new Response(
        JSON.stringify({ methodResponses: [["Email/get", { list: emailList }, "get"]] }),
      );
    }),
  );
}

describe("tool:read_email tracing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates a tool:read_email root span with email.found=true on success", async () => {
    const exporter = setupInMemoryTracing();
    stubFetch([{ id: "m1", subject: "hi" }]);

    await readEmailHandler({ emailId: "m1" }, fakeExtra);

    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === "tool:read_email");
    expect(root).toBeDefined();
    expect(root!.attributes["mcp.tool"]).toBe("read_email");
    expect(root!.attributes["email.id"]).toBe("m1");
    expect(root!.attributes["email.found"]).toBe(true);
    expect(root!.attributes["mcp.outcome"]).toBe("success");
    expect(typeof root!.attributes["user.id"]).toBe("string");
  });

  it("emits read_email.not_found event when the email ID is unknown", async () => {
    const exporter = setupInMemoryTracing();
    stubFetch([]);

    await readEmailHandler({ emailId: "missing" }, fakeExtra);

    const root = exporter.getFinishedSpans().find((s) => s.name === "tool:read_email");
    expect(root).toBeDefined();
    expect(root!.attributes["email.found"]).toBe(false);

    const event = root!.events.find((e) => e.name === "read_email.not_found");
    expect(event).toBeDefined();
    expect(event!.attributes).toMatchObject({ emailId: "missing" });
  });

  it("parents jmap_request under tool:read_email", async () => {
    const exporter = setupInMemoryTracing();
    stubFetch([{ id: "m1", subject: "hi" }]);

    await readEmailHandler({ emailId: "m1" }, fakeExtra);

    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === "tool:read_email");
    const jmap = spans.find((s) => s.name === "jmap_request");
    expect(root).toBeDefined();
    expect(jmap).toBeDefined();
    expect(jmap!.parentSpanContext?.spanId).toBe(root!.spanContext().spanId);
  });

  it("emits read_email.auth_missing and error.class=auth when Authorization is absent", async () => {
    const exporter = setupInMemoryTracing();
    const extraNoAuth = {
      requestInfo: { headers: {} },
    } as unknown as RequestHandlerExtra<any, any>;

    await readEmailHandler({ emailId: "m1" }, extraNoAuth);

    const root = exporter.getFinishedSpans().find((s) => s.name === "tool:read_email");
    expect(root).toBeDefined();
    expect(root!.attributes["error.class"]).toBe("auth");

    const event = root!.events.find((e) => e.name === "read_email.auth_missing");
    expect(event).toBeDefined();
    expect(event!.attributes).toMatchObject({ reason: "no_header" });

    // No alsoLog event should fire for a routine auth-missing path.
    const unexpected = root!.events.find((e) => e.name === "read_email.unexpected_error");
    expect(unexpected).toBeUndefined();
  });
});

describe("tool:compose_email tracing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("records mcp.prefill_fields as the provided keys", async () => {
    const exporter = setupInMemoryTracing();

    await composeEmailHandler({ to: "x@y.z", subject: "hi" }, fakeExtra);

    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === "tool:compose_email");
    expect(root).toBeDefined();
    expect(root!.attributes["mcp.tool"]).toBe("compose_email");
    expect(root!.attributes["mcp.prefill_fields"]).toEqual(["to", "subject"]);
    expect(root!.attributes["mcp.outcome"]).toBe("success");
    expect(typeof root!.attributes["user.id"]).toBe("string");
  });

  it("records empty prefill_fields when nothing is passed", async () => {
    const exporter = setupInMemoryTracing();

    await composeEmailHandler({}, fakeExtra);

    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === "tool:compose_email");
    expect(root).toBeDefined();
    expect(root!.attributes["mcp.prefill_fields"]).toEqual([]);
  });
});
