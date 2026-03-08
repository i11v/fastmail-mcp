import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { getCachedSession, setCachedSession } from "./redis.js";

// Constants
const FASTMAIL_SESSION_ENDPOINT = "https://api.fastmail.com/jmap/session";

const JMAP_USING = [
  "urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail",
  "urn:ietf:params:jmap:submission",
];

// --- Method allowlist ---

export const ALLOWED_METHODS = new Set([
  // Core
  "Core/echo",
  // Mailbox
  "Mailbox/get",
  "Mailbox/query",
  "Mailbox/queryChanges",
  "Mailbox/set",
  // Email
  "Email/get",
  "Email/query",
  "Email/queryChanges",
  "Email/set",
  // Thread
  "Thread/get",
  // SearchSnippet
  "SearchSnippet/get",
  // Identity
  "Identity/get",
  // EmailSubmission
  "EmailSubmission/get",
  "EmailSubmission/query",
  "EmailSubmission/set",
]);

// --- Types ---

export interface JMAPSession {
  apiUrl: string;
  uploadUrl: string;
  accountId: string;
}

type MethodCall = [string, Record<string, unknown>, string];

export type Safety = "read" | "write" | "destructive";

// --- Auth helpers ---

function extractBearerToken(extra: RequestHandlerExtra<any, any>): string {
  const headers = extra.requestInfo?.headers;

  if (!headers) {
    throw new Error(
      "Missing request headers. Ensure Authorization header is set with 'Bearer <token>' format.",
    );
  }

  const authHeader = headers["authorization"] || headers["Authorization"];

  if (!authHeader || typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    throw new Error(
      "Missing bearer token. Ensure Authorization header is set with 'Bearer <token>' format.",
    );
  }

  return authHeader.substring(7);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

// --- Session management ---

async function fetchSession(bearerToken: string): Promise<JMAPSession> {
  const response = await fetch(FASTMAIL_SESSION_ENDPOINT, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });

  if (!response.ok) {
    throw new Error(`Session fetch failed: HTTP ${response.status}`);
  }

  const session = (await response.json()) as {
    apiUrl: string;
    uploadUrl: string;
    primaryAccounts: Record<string, string>;
  };

  const accountId = session.primaryAccounts["urn:ietf:params:jmap:mail"];
  if (!accountId) {
    throw new Error("No mail account found in JMAP session");
  }

  return {
    apiUrl: session.apiUrl,
    uploadUrl: session.uploadUrl,
    accountId,
  };
}

async function getSession(
  extra: RequestHandlerExtra<any, any>,
): Promise<{ session: JMAPSession; bearerToken: string }> {
  const bearerToken = extractBearerToken(extra);
  const tokenHash = hashToken(bearerToken);

  // Try cached session
  const cached = await getCachedSession(tokenHash).catch(() => null);
  if (cached) {
    const session: JMAPSession = JSON.parse(cached.json);
    return { session, bearerToken };
  }

  // Fetch fresh session
  const session = await fetchSession(bearerToken);

  // Cache it
  await setCachedSession(tokenHash, {
    accountId: session.accountId,
    json: JSON.stringify(session),
  }).catch(() => {}); // Don't fail if Redis is down

  return { session, bearerToken };
}

// --- Validation ---

export function validateStructure(methodCalls: unknown): MethodCall[] {
  if (!Array.isArray(methodCalls)) {
    throw new Error("methodCalls must be an array");
  }

  if (methodCalls.length === 0) {
    throw new Error("methodCalls must not be empty");
  }

  const callIds = new Set<string>();
  const validated: MethodCall[] = [];

  for (let i = 0; i < methodCalls.length; i++) {
    const call = methodCalls[i];

    if (!Array.isArray(call) || call.length !== 3) {
      throw new Error(
        `methodCalls[${i}]: must be a triple [methodName, args, callId]. Got ${JSON.stringify(call)}`,
      );
    }

    const [method, args, callId] = call;

    if (typeof method !== "string") {
      throw new Error(`methodCalls[${i}]: method name must be a string`);
    }

    if (!ALLOWED_METHODS.has(method)) {
      throw new Error(
        `methodCalls[${i}]: unknown method "${method}". Allowed: ${[...ALLOWED_METHODS].join(", ")}`,
      );
    }

    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw new Error(`methodCalls[${i}]: args must be an object`);
    }

    if (typeof callId !== "string") {
      throw new Error(`methodCalls[${i}]: callId must be a string`);
    }

    if (callIds.has(callId)) {
      throw new Error(`methodCalls[${i}]: duplicate callId "${callId}"`);
    }

    callIds.add(callId);
    validated.push([method, args as Record<string, unknown>, callId]);
  }

  return validated;
}

export function validateResultReferences(methodCalls: MethodCall[]): void {
  const seenCallIds = new Set<string>();

  for (let i = 0; i < methodCalls.length; i++) {
    const [, args, callId] = methodCalls[i];

    // Check all args for resultOf references
    for (const [key, value] of Object.entries(args)) {
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        "resultOf" in value
      ) {
        const ref = value as Record<string, unknown>;
        if (typeof ref.resultOf !== "string") {
          throw new Error(`methodCalls[${i}].${key}: resultOf must be a string`);
        }
        if (!seenCallIds.has(ref.resultOf)) {
          throw new Error(
            `methodCalls[${i}].${key}: resultOf references "${ref.resultOf}" which has not appeared in an earlier call`,
          );
        }
      }
    }

    seenCallIds.add(callId);
  }
}

