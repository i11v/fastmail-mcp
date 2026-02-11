import { createHash } from "node:crypto";
import { z } from "zod";
import {
  createJMAPClient,
  createJMAPClientWithConfig,
  defaultConfig,
  type JMAPClientWrapper,
  type Session,
} from "effect-jmap";
import { Common } from "effect-jmap";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { formatEmailsForLLM } from "./format.js";
import { getCachedSession, setCachedSession } from "./redis.js";

// Constants
const FASTMAIL_SESSION_ENDPOINT = "https://api.fastmail.com/jmap/session";

/**
 * Extract bearer token from request headers
 */
function extractBearerToken(extra: RequestHandlerExtra<any, any>): string {
  const headers = extra.requestInfo?.headers;

  if (!headers) {
    throw new Error(
      "Missing request headers. Ensure Authorization header is set with 'Bearer <token>' format.",
    );
  }

  // IsomorphicHeaders is Record<string, string | string[] | undefined>
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

/**
 * Create a JMAP client from the bearer token in the request.
 * Uses Redis to cache the JMAP session, avoiding an HTTP round-trip
 * to the session endpoint on every tool call.
 */
async function getClient(extra: RequestHandlerExtra<any, any>): Promise<JMAPClientWrapper> {
  const bearerToken = extractBearerToken(extra);
  const tokenHash = hashToken(bearerToken);

  // Try to use cached session from Redis
  const cached = await getCachedSession(tokenHash).catch(() => null);
  if (cached) {
    const session: Session = JSON.parse(cached.json);
    const config = {
      ...defaultConfig(FASTMAIL_SESSION_ENDPOINT, bearerToken),
      initialSession: session,
    };
    return createJMAPClientWithConfig(config as Parameters<typeof createJMAPClientWithConfig>[0]);
  }

  // No cache — create client (fetches session from Fastmail)
  const client = await createJMAPClient(FASTMAIL_SESSION_ENDPOINT, bearerToken);

  // Cache the session in Redis for subsequent requests
  await setCachedSession(tokenHash, {
    accountId: client.accountId,
    json: JSON.stringify(client.session),
  }).catch(() => {}); // Don't fail the request if Redis is down

  return client;
}

// Zod schemas for validation
export const EmailQuerySchema = z.object({
  accountId: z.string().optional(),
  mailboxId: z.string().optional(),
  limit: z.number().min(1).max(100).default(10),
  from: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  hasKeyword: z.string().optional(),
  notKeyword: z.string().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  sort: z.enum(["receivedAt", "sentAt", "subject", "from"]).default("receivedAt"),
  ascending: z.boolean().default(false),
});

export const EmailGetSchema = z.object({
  accountId: z.string().optional(),
  emailIds: z.array(z.string()).min(1).max(50),
  properties: z.array(z.string()).optional(),
  fetchTextBodyValues: z.boolean().optional(),
  fetchHTMLBodyValues: z.boolean().optional(),
  fetchAllBodyValues: z.boolean().optional(),
  maxBodyValueBytes: z.number().optional(),
});

export const EmailSendSchema = z.object({
  to: z.string().email(),
  subject: z.string(),
  body: z.string(),
  htmlBody: z.string().optional(),
  identityId: z.string().optional(),
});

const FLAG_VALUES = [
  "read",
  "unread",
  "flagged",
  "unflagged",
  "answered",
  "unanswered",
  "draft",
  "undraft",
] as const;

export const EmailSetSchema = z.object({
  accountId: z.string().optional(),
  emailIds: z.array(z.string()).min(1).max(50),
  mailboxId: z
    .string()
    .optional()
    .describe(
      "Target mailbox ID or well-known role: 'trash', 'archive', 'inbox', 'drafts', 'junk', 'sent'",
    ),
  flags: z
    .array(z.enum(FLAG_VALUES))
    .min(1)
    .optional()
    .describe(
      "Flags to set: 'read'/'unread', 'flagged'/'unflagged', 'answered'/'unanswered', 'draft'/'undraft'",
    ),
});

export type EmailSetArgs = z.infer<typeof EmailSetSchema>;

// Flag name → JMAP keyword mapping
const FLAG_TO_KEYWORD: Record<string, { keyword: string; value: boolean }> = {
  read: { keyword: "$seen", value: true },
  unread: { keyword: "$seen", value: false },
  flagged: { keyword: "$flagged", value: true },
  unflagged: { keyword: "$flagged", value: false },
  answered: { keyword: "$answered", value: true },
  unanswered: { keyword: "$answered", value: false },
  draft: { keyword: "$draft", value: true },
  undraft: { keyword: "$draft", value: false },
};

function resolveFlags(flags: readonly string[]): {
  markRead?: boolean;
  setFlagged?: boolean;
  keywordsToAdd: string[];
  keywordsToRemove: string[];
} {
  const result: ReturnType<typeof resolveFlags> = {
    keywordsToAdd: [],
    keywordsToRemove: [],
  };

  const seen = new Map<string, string>(); // keyword → flag name that set it

  for (const flag of flags) {
    const mapping = FLAG_TO_KEYWORD[flag];
    if (!mapping) throw new Error(`Unknown flag: '${flag}'`);

    const prev = seen.get(mapping.keyword);
    if (prev !== undefined && prev !== flag) {
      throw new Error(`Contradictory flags: '${prev}' and '${flag}'`);
    }
    seen.set(mapping.keyword, flag);

    if (mapping.keyword === "$seen") {
      result.markRead = mapping.value;
    } else if (mapping.keyword === "$flagged") {
      result.setFlagged = mapping.value;
    } else if (mapping.value) {
      result.keywordsToAdd.push(mapping.keyword);
    } else {
      result.keywordsToRemove.push(mapping.keyword);
    }
  }

  return result;
}

// Type exports
export type EmailQueryArgs = z.infer<typeof EmailQuerySchema>;
export type EmailGetArgs = z.infer<typeof EmailGetSchema>;
export type EmailSendArgs = z.infer<typeof EmailSendSchema>;

/**
 * Helper function to get the default identity for sending emails
 */
async function getDefaultIdentity(
  client: JMAPClientWrapper,
): Promise<{ id: string; email: string; name?: string }> {
  const callId = `identity-get-${Date.now()}`;

  const response = await client.batch(
    [["Identity/get", { accountId: client.accountId }, callId]],
    ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"],
  );

  const identityResponse = response.methodResponses.find(([method]) => method === "Identity/get");

  if (!identityResponse) {
    throw new Error("Identity/get response not found");
  }

  const [, data] = identityResponse;
  if (data.list && data.list.length > 0) {
    const identity = data.list[0];
    return {
      id: identity.id,
      email: identity.email,
      name: identity.name,
    };
  }

  throw new Error("No identities found for account");
}

/**
 * Helper function to upload a blob (RFC 5322 email message) to JMAP server
 */
async function uploadBlob(
  emailMessage: string,
  bearerToken: string,
  client: JMAPClientWrapper,
): Promise<{ blobId: string; size: number; type: string }> {
  const uploadUrl = client.session.uploadUrl.replace("{accountId}", client.accountId);

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "message/rfc822",
    },
    body: emailMessage,
  });

  if (!response.ok) {
    throw new Error(`Upload failed: HTTP ${response.status}`);
  }

  const result = (await response.json()) as {
    blobId: string;
    size: number;
    type: string;
  };

  return {
    blobId: result.blobId,
    size: result.size,
    type: result.type,
  };
}

