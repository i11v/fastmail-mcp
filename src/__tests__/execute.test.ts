import { describe, it, expect } from "vitest";
import {
  validateStructure,
  validateResultReferences,
  validateHygiene,
  classifySafety,
  describeDestructiveAction,
  cleanResponse,
  injectAccountId,
  ALLOWED_METHODS,
} from "../tools.js";

describe("validateStructure", () => {
  it("accepts valid method call triples", () => {
    const result = validateStructure([
      ["Email/query", { filter: {}, limit: 10 }, "call-0"],
      ["Email/get", { ids: ["id1"], properties: ["subject"] }, "call-1"],
    ]);
    expect(result).toHaveLength(2);
    expect(result[0][0]).toBe("Email/query");
  });

  it("rejects non-array input", () => {
    expect(() => validateStructure("not an array")).toThrow("must be an array");
  });

  it("rejects empty array", () => {
    expect(() => validateStructure([])).toThrow("must not be empty");
  });

  it("rejects non-triple elements", () => {
    expect(() => validateStructure([["Email/query", {}]])).toThrow("must be a triple");
  });

  it("rejects non-string method name", () => {
    expect(() => validateStructure([[42, {}, "call-0"]])).toThrow("method name must be a string");
  });

  it("rejects unknown methods", () => {
    expect(() => validateStructure([["Unknown/method", {}, "call-0"]])).toThrow("unknown method");
  });

  it("rejects non-object args", () => {
    expect(() => validateStructure([["Email/query", "string", "call-0"]])).toThrow(
      "args must be an object",
    );
  });

  it("rejects null args", () => {
    expect(() => validateStructure([["Email/query", null, "call-0"]])).toThrow(
      "args must be an object",
    );
  });

  it("rejects array args", () => {
    expect(() => validateStructure([["Email/query", [], "call-0"]])).toThrow(
      "args must be an object",
    );
  });

  it("rejects non-string callId", () => {
    expect(() => validateStructure([["Email/query", {}, 42]])).toThrow("callId must be a string");
  });

  it("rejects duplicate callIds", () => {
    expect(() =>
      validateStructure([
        ["Email/query", { limit: 10 }, "call-0"],
        ["Email/get", { ids: [], properties: [] }, "call-0"],
      ]),
    ).toThrow('duplicate callId "call-0"');
  });

  it("accepts all allowed methods", () => {
    for (const method of ALLOWED_METHODS) {
      // Just check it doesn't throw for the method name (may fail hygiene later)
      const result = validateStructure([[method, {}, `call-${method}`]]);
      expect(result).toHaveLength(1);
    }
  });
});

describe("validateResultReferences", () => {
  it("accepts valid resultOf references", () => {
    expect(() =>
      validateResultReferences([
        ["Email/query", { limit: 10 }, "call-0"],
        [
          "Email/get",
          {
            ids: { resultOf: "call-0", name: "Email/query", path: "/ids" },
            properties: ["subject"],
          },
          "call-1",
        ],
      ]),
    ).not.toThrow();
  });

  it("rejects resultOf pointing to non-existent callId", () => {
    expect(() =>
      validateResultReferences([
        [
          "Email/get",
          {
            ids: { resultOf: "nonexistent", name: "Email/query", path: "/ids" },
            properties: ["subject"],
          },
          "call-0",
        ],
      ]),
    ).toThrow('resultOf references "nonexistent"');
  });

  it("rejects resultOf pointing to later callId", () => {
    expect(() =>
      validateResultReferences([
        [
          "Email/get",
          {
            ids: { resultOf: "call-1", name: "Email/query", path: "/ids" },
            properties: ["subject"],
          },
          "call-0",
        ],
        ["Email/query", { limit: 10 }, "call-1"],
      ]),
    ).toThrow('resultOf references "call-1" which has not appeared');
  });

  it("rejects non-string resultOf", () => {
    expect(() =>
      validateResultReferences([
        ["Email/get", { ids: { resultOf: 42 }, properties: ["subject"] }, "call-0"],
      ]),
    ).toThrow("resultOf must be a string");
  });

  it("ignores non-resultOf objects", () => {
    expect(() =>
      validateResultReferences([
        ["Email/query", { filter: { inMailbox: "box1" }, limit: 10 }, "call-0"],
      ]),
    ).not.toThrow();
  });
});