export function validateHygiene(methodCalls: MethodCall[]): void {
  for (let i = 0; i < methodCalls.length; i++) {
    const [method, args] = methodCalls[i];

    // /get calls must include properties (except Mailbox/get and Identity/get which are small)
    if (
      method.endsWith("/get") &&
      method !== "Mailbox/get" &&
      method !== "Identity/get" &&
      method !== "SearchSnippet/get"
    ) {
      // Allow if ids is a resultOf reference (properties still required)
      if (!("properties" in args) || !Array.isArray(args.properties)) {
        throw new Error(
          `methodCalls[${i}]: ${method} requires a "properties" array. ` +
            `Example: ["from", "subject", "receivedAt", "preview"]. ` +
            `This prevents fetching unnecessary data.`,
        );
      }
    }

    // /query calls must include limit
    if (method.endsWith("/query")) {
      if (!("limit" in args) || typeof args.limit !== "number") {
        throw new Error(
          `methodCalls[${i}]: ${method} requires a "limit" (number). Maximum recommended: 50.`,
        );
      }
    }

    // Warn about ids: null on /get calls
    if (method.endsWith("/get") && "ids" in args && args.ids === null) {
      throw new Error(
        `methodCalls[${i}]: ${method} with ids: null fetches ALL items. ` +
          `Use a /query call first to get specific IDs.`,
      );
    }
  }
}

export function classifySafety(methodCalls: MethodCall[]): Safety {
  let safety: Safety = "read";

  for (const [method, args] of methodCalls) {
    if (method === "EmailSubmission/set") {
      return "destructive"; // Sending email is destructive (can't unsend)
    }

    if (method.endsWith("/set")) {
      const argsObj = args as Record<string, unknown>;

      if (argsObj.destroy && Array.isArray(argsObj.destroy) && argsObj.destroy.length > 0) {
        return "destructive";
      }

      if (argsObj.create || argsObj.update) {
        safety = "write";
      }
    }
  }

  return safety;
}

// --- Response cleaning ---

const STRIP_KEYS = new Set(["state", "queryState", "canCalculateChanges", "position", "accountId"]);

export function cleanResponse(methodResponses: unknown[]): unknown[] {
  return methodResponses.map((response) => {
    if (!Array.isArray(response) || response.length !== 3) {
      return response; // Pass through malformed responses
    }

    const [method, result, callId] = response;

    if (typeof result !== "object" || result === null) {
      return [method, result, callId];
    }

    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
      if (!STRIP_KEYS.has(key)) {
        cleaned[key] = value;
      }
    }

    return [method, cleaned, callId];
  });
}

// --- Account ID injection ---

export function injectAccountId(methodCalls: MethodCall[], accountId: string): MethodCall[] {
  return methodCalls.map(([method, args, callId]) => {
    if (!("accountId" in args)) {
      return [method, { ...args, accountId }, callId];
    }
    return [method, args, callId];
  });
}

// --- Execute ---

async function execute(
  args: { methodCalls: [string, Record<string, unknown>, string][] },
  extra: RequestHandlerExtra<any, any>,
): Promise<unknown[]> {
  // 1. Validate
  const validated = validateStructure(args.methodCalls);
  validateResultReferences(validated);
  validateHygiene(validated);

  // 2. Safety check
  const safety = classifySafety(validated);
  if (safety === "destructive") {
    const destructiveOps: string[] = [];
    for (const [method, callArgs] of validated) {
      if (method === "EmailSubmission/set") {
        destructiveOps.push("send email (EmailSubmission/set)");
      } else if (method.endsWith("/set")) {
        const a = callArgs as Record<string, unknown>;
        if (a.destroy && Array.isArray(a.destroy)) {
          destructiveOps.push(`destroy ${a.destroy.length} item(s) (${method})`);
        }
      }
    }
    throw new Error(
      `This request contains destructive operations: ${destructiveOps.join(", ")}. ` +
        `Please confirm with the user before retrying with the same request.`,
    );
  }

  // 3. Get session and inject accountId
  const { session, bearerToken } = await getSession(extra);
  const injectedCalls = injectAccountId(validated, session.accountId);

  // 4. Send to Fastmail
  const jmapRequest = {
    using: JMAP_USING,
    methodCalls: injectedCalls,
  };

  const response = await fetch(session.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify(jmapRequest),
  });

  if (!response.ok) {
    throw new Error(`JMAP request failed: HTTP ${response.status}`);
  }

  const jmapResponse = (await response.json()) as { methodResponses: unknown[] };

  // 5. Clean and return
  return cleanResponse(jmapResponse.methodResponses);
}

// --- Zod schema ---

const ExecuteSchema = z.object({
  methodCalls: z.array(z.tuple([z.string(), z.record(z.unknown()), z.string()])),
});

// --- Tool registration ---

export function registerTools(server: McpServer) {
  server.registerTool(
    "execute",
    {
      description:
        "Execute JMAP method calls against Fastmail. Input: an array of JMAP method call triples [methodName, args, callId]. " +
        "The server validates the request, injects accountId, sends to Fastmail, and returns cleaned responses. " +
        "Use resultOf back-references to chain calls (e.g., query then get). " +
        "Every /get call must include a 'properties' array. Every /query call must include a 'limit'.",
      inputSchema: ExecuteSchema,
    },
    async (args, extra) => {
      try {
        const result = await execute(args, extra);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