/**
 * Generate a unique MIME boundary string
 */
function generateMimeBoundary(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 15);
  return `----=_Part_${timestamp}_${random}`;
}

/**
 * Build RFC 5322 email message
 */
function buildEmailMessage(params: {
  identity: { name?: string; email: string };
  to: string;
  subject: string;
  body: string;
  htmlBody?: string;
}): string {
  const { identity, to, subject, body, htmlBody } = params;

  const messageId = `<${Date.now()}.${Math.random().toString(36).substring(2)}@fastmail-mcp>`;

  const fromHeader = identity.name
    ? `From: "${identity.name}" <${identity.email}>`
    : `From: ${identity.email}`;

  const normalizedBody = body.replace(/\r?\n/g, "\r\n");
  const normalizedHtmlBody = htmlBody?.replace(/\r?\n/g, "\r\n");

  const commonHeaders = [
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    fromHeader,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
  ];

  if (!normalizedHtmlBody) {
    return [
      ...commonHeaders,
      `Content-Type: text/plain; charset=utf-8`,
      `Content-Transfer-Encoding: 8bit`,
      ``,
      normalizedBody,
    ].join("\r\n");
  }

  const boundary = generateMimeBoundary();

  return [
    ...commonHeaders,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `This is a multi-part message in MIME format.`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    normalizedBody,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    normalizedHtmlBody,
    ``,
    `--${boundary}--`,
  ].join("\r\n");
}

