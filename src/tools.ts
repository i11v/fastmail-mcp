import { SpanStatusCode, trace, context, type Span } from "@opentelemetry/api";
import { getTracer, forceFlush } from "./tracing.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { hashToken } from "./utils.js";
import { recordEvent } from "./observability.js";

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

// Sentinel used wherever we need to fill in a `method` slot on a span
// attribute/event but the real method is unavailable — either because the
// caller sent garbage (non-string entry in `methodCalls`) or because we
// hit the error before the method could be identified. Single constant so
// Honeycomb filters see one consistent value across `jmap.methods` array
// entries and `execute.validation_failed` event attributes.
const UNKNOWN_METHOD = "<unknown>";

// --- Error classes ---

export class ValidationError extends Error {
  constructor(
    public stage: "structure" | "references" | "hygiene",
    public index: number,
    public method: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

export class AuthError extends Error {
  constructor(
    public reason: "no_header" | "malformed",
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

// --- Auth helpers ---

function extractBearerToken(extra: RequestHandlerExtra<any, any>): string {
  const headers = extra.requestInfo?.headers;

  if (!headers) {
    throw new AuthError(
      "no_header",
      "Missing request headers. Ensure Authorization header is set with 'Bearer <token>' format.",
    );
  }

  const authHeader = headers["authorization"] || headers["Authorization"];

  if (!authHeader || typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    throw new AuthError(
      authHeader ? "malformed" : "no_header",
      "Missing bearer token. Ensure Authorization header is set with 'Bearer <token>' format.",
    );
  }

  return authHeader.substring(7);
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

export async function getSession(
  extra: RequestHandlerExtra<any, any>,
  parentSpan?: Span,
): Promise<{ session: JMAPSession; bearerToken: string }> {
  const bearerToken = extractBearerToken(extra);

  if (parentSpan) {
    parentSpan.setAttribute("user.id", hashToken(bearerToken));
  }

  const parentCtx = parentSpan ? trace.setSpan(context.active(), parentSpan) : context.active();
  const session = await getTracer().startActiveSpan("fetchSession", {}, parentCtx, async (span) => {
    try {
      const result = await fetchSession(bearerToken);
      span.setAttribute("jmap.account_id", result.accountId);
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });

  return { session, bearerToken };
}

// --- Validation ---

export function validateStructure(methodCalls: unknown): MethodCall[] {
  if (!Array.isArray(methodCalls)) {
    throw new ValidationError("structure", 0, undefined, "methodCalls must be an array");
  }

  if (methodCalls.length === 0) {
    throw new ValidationError("structure", 0, undefined, "methodCalls must not be empty");
  }

  const callIds = new Set<string>();
  const validated: MethodCall[] = [];

  for (let i = 0; i < methodCalls.length; i++) {
    const call = methodCalls[i];

    if (!Array.isArray(call) || call.length !== 3) {
      throw new ValidationError(
        "structure",
        i,
        undefined,
        `methodCalls[${i}]: must be a triple [methodName, args, callId]. Got ${JSON.stringify(call)}`,
      );
    }

    const [method, args, callId] = call;

    if (typeof method !== "string") {
      throw new ValidationError(
        "structure",
        i,
        undefined,
        `methodCalls[${i}]: method name must be a string`,
      );
    }

    if (!ALLOWED_METHODS.has(method)) {
      throw new ValidationError(
        "structure",
        i,
        method,
        `methodCalls[${i}]: unknown method "${method}". Allowed: ${[...ALLOWED_METHODS].join(", ")}`,
      );
    }

    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw new ValidationError(
        "structure",
        i,
        method,
        `methodCalls[${i}]: args must be an object`,
      );
    }

    if (typeof callId !== "string") {
      throw new ValidationError(
        "structure",
        i,
        method,
        `methodCalls[${i}]: callId must be a string`,
      );
    }

    if (callIds.has(callId)) {
      throw new ValidationError(
        "structure",
        i,
        method,
        `methodCalls[${i}]: duplicate callId "${callId}"`,
      );
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
          throw new ValidationError(
            "references",
            i,
            methodCalls[i][0],
            `methodCalls[${i}].${key}: resultOf must be a string`,
          );
        }
        if (!seenCallIds.has(ref.resultOf)) {
          throw new ValidationError(
            "references",
            i,
            methodCalls[i][0],
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
        throw new ValidationError(
          "hygiene",
          i,
          method,
          `methodCalls[${i}]: ${method} requires a "properties" array. ` +
            `Example: ["from", "subject", "receivedAt", "preview"]. ` +
            `This prevents fetching unnecessary data.`,
        );
      }
    }

    // /query calls must include limit
    if (method.endsWith("/query")) {
      if (!("limit" in args) || typeof args.limit !== "number") {
        throw new ValidationError(
          "hygiene",
          i,
          method,
          `methodCalls[${i}]: ${method} requires a "limit" (number). Maximum recommended: 50.`,
        );
      }
    }

    // Warn about ids: null on /get calls
    if (method.endsWith("/get") && "ids" in args && args.ids === null) {
      throw new ValidationError(
        "hygiene",
        i,
        method,
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

// --- JMAP network call ---

/**
 * Low-level JMAP call with explicit session and token.
 * Used by apps.ts to make JMAP calls outside the execute tool.
 */
export async function runJMAPDirect(
  methodCalls: MethodCall[],
  session: JMAPSession,
  bearerToken: string,
): Promise<unknown[]> {
  const injectedCalls = injectAccountId(methodCalls, session.accountId);

  const response = await fetch(session.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify({ using: JMAP_USING, methodCalls: injectedCalls }),
  });

  if (!response.ok) {
    throw new Error(`JMAP request failed: HTTP ${response.status}`);
  }

  const jmapResponse = (await response.json()) as { methodResponses: unknown[] };
  return cleanResponse(jmapResponse.methodResponses);
}

async function runJMAP(
  validatedCalls: MethodCall[],
  extra: RequestHandlerExtra<any, any>,
  span?: Span,
): Promise<unknown[]> {
  const { session, bearerToken } = await getSession(extra, span);
  return runJMAPDirect(validatedCalls, session, bearerToken);
}

// --- Destructive action description ---

export function describeDestructiveAction(methodCalls: MethodCall[]): string {
  const ops: string[] = [];
  for (const [method, args] of methodCalls) {
    if (method === "EmailSubmission/set") {
      const a = args as Record<string, unknown>;
      const createCount =
        a.create && typeof a.create === "object" ? Object.keys(a.create).length : 1;
      ops.push(`send ${createCount} email(s)`);
    } else if (method.endsWith("/set")) {
      const a = args as Record<string, unknown>;
      if (Array.isArray(a.destroy) && a.destroy.length > 0) {
        ops.push(`permanently delete ${a.destroy.length} item(s) via ${method}`);
      }
    }
  }
  return ops.join(", ");
}

// --- Zod schemas ---

const ExecuteSchema = z.object({
  methodCalls: z.array(z.tuple([z.string(), z.record(z.unknown()), z.string()])),
  confirmed: z
    .boolean()
    .optional()
    .describe("Set to true to confirm a destructive operation after the server requests it."),
});

// --- Handler ---

// Elicitation dependency is passed in so the handler can be unit-tested
// without constructing a full McpServer.
export type ElicitInputFn = (params: {
  message: string;
  requestedSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}) => Promise<{ action: string; content?: Record<string, unknown> }>;

export async function executeHandler(
  args: z.infer<typeof ExecuteSchema>,
  extra: RequestHandlerExtra<any, any>,
  deps: { elicitInput: ElicitInputFn },
): Promise<CallToolResult> {
  const span = getTracer().startSpan("tool:execute");
  try {
    span.setAttribute("mcp.tool", "execute");
    const rawCalls = Array.isArray(args.methodCalls) ? args.methodCalls : [];
    span.setAttribute("jmap.method_count", rawCalls.length);
    span.setAttribute(
      "jmap.methods",
      rawCalls.map((c) => (Array.isArray(c) && typeof c[0] === "string" ? c[0] : UNKNOWN_METHOD)),
    );

    // Validate
    const validated = validateStructure(args.methodCalls);
    validateResultReferences(validated);
    validateHygiene(validated);

    const safety = classifySafety(validated);
    span.setAttribute("jmap.safety", safety);
    span.setAttribute("mcp.confirmed", args.confirmed === true);

    // Safety gate — confirm destructive ops before executing.
    if (safety === "destructive") {
      // If the caller already confirmed via the `confirmed` flag, skip.
      if (!args.confirmed) {
        // Try elicitation first (rich UI for clients that support it).
        try {
          const elicitResult = await deps.elicitInput({
            message: `This will ${describeDestructiveAction(validated)}. Proceed?`,
            requestedSchema: {
              type: "object" as const,
              properties: {
                confirmed: {
                  type: "boolean" as const,
                  description: "Confirm the destructive operation",
                },
              },
              required: ["confirmed"],
            },
          });
          if (elicitResult.action !== "accept" || !elicitResult.content?.confirmed) {
            span.setAttribute("mcp.outcome", "cancelled");
            return { content: [{ type: "text", text: "Operation cancelled by user." }] };
          }
        } catch {
          // Elicitation not supported — fall back to two-step confirmation.
          const description = describeDestructiveAction(validated);
          span.setAttribute("mcp.outcome", "awaiting_confirmation");
          return {
            content: [
              {
                type: "text",
                text:
                  `⚠️ Confirmation required: this will ${description}. ` +
                  `IMPORTANT: Do NOT proceed automatically — you MUST ask the user for explicit confirmation first. ` +
                  `Only if the user confirms, call this tool again with the same methodCalls and confirmed: true.`,
              },
            ],
          };
        }
      }
    }

    const result = await runJMAP(validated, extra, span);
    span.setAttribute("mcp.outcome", "success");
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    let errorClass: "validation" | "auth" | "unknown" = "unknown";
    if (error instanceof ValidationError) {
      errorClass = "validation";
      recordEvent(span, "execute.validation_failed", {
        stage: error.stage,
        index: error.index,
        method: error.method ?? UNKNOWN_METHOD,
        message: error.message,
      });
    } else if (error instanceof AuthError) {
      errorClass = "auth";
      recordEvent(span, "execute.auth_missing", { reason: error.reason });
    } else {
      recordEvent(
        span,
        "execute.unexpected_error",
        {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? (error.stack ?? "") : "",
        },
        { alsoLog: true },
      );
    }
    span.setAttribute("error.class", errorClass);
    span.setAttribute("mcp.outcome", "error");
    span.recordException(error as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  } finally {
    span.end();
    await forceFlush();
  }
}

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
    async (args, extra) =>
      executeHandler(args, extra, {
        elicitInput: server.server.elicitInput.bind(server.server) as ElicitInputFn,
      }),
  );
}