describe("validateHygiene", () => {
  it("requires properties on Email/get", () => {
    expect(() => validateHygiene([["Email/get", { ids: ["id1"] }, "call-0"]])).toThrow(
      'requires a "properties" array',
    );
  });

  it("accepts Email/get with properties", () => {
    expect(() =>
      validateHygiene([["Email/get", { ids: ["id1"], properties: ["subject"] }, "call-0"]]),
    ).not.toThrow();
  });

  it("requires properties on Thread/get", () => {
    expect(() => validateHygiene([["Thread/get", { ids: ["t1"] }, "call-0"]])).toThrow(
      'requires a "properties" array',
    );
  });

  it("skips properties check for Mailbox/get", () => {
    expect(() => validateHygiene([["Mailbox/get", {}, "call-0"]])).not.toThrow();
  });

  it("skips properties check for Identity/get", () => {
    expect(() => validateHygiene([["Identity/get", {}, "call-0"]])).not.toThrow();
  });

  it("skips properties check for SearchSnippet/get", () => {
    expect(() =>
      validateHygiene([
        ["SearchSnippet/get", { filter: { text: "test" }, emailIds: ["id1"] }, "call-0"],
      ]),
    ).not.toThrow();
  });

  it("requires limit on /query calls", () => {
    expect(() => validateHygiene([["Email/query", { filter: {} }, "call-0"]])).toThrow(
      'requires a "limit"',
    );
  });

  it("rejects non-number limit on /query", () => {
    expect(() => validateHygiene([["Email/query", { filter: {}, limit: "10" }, "call-0"]])).toThrow(
      'requires a "limit"',
    );
  });

  it("accepts /query with numeric limit", () => {
    expect(() =>
      validateHygiene([["Email/query", { filter: {}, limit: 20 }, "call-0"]]),
    ).not.toThrow();
  });

  it("rejects ids: null on /get calls", () => {
    expect(() =>
      validateHygiene([["Email/get", { ids: null, properties: ["subject"] }, "call-0"]]),
    ).toThrow("ids: null");
  });

  it("does not validate /set calls for properties or limit", () => {
    expect(() => validateHygiene([["Email/set", { update: {} }, "call-0"]])).not.toThrow();
  });
});

describe("classifySafety", () => {
  it("classifies /query and /get as read", () => {
    expect(
      classifySafety([
        ["Email/query", { limit: 10 }, "call-0"],
        ["Email/get", { ids: ["id1"], properties: ["subject"] }, "call-1"],
      ]),
    ).toBe("read");
  });

  it("classifies /set with create as write", () => {
    expect(classifySafety([["Email/set", { create: { draft1: {} } }, "call-0"]])).toBe("write");
  });

  it("classifies /set with update as write", () => {
    expect(classifySafety([["Email/set", { update: { id1: {} } }, "call-0"]])).toBe("write");
  });

  it("classifies /set with destroy as destructive", () => {
    expect(classifySafety([["Email/set", { destroy: ["id1"] }, "call-0"]])).toBe("destructive");
  });

  it("classifies empty destroy array as read (not destructive)", () => {
    expect(classifySafety([["Email/set", { destroy: [] }, "call-0"]])).toBe("read");
  });

  it("classifies EmailSubmission/set as destructive", () => {
    expect(classifySafety([["EmailSubmission/set", { create: { sub1: {} } }, "call-0"]])).toBe(
      "destructive",
    );
  });

  it("returns most dangerous classification when mixed", () => {
    expect(
      classifySafety([
        ["Email/query", { limit: 10 }, "call-0"],
        ["Email/set", { create: { draft1: {} } }, "call-1"],
        ["Email/set", { destroy: ["id1"] }, "call-2"],
      ]),
    ).toBe("destructive");
  });

  it("classifies Mailbox/get as read", () => {
    expect(classifySafety([["Mailbox/get", {}, "call-0"]])).toBe("read");
  });
});