/**
 * Tool: Get all mailboxes
 */
export async function mailboxGet(extra: RequestHandlerExtra<any, any>): Promise<any> {
  const client = await getClient(extra);
  return await client.mailbox.getAll();
}

/**
 * Tool: Get emails by ID
 */
export async function emailGet(
  args: EmailGetArgs,
  extra: RequestHandlerExtra<any, any>,
): Promise<any> {
  const client = await getClient(extra);
  const accountId = args.accountId || client.accountId;

  const emailResult = await client.email.get({
    accountId: accountId,
    ids: args.emailIds.map((id) => Common.createId(id)),
    properties: args.properties,
    fetchTextBodyValues: args.fetchTextBodyValues,
    fetchHTMLBodyValues: args.fetchHTMLBodyValues,
    fetchAllBodyValues: args.fetchAllBodyValues ?? true,
    maxBodyValueBytes: args.maxBodyValueBytes
      ? Common.createUnsignedInt(args.maxBodyValueBytes)
      : undefined,
  });

  // Format emails as clean text for LLM consumption
  return formatEmailsForLLM(emailResult.list as any[]);
}

/**
 * Tool: Query emails
 */
export async function emailQuery(
  args: EmailQueryArgs,
  extra: RequestHandlerExtra<any, any>,
): Promise<any> {
  const client = await getClient(extra);
  const accountId = args.accountId || client.accountId;

  let filter: any = {};
  if (args.mailboxId) filter.inMailbox = args.mailboxId;
  if (args.from) filter.from = args.from;
  if (args.to) filter.to = args.to;
  if (args.subject) filter.subject = args.subject;
  if (args.hasKeyword) filter.hasKeyword = args.hasKeyword;
  if (args.notKeyword) filter.notKeyword = args.notKeyword;
  if (args.before) filter.before = args.before;
  if (args.after) filter.after = args.after;

  const sort = [{ property: args.sort, isAscending: args.ascending }];

  return await client.email.query({
    accountId,
    filter: Object.keys(filter).length > 0 ? filter : undefined,
    sort,
    limit: Common.createUnsignedInt(args.limit),
  });
}

/**
 * Tool: Send email
 */
