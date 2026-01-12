import { z } from "zod";
import { createHash } from "node:crypto";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import {
  JMAPLive,
  JMAPClientService,
  MailboxService,
  EmailService,
  EmailSubmissionService,
} from "effect-jmap";
import { Common } from "effect-jmap";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { getCachedSession, setCachedSession } from "./redis.js";
import { unified } from "unified";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";

// Constants
const FASTMAIL_SESSION_ENDPOINT = "https://api.fastmail.com/jmap/session";

// HTML to Markdown converter using rehype-remark with GFM support for tables
const htmlToMarkdownProcessor = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeRemark)
  .use(remarkGfm)
  .use(remarkStringify);

/**
 * Convert HTML string to Markdown
 */
async function htmlToMarkdown(html: string): Promise<string> {
  const result = await htmlToMarkdownProcessor.process(html);
  return String(result);
}

/**
 * Get the body content from an email.
 * Prefers htmlBody (converted to Markdown) for consistent output.
 */
async function getEmailBody(email: any): Promise<string> {
  if (!email.bodyValues) return "";

  // Use htmlBody and convert to Markdown
  if (email.htmlBody && email.htmlBody.length > 0) {
    const htmlPartId = email.htmlBody[0].partId;
    const htmlBody = email.bodyValues[htmlPartId];
    if (htmlBody?.value) {
      try {
        return (await htmlToMarkdown(htmlBody.value)).trim();
      } catch {
        return htmlBody.value;
      }
    }
  }

  // Fall back to textBody if no htmlBody
  if (email.textBody && email.textBody.length > 0) {
    const textPartId = email.textBody[0].partId;
    const textBody = email.bodyValues[textPartId];
    if (textBody?.value) {
      return textBody.value.trim();
    }
  }

  return "";
}

/**
 * Escape XML attribute value
 */
function escapeXmlAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Escape XML text content
 */