describe("cleanResponse", () => {
  it("strips state, queryState, canCalculateChanges, position, accountId", () => {
    const result = cleanResponse([
      [
        "Email/query",
        {
          ids: ["id1", "id2"],
          state: "abc123",
          queryState: "def456",
          canCalculateChanges: true,
          position: 0,
          accountId: "acct1",
          limit: 10,
        },
        "call-0",
      ],
    ]);

    expect(result).toEqual([
      [
        "Email/query",
        {
          ids: ["id1", "id2"],
          limit: 10,
        },
        "call-0",
      ],
    ]);
  });

  it("keeps data, notFound, and error responses", () => {
    const result = cleanResponse([
      [
        "Email/get",
        {
          list: [{ id: "id1", subject: "Test" }],
          notFound: ["id2"],
          state: "xyz",
        },
        "call-0",
      ],
    ]);

    expect(result).toEqual([
      [
        "Email/get",
        {
          list: [{ id: "id1", subject: "Test" }],
          notFound: ["id2"],
        },
        "call-0",
      ],
    ]);
  });

  it("passes through malformed responses", () => {
    const malformed = ["not", "a", "triple", "extra"];
    const result = cleanResponse([malformed]);
    expect(result).toEqual([malformed]);
  });

  it("handles null result", () => {
    const result = cleanResponse([["error", null, "call-0"]]);
    expect(result).toEqual([["error", null, "call-0"]]);
  });
});

describe("describeDestructiveAction", () => {
  it("describes email send", () => {
    expect(
      describeDestructiveAction([["EmailSubmission/set", { create: { sub1: {} } }, "call-0"]]),
    ).toBe("send 1 email(s)");
  });

  it("counts multiple email submissions", () => {
    expect(
      describeDestructiveAction([
        ["EmailSubmission/set", { create: { sub1: {}, sub2: {} } }, "call-0"],
      ]),
    ).toBe("send 2 email(s)");
  });

  it("describes single destroy", () => {
    expect(describeDestructiveAction([["Email/set", { destroy: ["id1"] }, "call-0"]])).toBe(
      "permanently delete 1 item(s) via Email/set",
    );
  });

  it("describes multiple destroys", () => {
    expect(
      describeDestructiveAction([["Email/set", { destroy: ["id1", "id2", "id3"] }, "call-0"]]),
    ).toBe("permanently delete 3 item(s) via Email/set");
  });

  it("combines multiple destructive ops", () => {
    expect(
      describeDestructiveAction([
        ["Email/set", { destroy: ["id1", "id2"] }, "call-0"],
        ["EmailSubmission/set", { create: { sub1: {} } }, "call-1"],
      ]),
    ).toBe("permanently delete 2 item(s) via Email/set, send 1 email(s)");
  });

  it("ignores read-only calls in a mixed batch", () => {
    expect(
      describeDestructiveAction([
        ["Email/query", { limit: 10 }, "call-0"],
        ["Email/get", { ids: ["id1"], properties: ["subject"] }, "call-1"],
        ["Email/set", { destroy: ["id1"] }, "call-2"],
      ]),
    ).toBe("permanently delete 1 item(s) via Email/set");
  });

  it("ignores /set with empty destroy array", () => {
    expect(describeDestructiveAction([["Email/set", { destroy: [] }, "call-0"]])).toBe("");
  });
});

describe("injectAccountId", () => {
  it("injects accountId into calls missing it", () => {
    const result = injectAccountId([["Email/query", { filter: {}, limit: 10 }, "call-0"]], "acct1");
    expect(result[0][1]).toEqual({ filter: {}, limit: 10, accountId: "acct1" });
  });

  it("does not overwrite existing accountId", () => {
    const result = injectAccountId(
      [["Email/query", { filter: {}, limit: 10, accountId: "custom" }, "call-0"]],
      "acct1",
    );
    expect(result[0][1]).toEqual({ filter: {}, limit: 10, accountId: "custom" });
  });

  it("injects into all calls", () => {
    const result = injectAccountId(
      [
        ["Email/query", { limit: 10 }, "call-0"],
        ["Email/get", { ids: ["id1"], properties: ["subject"] }, "call-1"],
      ],
      "acct1",
    );
    expect(result[0][1]).toHaveProperty("accountId", "acct1");
    expect(result[1][1]).toHaveProperty("accountId", "acct1");
  });
});