export async function emailSend(
  args: EmailSendArgs,
  extra: RequestHandlerExtra<any, any>,
): Promise<any> {
  const bearerToken = extractBearerToken(extra);
  const client = await createJMAPClient(FASTMAIL_SESSION_ENDPOINT, bearerToken);
  const accountId = client.accountId;

  // Get identity
  let identity: { id: string; email: string; name?: string };

  if (args.identityId) {
    const callId = `identity-get-${Date.now()}`;
    const response = await client.batch(
      [["Identity/get", { accountId, ids: [args.identityId] }, callId]],
      ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"],
    );
    const identityResponse = response.methodResponses.find(([method]) => method === "Identity/get");
    if (!identityResponse) {
      throw new Error("Identity/get response not found");
    }
    const [, data] = identityResponse;
    if (!data.list || data.list.length === 0) {
      throw new Error("Identity not found");
    }
    identity = {
      id: data.list[0].id,
      email: data.list[0].email,
      name: data.list[0].name,
    };
  } else {
    identity = await getDefaultIdentity(client);
  }

  const identityId = identity.id;

  // Build RFC 5322 email message
  const emailMessage = buildEmailMessage({
    identity,
    to: args.to,
    subject: args.subject,
    body: args.body,
    htmlBody: args.htmlBody,
  });

  // Upload the email message as a blob
  const uploadResult = await uploadBlob(emailMessage, bearerToken, client);

  // Find drafts mailbox
  const mailboxes = await client.mailbox.getAll();
  const draftsMailbox = mailboxes.find((mb) => mb.role === "drafts");

  if (!draftsMailbox) {
    throw new Error("Drafts mailbox not found");
  }

  // Import the email
  const importResult = await client.email.import({
    accountId,
    emails: {
      [`draft-${Date.now()}`]: {
        blobId: uploadResult.blobId,
        mailboxIds: { [draftsMailbox.id]: true },
        keywords: { $draft: true },
      },
    },
  });

  if (!importResult.created) {
    if (importResult.notCreated) {
      const errors = Object.entries(importResult.notCreated).map(
        ([key, error]) => `${key}: ${JSON.stringify(error)}`,
      );
      throw new Error(`Failed to import email: ${errors.join(", ")}`);
    }
    throw new Error("Failed to import email: no created field in response");
  }

  const createdEmails = Object.values(importResult.created);
  if (createdEmails.length === 0) {
    throw new Error("No email was created");
  }

  const emailId = createdEmails[0].id;

  // Send the email
  const submission = await client.submission.send(Common.createId(identityId), emailId);

  return {
    id: submission.id,
    sendAt: submission.sendAt || "immediately",
  };
}

const WELL_KNOWN_ROLES = ["trash", "archive", "inbox", "drafts", "junk", "sent"] as const;

/**
 * Tool: Update emails — move to mailbox and/or set flags
 */
export async function emailSet(
  args: EmailSetArgs,
  extra: RequestHandlerExtra<any, any>,
): Promise<any> {
  if (!args.mailboxId && !args.flags) {
    throw new Error("At least one of 'mailboxId' or 'flags' must be provided");
  }

  const client = await getClient(extra);
  const accountId = args.accountId || client.accountId;

  const ids = args.emailIds.map((id) => Common.createId(id));
  let targetMailboxId: string | undefined;
  const results: Record<string, unknown> = {};

  // Move to mailbox
  if (args.mailboxId) {
    const isRole = WELL_KNOWN_ROLES.includes(args.mailboxId as any);

    if (isRole) {
      const mailboxes = await client.mailbox.findByRole(args.mailboxId as any);
      if (mailboxes.length === 0) {
        throw new Error(`No mailbox found with role '${args.mailboxId}'`);
      }
      targetMailboxId = mailboxes[0].id;
    } else {
      targetMailboxId = args.mailboxId;
    }

    const update: Record<string, { mailboxIds: Record<string, boolean> }> = {};
    for (const emailId of args.emailIds) {
      update[Common.createId(emailId) as string] = {
        mailboxIds: { [Common.createId(targetMailboxId) as string]: true },
      };
    }

    const moveResult = await client.email.set({ accountId, update: update as any });
    const movedCount = moveResult.updated ? Object.keys(moveResult.updated).length : 0;
    results.moved = movedCount;
    results.targetMailboxId = targetMailboxId;
    if (moveResult.notUpdated && Object.keys(moveResult.notUpdated).length > 0) {
      results.notUpdated = moveResult.notUpdated;
    }
  }

  // Set flags
  if (args.flags) {
    const resolved = resolveFlags(args.flags);

    if (resolved.markRead !== undefined) {
      await client.email.markRead(ids, resolved.markRead, accountId);
    }
    if (resolved.setFlagged !== undefined) {
      await client.email.flag(ids, resolved.setFlagged, accountId);
    }
    if (resolved.keywordsToAdd.length > 0 || resolved.keywordsToRemove.length > 0) {
      await client.email.updateKeywords(
        ids,
        resolved.keywordsToAdd,
        resolved.keywordsToRemove,
        accountId,
      );
    }

    results.flags = args.flags;
    results.flagsUpdated = args.emailIds.length;
  }

  return results;
}

