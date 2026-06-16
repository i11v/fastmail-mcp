import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ALLOWED_METHODS, getSession } from "../tools.js";
import { runWithEnv } from "../env.js";
import { hashToken } from "../utils.js";

describe("ALLOWED_METHODS", () => {
  it("includes core JMAP methods", () => {
    expect(ALLOWED_METHODS.has("Email/query")).toBe(true);
    expect(ALLOWED_METHODS.has("Email/get")).toBe(true);
    expect(ALLOWED_METHODS.has("Email/set")).toBe(true);
    expect(ALLOWED_METHODS.has("Mailbox/get")).toBe(true);
    expect(ALLOWED_METHODS.has("EmailSubmission/set")).toBe(true);
  });

  it("rejects unknown methods", () => {
    expect(ALLOWED_METHODS.has("Evil/method")).toBe(false);
  });
});

interface KVRecord {
  value: string;
  expirationTtl?: number;
}

function makeKv() {
  const store = new Map<string, KVRecord>();
  return {
    store,
    get: vi.fn(async (key: string, type?: string) => {
      const rec = store.get(key);
      if (!rec) return null;
      return type === "json" ? JSON.parse(rec.value) : rec.value;
    }),
    put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
      store.set(key, { value, expirationTtl: options?.expirationTtl });
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace & {
    store: Map<string, KVRecord>;
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
  };
}

function makeExtra(token: string) {
  return {
    requestInfo: { headers: { authorization: `Bearer ${token}` } },
  } as Parameters<typeof getSession>[0];
}

const SESSION_FIXTURE = {
  apiUrl: "https://api.fastmail.com/jmap/api/",
  uploadUrl: "https://api.fastmail.com/jmap/upload/{accountId}/",
  primaryAccounts: { "urn:ietf:params:jmap:mail": "acct-123" },
};

describe("getSession with KV cache", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify(SESSION_FIXTURE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("fetches from upstream on cache miss and writes to KV", async () => {
    const kv = makeKv();
    const token = "token-A";

    const { session } = await runWithEnv({ SESSION_CACHE: kv }, () => getSession(makeExtra(token)));

    expect(session.accountId).toBe("acct-123");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(kv.put).toHaveBeenCalledTimes(1);
    const [key, value, opts] = kv.put.mock.calls[0];
    expect(key).toBe(`session:v1:${hashToken(token)}`);
    expect(JSON.parse(value)).toMatchObject({ accountId: "acct-123" });
    expect(opts.expirationTtl).toBe(3600);
  });

  it("returns cached session without calling upstream", async () => {
    const kv = makeKv();
    const token = "token-B";

    await runWithEnv({ SESSION_CACHE: kv }, () => getSession(makeExtra(token)));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const { session } = await runWithEnv({ SESSION_CACHE: kv }, () => getSession(makeExtra(token)));

    expect(session.accountId).toBe("acct-123");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("isolates cache entries per user (per token)", async () => {
    const kv = makeKv();

    await runWithEnv({ SESSION_CACHE: kv }, () => getSession(makeExtra("user-1")));
    await runWithEnv({ SESSION_CACHE: kv }, () => getSession(makeExtra("user-2")));

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(kv.store.size).toBe(2);
    expect(kv.store.has(`session:v1:${hashToken("user-1")}`)).toBe(true);
    expect(kv.store.has(`session:v1:${hashToken("user-2")}`)).toBe(true);
  });

  it("works without a KV binding (cache disabled)", async () => {
    const { session } = await runWithEnv({}, () => getSession(makeExtra("token-C")));
    expect(session.accountId).toBe("acct-123");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
