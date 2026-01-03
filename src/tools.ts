import { z } from "zod";
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

// Constants
const FASTMAIL_SESSION_ENDPOINT = "https://api.fastmail.com/jmap/session";

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
 * SessionManager - Caches JMAP session, layers, and account ID
 */
class SessionManager {
  private cachedLayers: Layer.Layer<any> | null = null;
  private cachedAccountId: string | null = null;
  private cachedSession: any | null = null;
  private cachedToken: string | null = null;

  getLayers(bearerToken: string): Layer.Layer<any> {
    if (this.cachedToken !== bearerToken) {
      this.invalidate();
      this.cachedToken = bearerToken;
    }

    if (!this.cachedLayers) {
      this.cachedLayers = JMAPLive(FASTMAIL_SESSION_ENDPOINT, bearerToken);
    }

    return this.cachedLayers;
  }

  async getSession(bearerToken: string): Promise<any> {
    const layers = this.getLayers(bearerToken);

    if (!this.cachedSession) {
      const program = Effect.gen(function* () {
        const client = yield* JMAPClientService;
        return yield* client.getSession;
      });

      this.cachedSession = await Effect.runPromise(
        program.pipe(Effect.provide(layers)),
      );
    }

    return this.cachedSession;
  }

  async getAccountId(bearerToken: string): Promise<string> {
    if (!this.cachedAccountId) {
      const session = await this.getSession(bearerToken);
      this.cachedAccountId =
        session.primaryAccounts?.["urn:ietf:params:jmap:mail"] ||
        Object.keys(session.accounts)[0];
    }

    return this.cachedAccountId!;
  }

  invalidate(): void {
    this.cachedLayers = null;
    this.cachedAccountId = null;
    this.cachedSession = null;
  }
}

// Global session manager instance
export const sessionManager = new SessionManager();

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
export async function mailboxGet(): Promise<any> {
  const bearerToken = process.env.FASTMAIL_API_TOKEN;

  if (!bearerToken) {
    throw new Error("FASTMAIL_API_TOKEN environment variable is required");
  }

  const layers = sessionManager.getLayers(bearerToken);
  const accountId = await sessionManager.getAccountId(bearerToken);

  const program = Effect.gen(function* () {
    const service = yield* MailboxService;
    return yield* service.getAll(accountId);
  });

  return await Effect.runPromise(program.pipe(Effect.provide(layers)));
}

/**
 * Tool: Get emails by ID
 */
export async function emailGet(args: EmailGetArgs): Promise<any> {
  const bearerToken = process.env.FASTMAIL_API_TOKEN;

  if (!bearerToken) {
    throw new Error("FASTMAIL_API_TOKEN environment variable is required");
  }

  const layers = sessionManager.getLayers(bearerToken);
  const accountId =
    args.accountId || (await sessionManager.getAccountId(bearerToken));

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

  return (emailResult as any).list;
}

/**
 * Tool: Query emails
 */
export async function emailQuery(args: EmailQueryArgs): Promise<any> {
  const bearerToken = process.env.FASTMAIL_API_TOKEN;

  if (!bearerToken) {
    throw new Error("FASTMAIL_API_TOKEN environment variable is required");
  }

  const layers = sessionManager.getLayers(bearerToken);
  const accountId =
    args.accountId || (await sessionManager.getAccountId(bearerToken));

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
export async function emailSend(args: EmailSendArgs): Promise<any> {
  const bearerToken = process.env.FASTMAIL_API_TOKEN;

  if (!bearerToken) {
    throw new Error("FASTMAIL_API_TOKEN environment variable is required");
  }

  const layers = sessionManager.getLayers(bearerToken);
  const accountId = await sessionManager.getAccountId(bearerToken);

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
    description: "Get specific emails by their IDs",
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
  server.tool(
    "mailbox_get",
    "Get all mailboxes using JMAP Mailbox/get method",
    async () => {
      try {
        const result = await mailboxGet();
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
  server.tool(
    "email_get",
    "Get specific emails by their IDs",
    {
      accountId: EmailGetSchema.shape.accountId,
      emailIds: EmailGetSchema.shape.emailIds,
      properties: EmailGetSchema.shape.properties,
      fetchTextBodyValues: EmailGetSchema.shape.fetchTextBodyValues,
      fetchHTMLBodyValues: EmailGetSchema.shape.fetchHTMLBodyValues,
      fetchAllBodyValues: EmailGetSchema.shape.fetchAllBodyValues,
      maxBodyValueBytes: EmailGetSchema.shape.maxBodyValueBytes,
    },
    async (args: unknown) => {
      try {
        const result = await emailGet(EmailGetSchema.parse(args));
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

  // Tool: Query emails
  server.tool(
    "email_query",
    "Query emails with filters and sorting",
    {
      accountId: EmailQuerySchema.shape.accountId,
      mailboxId: EmailQuerySchema.shape.mailboxId,
      limit: EmailQuerySchema.shape.limit,
      from: EmailQuerySchema.shape.from,
      to: EmailQuerySchema.shape.to,
      subject: EmailQuerySchema.shape.subject,
      hasKeyword: EmailQuerySchema.shape.hasKeyword,
      notKeyword: EmailQuerySchema.shape.notKeyword,
      before: EmailQuerySchema.shape.before,
      after: EmailQuerySchema.shape.after,
      sort: EmailQuerySchema.shape.sort,
      ascending: EmailQuerySchema.shape.ascending,
    },
    async (args: unknown) => {
      try {
        const result = await emailQuery(EmailQuerySchema.parse(args));
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
  server.tool(
    "email_send",
    "Send an email via Fastmail. Supports plain text, HTML, or multipart/alternative (both) emails.",
    {
      to: EmailSendSchema.shape.to,
      subject: EmailSendSchema.shape.subject,
      body: EmailSendSchema.shape.body,
      htmlBody: EmailSendSchema.shape.htmlBody,
      identityId: EmailSendSchema.shape.identityId,
    },
    async (args: unknown) => {
      try {
        const result = await emailSend(EmailSendSchema.parse(args));
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