// Tool definitions for MCP
export const toolDefinitions = {
  mailbox_get: {
    description: "Get all mailboxes using JMAP Mailbox/get method",
    parameters: z.object({}),
  },
  email_get: {
    description:
      "Get specific emails by their IDs. Returns formatted text optimized for LLM consumption.",
    parameters: EmailGetSchema,
  },
  email_query: {
    description: "Query emails with filters and sorting",
    parameters: EmailQuerySchema,
  },
  email_send: {
    description:
      "Send an email via Fastmail. Supports plain text, HTML, or multipart/alternative (both) emails.",
    parameters: EmailSendSchema,
  },
  email_set: {
    description:
      "Update emails: move to a mailbox and/or set flags. For mailbox, use well-known names: 'trash' (delete), 'archive', 'inbox', 'junk', 'drafts', 'sent', or a mailbox ID. For flags: 'read'/'unread', 'flagged'/'unflagged', 'answered'/'unanswered', 'draft'/'undraft'.",
    parameters: EmailSetSchema,
  },
};

/**
 * Register all tools with the MCP server
 */
export function registerTools(server: McpServer) {
  // Tool: Get all mailboxes
  server.registerTool(
    "mailbox_get",
    {
      description: "Get all mailboxes using JMAP Mailbox/get method",
      inputSchema: z.object({}),
    },
    async (_input, extra) => {
      try {
        const result = await mailboxGet(extra);
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

  // Tool: Get emails by ID
  server.registerTool(
    "email_get",
    {
      description:
        "Get specific emails by their IDs. Returns formatted text optimized for LLM consumption.",
      inputSchema: EmailGetSchema,
    },
    async (args, extra) => {
      try {
        const formattedEmails = await emailGet(args, extra);
        return {
          content: [{ type: "text", text: formattedEmails }],
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

  // Tool: Query emails
  server.registerTool(
    "email_query",
    {
      description: "Query emails with filters and sorting",
      inputSchema: EmailQuerySchema,
    },
    async (args, extra) => {
      try {
        const result = await emailQuery(args, extra);
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

  // Tool: Send email
  server.registerTool(
    "email_send",
    {
      description:
        "Send an email via Fastmail. Supports plain text, HTML, or multipart/alternative (both) emails.",
      inputSchema: EmailSendSchema,
    },
    async (args, extra) => {
      try {
        const result = await emailSend(args, extra);
        return {
          content: [
            {
              type: "text",
              text: `Email sent successfully!\nSubmission ID: ${result.id}\nSent at: ${result.sendAt}`,
            },
          ],
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

  // Tool: Update emails (move and/or set flags)
  server.registerTool(
    "email_set",
    {
      description:
        "Update emails: move to a mailbox and/or set flags. For mailbox, use well-known names: 'trash' (delete), 'archive', 'inbox', 'junk', 'drafts', 'sent', or a mailbox ID. For flags: 'read'/'unread', 'flagged'/'unflagged', 'answered'/'unanswered', 'draft'/'undraft'.",
      inputSchema: EmailSetSchema,
    },
    async (args, extra) => {
      try {
        const result = await emailSet(args, extra);
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