function escapeXmlText(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Format address list as XML nodes
 */
function formatAddressNodes(
  addresses: Array<{ name?: string; email: string }> | undefined,
  tagName: string
): string | null {
  if (!addresses || addresses.length === 0) return null;

  const addressTags = addresses.map((addr) => {
    const nameAttr = addr.name ? ` name="${escapeXmlAttr(addr.name)}"` : "";
    return `    <address${nameAttr} email="${escapeXmlAttr(addr.email)}" />`;
  });

  return `  <${tagName}>\n${addressTags.join("\n")}\n  </${tagName}>`;
}

/**
 * Format a single email as XML
 */
async function formatEmailXml(email: any): Promise<string> {
  const lines: string[] = [];

  // Email opening tag with core attributes
  const attrs: string[] = [`id="${escapeXmlAttr(email.id)}"`];

  if (email.receivedAt) {
    attrs.push(`date="${new Date(email.receivedAt).toISOString()}"`);
  } else if (email.sentAt) {
    attrs.push(`date="${new Date(email.sentAt).toISOString()}"`);
  }

  const flags: string[] = [];
  if (!email.keywords?.$seen) flags.push("unread");
  if (email.keywords?.$flagged) flags.push("flagged");
  if (email.keywords?.$answered) flags.push("replied");
  if (email.keywords?.$draft) flags.push("draft");
  if (flags.length > 0) attrs.push(`status="${flags.join(", ")}"`);

  if (email.hasAttachment) attrs.push(`attachments="yes"`);

  lines.push(`<email ${attrs.join(" ")}>`);

  // Address fields per RFC 8621
  const fromNodes = formatAddressNodes(email.from, "from");
  if (fromNodes) lines.push(fromNodes);

  const toNodes = formatAddressNodes(email.to, "to");
  if (toNodes) lines.push(toNodes);

  const ccNodes = formatAddressNodes(email.cc, "cc");
  if (ccNodes) lines.push(ccNodes);

  const bccNodes = formatAddressNodes(email.bcc, "bcc");
  if (bccNodes) lines.push(bccNodes);

  const replyToNodes = formatAddressNodes(email.replyTo, "reply_to");
  if (replyToNodes) lines.push(replyToNodes);

  const senderNodes = formatAddressNodes(email.sender, "sender");
  if (senderNodes) lines.push(senderNodes);

  // Subject
  if (email.subject) {
    lines.push(`  <subject>${escapeXmlText(email.subject)}</subject>`);
  }

  // Body
  const body = await getEmailBody(email);
  lines.push(`  <body>\n${body}\n  </body>`);

  lines.push("</email>");

  return lines.join("\n");
}

/**
 * Format emails into XML structure grouped by thread
 */
async function formatEmailsForLLM(emails: any[]): Promise<string> {
  // Group emails by threadId
  const threads = new Map<string, any[]>();

  for (const email of emails) {
    const threadId = email.threadId || email.id;
    if (!threads.has(threadId)) {
      threads.set(threadId, []);
    }
    threads.get(threadId)!.push(email);
  }

  // Sort emails within each thread by date (oldest first)
  for (const threadEmails of threads.values()) {
    threadEmails.sort((a, b) => {
      const dateA = new Date(a.receivedAt || a.sentAt || 0).getTime();
      const dateB = new Date(b.receivedAt || b.sentAt || 0).getTime();
      return dateA - dateB;
    });
  }

  // Format each thread
  const threadOutputs: string[] = [];

  for (const [threadId, threadEmails] of threads) {
    const emailTags = await Promise.all(threadEmails.map(formatEmailXml));
    threadOutputs.push(`<thread id="${threadId}">\n${emailTags.join("\n")}\n</thread>`);
  }

  return threadOutputs.join("\n\n");
}

/**
 * Hash token for use as Redis key (avoids storing full tokens)
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").substring(0, 16);
}

/**
 * Extract bearer token from request headers
 */
function extractBearerToken(extra: RequestHandlerExtra<any, any>): string {
  const headers = extra.requestInfo?.headers;

  if (!headers) {
    throw new Error("Missing request headers. Ensure Authorization header is set with 'Bearer <token>' format.");
  }

  // IsomorphicHeaders is Record<string, string | string[] | undefined>
  const authHeader = headers["authorization"] || headers["Authorization"];

  if (!authHeader || typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    throw new Error("Missing bearer token. Ensure Authorization header is set with 'Bearer <token>' format.");
  }

  return authHeader.substring(7);
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
  sort: z
    .enum(["receivedAt", "sentAt", "subject", "from"])
    .default("receivedAt"),
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

// Type exports
export type EmailQueryArgs = z.infer<typeof EmailQuerySchema>;
export type EmailGetArgs = z.infer<typeof EmailGetSchema>;
export type EmailSendArgs = z.infer<typeof EmailSendSchema>;

/**
 * Create JMAP layers for a bearer token
 */
function createLayers(bearerToken: string): Layer.Layer<any> {
  return JMAPLive(FASTMAIL_SESSION_ENDPOINT, bearerToken);
}

/**
 * Get JMAP session, using Redis cache if available
 */
async function getSession(
  bearerToken: string,
  layers: Layer.Layer<any>
): Promise<any> {
  const tokenHash = hashToken(bearerToken);

  // Try Redis first
  const cached = await getCachedSession(tokenHash);
  if (cached) return JSON.parse(cached.json);

  // Fetch from JMAP
  const program = Effect.gen(function* () {
    const client = yield* JMAPClientService;
    return yield* client.getSession;
  });

  const session = await Effect.runPromise(program.pipe(Effect.provide(layers)));

  // Cache in Redis
  const accountId =
    session.primaryAccounts?.["urn:ietf:params:jmap:mail"] ||
    Object.keys(session.accounts)[0];
  await setCachedSession(tokenHash, {
    accountId,
    json: JSON.stringify(session),
  });

  return session;
}

/**
 * Get account ID, using Redis cache if available
 */
async function getAccountId(
  bearerToken: string,
  layers: Layer.Layer<any>
): Promise<string> {
  const tokenHash = hashToken(bearerToken);

  // Try Redis first
  const cached = await getCachedSession(tokenHash);
  if (cached) return cached.accountId;

  // Fetch session (will cache both)
  const session = await getSession(bearerToken, layers);
  return (
    session.primaryAccounts?.["urn:ietf:params:jmap:mail"] ||
    Object.keys(session.accounts)[0]
  );
}

/**
 * Helper function to get the default identity for sending emails
 */
async function getDefaultIdentity(
  accountId: string,
  layers: Layer.Layer<any>,
): Promise<{ id: string; email: string; name?: string }> {
  const program = Effect.gen(function* () {
    const client = yield* JMAPClientService;
    const callId = `identity-get-${Date.now()}`;

    const methodCall: ["Identity/get", { accountId: string }, string] = [
      "Identity/get",
      { accountId },
      callId,
    ];
    const response = yield* client.batch(
      [methodCall],
      [
        "urn:ietf:params:jmap:core",
        "urn:ietf:params:jmap:mail",
        "urn:ietf:params:jmap:submission",
      ],
    );

    const identityResponse = response.methodResponses.find(
      ([method]) => method === "Identity/get",
    );

    if (!identityResponse) {
      return yield* Effect.fail(new Error("Identity/get response not found"));
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

    return yield* Effect.fail(new Error("No identities found for account"));
  });

  return await Effect.runPromise(program.pipe(Effect.provide(layers)));
}

/**
 * Helper function to upload a blob (RFC 5322 email message) to JMAP server
 */
async function uploadBlob(
  emailMessage: string,
  bearerToken: string,
  layers: Layer.Layer<any>,
): Promise<{ blobId: string; size: number; type: string }> {
  const program = Effect.gen(function* () {
    const client = yield* JMAPClientService;
    const session = yield* client.getSession;
    const httpClient = yield* HttpClient.HttpClient;

    const uploadUrl = session.uploadUrl.replace(
      "{accountId}",
      session.primaryAccounts?.["urn:ietf:params:jmap:mail"] ||
        Object.keys(session.accounts)[0],
    );

    const uploadRequest = HttpClientRequest.post(uploadUrl).pipe(
      HttpClientRequest.setHeader("Authorization", `Bearer ${bearerToken}`),
      HttpClientRequest.setHeader("Content-Type", "message/rfc822"),
      HttpClientRequest.bodyText(emailMessage),
    );

    const response = yield* httpClient.execute(uploadRequest);
    const responseBody = (yield* response.json) as {
      blobId: string;
      size: number;
      type: string;
    };

    return {
      blobId: responseBody.blobId,
      size: responseBody.size,
      type: responseBody.type,
    };
  });

  return await Effect.runPromise(program.pipe(Effect.provide(layers)));
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
  const bearerToken = extractBearerToken(extra);
  const layers = createLayers(bearerToken);
  const accountId = await getAccountId(bearerToken, layers);

  const program = Effect.gen(function* () {
    const service = yield* MailboxService;
    return yield* service.getAll(accountId);
  });

  return await Effect.runPromise(program.pipe(Effect.provide(layers)));
}

/**
 * Tool: Get emails by ID
 */
export async function emailGet(args: EmailGetArgs, extra: RequestHandlerExtra<any, any>): Promise<any> {
  const bearerToken = extractBearerToken(extra);
  const layers = createLayers(bearerToken);
  const accountId = args.accountId || (await getAccountId(bearerToken, layers));

  const program = Effect.gen(function* () {
    const service = yield* EmailService;
    return yield* service.get({
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
  });

  const emailResult = await Effect.runPromise(
    program.pipe(Effect.provide(layers)),
  );

  const emails = (emailResult as any).list;

  // Format emails as clean text for LLM consumption
  return formatEmailsForLLM(emails);
}

/**
 * Tool: Query emails
 */
export async function emailQuery(args: EmailQueryArgs, extra: RequestHandlerExtra<any, any>): Promise<any> {
  const bearerToken = extractBearerToken(extra);
  const layers = createLayers(bearerToken);
  const accountId = args.accountId || (await getAccountId(bearerToken, layers));

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

  const program = Effect.gen(function* () {
    const service = yield* EmailService;
    return yield* service.query({
      accountId,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      sort,
      limit: Common.createUnsignedInt(args.limit),
    });
  });

  return await Effect.runPromise(program.pipe(Effect.provide(layers)));
}

/**
 * Tool: Send email
 */
export async function emailSend(args: EmailSendArgs, extra: RequestHandlerExtra<any, any>): Promise<any> {
  const bearerToken = extractBearerToken(extra);
  const layers = createLayers(bearerToken);
  const accountId = await getAccountId(bearerToken, layers);

  // Get identity
  const identity = args.identityId
    ? await (async () => {
        const program = Effect.gen(function* () {
          const client = yield* JMAPClientService;
          const callId = `identity-get-${Date.now()}`;
          const methodCall: [
            "Identity/get",
            { accountId: string; ids: string[] },
            string,
          ] = [
            "Identity/get",
            { accountId, ids: [args.identityId!] },
            callId,
          ];
          const response = yield* client.batch(
            [methodCall],
            [
              "urn:ietf:params:jmap:core",
              "urn:ietf:params:jmap:mail",
              "urn:ietf:params:jmap:submission",
            ],
          );
          const identityResponse = response.methodResponses.find(
            ([method]) => method === "Identity/get",
          );
          if (!identityResponse) {
            return yield* Effect.fail(
              new Error("Identity/get response not found"),
            );
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
          return yield* Effect.fail(new Error("Identity not found"));
        });
        return await Effect.runPromise(program.pipe(Effect.provide(layers)));
      })()
    : await getDefaultIdentity(accountId, layers);

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
  const uploadResult = await uploadBlob(emailMessage, bearerToken, layers);

  // Import and send
  const program = Effect.gen(function* () {
    const emailService = yield* EmailService;
    const submissionService = yield* EmailSubmissionService;
    const mailboxService = yield* MailboxService;

    const mailboxes = yield* mailboxService.getAll(accountId);
    const draftsMailbox = mailboxes.find((mb) => mb.role === "drafts");

    if (!draftsMailbox) {
      return yield* Effect.fail(new Error("Drafts mailbox not found"));
    }

    const importResult = yield* emailService.import({
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
        return yield* Effect.fail(
          new Error(`Failed to import email: ${errors.join(", ")}`),
        );
      }
      return yield* Effect.fail(
        new Error("Failed to import email: no created field in response"),
      );
    }

    const createdEmails = Object.values(importResult.created);
    if (createdEmails.length === 0) {
      return yield* Effect.fail(new Error("No email was created"));
    }

    const emailId = createdEmails[0].id;

    const submission = yield* submissionService.send(
      accountId,
      Common.createId(identityId),
      emailId,
    );

    return submission;
  });

  const result = await Effect.runPromise(
    program.pipe(Effect.provide(layers)),
  );

  return {
    id: result.id,
    sendAt: result.sendAt || "immediately",
  };
}

// Tool definitions for MCP
export const toolDefinitions = {
  mailbox_get: {
    description: "Get all mailboxes using JMAP Mailbox/get method",
    parameters: z.object({}),
  },
  email_get: {
    description: "Get specific emails by their IDs. Returns formatted text optimized for LLM consumption.",
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
    }
  );

  // Tool: Get emails by ID
  server.registerTool(
    "email_get",
    {
      description: "Get specific emails by their IDs. Returns formatted text optimized for LLM consumption.",
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
    }
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
    }
  );

  // Tool: Send email
  server.registerTool(
    "email_send",
    {
      description: "Send an email via Fastmail. Supports plain text, HTML, or multipart/alternative (both) emails.",
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
    }
  );
}
