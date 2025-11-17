#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// Import effect-jmap library
import { Effect, Layer, Runtime, Scope } from "effect";
import { HttpClient, HttpClientRequest, HttpBody } from "@effect/platform";
import { NodeHttpClient } from "@effect/platform-node";
import {
  JMAPClientLive,
  defaultConfig,
  JMAPClientService,
  MailboxService,
  MailboxServiceLive,
  EmailService,
  EmailServiceLive,
  EmailSubmissionService,
  EmailSubmissionServiceLive,
  IdGeneratorLive,
} from "effect-jmap";
import { Common, Id } from "effect-jmap";

/**
 * MCP Server for Fastmail using effect-jmap library
 */

// Constants
const FASTMAIL_SESSION_ENDPOINT = "https://api.fastmail.com/jmap/session";

const EmailQuerySchema = z.object({
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

const EmailGetSchema = z.object({
  accountId: z.string().optional(),
  emailIds: z.array(z.string()).min(1).max(50),
  properties: z.array(z.string()).optional(),
  fetchTextBodyValues: z.boolean().optional(),
  fetchHTMLBodyValues: z.boolean().optional(),
  fetchAllBodyValues: z.boolean().optional(),
  maxBodyValueBytes: z.number().optional(),
});

const EmailSendSchema = z.object({
  to: z.string().email(),
  subject: z.string(),
  body: z.string(),
  htmlBody: z.string().optional(),
  identityId: z.string().optional(),
});

/**
 * Create the MCP server
 */
const server = new Server(
  {
    name: "fastmail-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

/**
 * Helper function to create JMAP client layers
 */
function createJMAPLayers(sessionUrl: string, bearerToken: string) {
  const config = defaultConfig(sessionUrl, bearerToken);
  return Layer.provideMerge(
    Layer.mergeAll(
      JMAPClientLive(config),
      MailboxServiceLive,
      EmailServiceLive,
      EmailSubmissionServiceLive,
      IdGeneratorLive
    ),
    NodeHttpClient.layer
  );
}

/**
 * SessionManager - Caches JMAP session, layers, and account ID
 */
class SessionManager {
  private cachedLayers: Layer.Layer<any> | null = null;
  private cachedAccountId: string | null = null;
  private cachedSession: any | null = null;
  private cachedToken: string | null = null;

  /**
   * Get or create JMAP layers (cached)
   */
  getLayers(bearerToken: string): Layer.Layer<any> {
    // Invalidate cache if token changed
    if (this.cachedToken !== bearerToken) {
      this.invalidate();
      this.cachedToken = bearerToken;
    }

    if (!this.cachedLayers) {
      this.cachedLayers = createJMAPLayers(
        FASTMAIL_SESSION_ENDPOINT,
        bearerToken,
      );
    }

    return this.cachedLayers;
  }

  /**
   * Get or fetch session data (cached)
   */
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

  /**
   * Get or fetch account ID (cached)
   */
  async getAccountId(bearerToken: string): Promise<string> {
    if (!this.cachedAccountId) {
      const session = await this.getSession(bearerToken);
      this.cachedAccountId =
        session.primaryAccounts?.["urn:ietf:params:jmap:mail"] ||
        Object.keys(session.accounts)[0];
    }

    return this.cachedAccountId!;
  }

  /**
   * Invalidate all cached data
   */
  invalidate(): void {
    this.cachedLayers = null;
    this.cachedAccountId = null;
    this.cachedSession = null;
  }
}

// Global session manager instance
const sessionManager = new SessionManager();

/**
 * Helper function to get account ID from session
 * @deprecated Use sessionManager.getAccountId() instead
 */
async function getAccountId(layers: Layer.Layer<any>): Promise<string> {
  const program = Effect.gen(function* () {
    const client = yield* JMAPClientService;
    return yield* client.getSession;
  });

  const session = await Effect.runPromise(program.pipe(Effect.provide(layers)));
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
  layers: Layer.Layer<any>
): Promise<{ id: string; email: string; name?: string }> {
  const program = Effect.gen(function* () {
    const client = yield* JMAPClientService;
    const callId = `identity-get-${Date.now()}`;

    const methodCall: ["Identity/get", { accountId: string }, string] = ["Identity/get", { accountId }, callId];
    const response = yield* client.batch([methodCall], [
      'urn:ietf:params:jmap:core',
      'urn:ietf:params:jmap:mail',
      'urn:ietf:params:jmap:submission'
    ]);

    // Extract Identity/get response
    const identityResponse = response.methodResponses.find(
      ([method]) => method === "Identity/get"
    );

    if (!identityResponse) {
      return yield* Effect.fail(
        new Error("Identity/get response not found")
      );
    }

    const [, data] = identityResponse;
    if (data.list && data.list.length > 0) {
      const identity = data.list[0];
      return {
        id: identity.id,
        email: identity.email,
        name: identity.name
      };
    }

    return yield* Effect.fail(
      new Error("No identities found for account")
    );
  });

  return await Effect.runPromise(program.pipe(Effect.provide(layers)));
}

/**
 * Helper function to upload a blob (RFC 5322 email message) to JMAP server
 */
async function uploadBlob(
  emailMessage: string,
  bearerToken: string,
  layers: Layer.Layer<any>
): Promise<{ blobId: string; size: number; type: string }> {
  const program = Effect.gen(function* () {
    const client = yield* JMAPClientService;
    const session = yield* client.getSession;
    const httpClient = yield* HttpClient.HttpClient;

    // Upload the email message as a blob
    const uploadUrl = session.uploadUrl.replace(
      "{accountId}",
      session.primaryAccounts?.["urn:ietf:params:jmap:mail"] ||
        Object.keys(session.accounts)[0]
    );

    const uploadRequest = HttpClientRequest.post(uploadUrl).pipe(
      HttpClientRequest.setHeader("Authorization", `Bearer ${bearerToken}`),
      HttpClientRequest.setHeader("Content-Type", "message/rfc822"),
      HttpClientRequest.bodyText(emailMessage)
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
 * Generate a unique MIME boundary string that won't conflict with message content
 * Uses timestamp and random string to ensure uniqueness
 */
function generateMimeBoundary(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 15);
  return `----=_Part_${timestamp}_${random}`;
}

/**
 * Build RFC 5322 email message
 * Supports plain text only or multipart/alternative with both plain text and HTML
 * @param params Email message parameters
 * @returns Formatted RFC 5322 message string
 */
function buildEmailMessage(params: {
  identity: { name?: string; email: string };
  to: string;
  subject: string;
  body: string;
  htmlBody?: string;
}): string {
  const { identity, to, subject, body, htmlBody } = params;

  // Generate unique Message-ID to avoid duplicate detection
  const messageId = `<${Date.now()}.${Math.random().toString(36).substring(2)}@fastmail-mcp>`;

  // Build From header with optional name
  const fromHeader = identity.name
    ? `From: "${identity.name}" <${identity.email}>`
    : `From: ${identity.email}`;

  // Normalize line endings to CRLF (RFC 5322 requirement)
  const normalizedBody = body.replace(/\r?\n/g, '\r\n');
  const normalizedHtmlBody = htmlBody?.replace(/\r?\n/g, '\r\n');

  // Common headers
  const commonHeaders = [
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    fromHeader,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
  ];

  // Case 1: Plain text only (no HTML body provided)
  if (!normalizedHtmlBody) {
    return [
      ...commonHeaders,
      `Content-Type: text/plain; charset=utf-8`,
      `Content-Transfer-Encoding: 8bit`,
      ``,
      normalizedBody,
    ].join('\r\n');
  }

  // Case 2: Multipart/alternative with both plain text and HTML
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
  ].join('\r\n');
}

/**
 * List available tools
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "mailbox_get",
        description: "Get all mailboxes using JMAP Mailbox/get method",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "email_get",
        description: "Get specific emails by their IDs",
        inputSchema: {
          type: "object",
          properties: {
            accountId: {
              type: "string",
              description: "Account ID to retrieve emails from (optional, auto-detected if not provided)",
            },
            emailIds: {
              type: "array",
              items: { type: "string" },
              description: "Array of email IDs to retrieve",
            },
            properties: {
              type: "array",
              items: { type: "string" },
              description: "Specific properties to fetch (optional)",
            },
            fetchTextBodyValues: {
              type: "boolean",
              description: "Fetch text/plain body values",
            },
            fetchHTMLBodyValues: {
              type: "boolean",
              description: "Fetch text/html body values",
            },
            fetchAllBodyValues: {
              type: "boolean",
              description: "Fetch all text body values",
            },
            maxBodyValueBytes: {
              type: "number",
              description: "Maximum size in bytes for body values",
            },
          },
          required: ["emailIds"],
        },
      },
      {
        name: "email_query",
        description: "Query emails with filters and sorting",
        inputSchema: {
          type: "object",
          properties: {
            mailboxId: {
              type: "string",
              description: "Mailbox ID to search in (optional)",
            },
            limit: {
              type: "number",
              minimum: 1,
              maximum: 100,
              default: 10,
              description: "Maximum number of emails to return (default: 10)",
            },
            from: {
              type: "string",
              description: "Filter emails from specific sender",
            },
            to: {
              type: "string",
              description: "Filter emails to specific recipient",
            },
            subject: {
              type: "string",
              description: "Filter emails containing text in subject",
            },
            hasKeyword: {
              type: "string",
              description:
                "Filter emails with specific keyword (e.g., '$seen', '$flagged')",
            },
            notKeyword: {
              type: "string",
              description: "Filter emails without specific keyword",
            },
            before: {
              type: "string",
              description: "Filter emails received before date (ISO format)",
            },
            after: {
              type: "string",
              description: "Filter emails received after date (ISO format)",
            },
            sort: {
              type: "string",
              enum: ["receivedAt", "sentAt", "subject", "from"],
              default: "receivedAt",
              description: "Sort emails by property (default: receivedAt)",
            },
            ascending: {
              type: "boolean",
              default: false,
              description:
                "Sort in ascending order (default: false for newest first)",
            },
          },
        },
      },
      {
        name: "email_send",
        description: "Send an email via Fastmail. Supports plain text, HTML, or multipart/alternative (both) emails.",
        inputSchema: {
          type: "object",
          properties: {
            to: {
              type: "string",
              description: "Recipient email address",
            },
            subject: {
              type: "string",
              description: "Email subject",
            },
            body: {
              type: "string",
              description: "Email body (plain text). If htmlBody is also provided, this will be the plain text alternative.",
            },
            htmlBody: {
              type: "string",
              description: "Optional: Email body in HTML format. When provided with body, creates a multipart/alternative message.",
            },
            identityId: {
              type: "string",
              description:
                "Optional: Identity ID to send from (defaults to primary identity)",
            },
          },
          required: ["to", "subject", "body"],
        },
      },
    ] satisfies Tool[],
  };
});

/**
 * Tool execution handler
 */
server.setRequestHandler(
  CallToolRequestSchema,
  async (request: any): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "mailbox_get":
          return await handleMailboxGet();

        case "email_get":
          const emailGetArgs = EmailGetSchema.parse(args);
          return await handleEmailGet(emailGetArgs);

        case "email_query":
          const emailQueryArgs = EmailQuerySchema.parse(args);
          return await handleEmailQuery(emailQueryArgs);

        case "email_send":
          const emailSendArgs = EmailSendSchema.parse(args);
          return await handleEmailSend(emailSendArgs);

        default:
          return {
            content: [
              {
                type: "text",
                text: `Unknown tool: ${name}`,
              },
            ],
            isError: true,
          };
      }
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

/**
 * Handler functions
 */
async function handleMailboxGet(): Promise<CallToolResult> {
  const bearerToken = process.env.FASTMAIL_API_TOKEN;

  if (!bearerToken) {
    return {
      content: [
        {
          type: "text",
          text: "Error: FASTMAIL_API_TOKEN must be provided in MCP client configuration",
        },
      ],
      isError: true,
    };
  }

  try {
    const layers = sessionManager.getLayers(bearerToken);
    const accountId = await sessionManager.getAccountId(bearerToken);

    const program = Effect.gen(function* () {
      const service = yield* MailboxService;
      return yield* service.getAll(accountId);
    });

    const mailboxes = await Effect.runPromise(
      program.pipe(Effect.provide(layers)),
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(mailboxes, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to get mailboxes: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function handleEmailGet(
  args: z.infer<typeof EmailGetSchema>,
): Promise<CallToolResult> {
  const bearerToken = process.env.FASTMAIL_API_TOKEN;

  if (!bearerToken) {
    return {
      content: [
        {
          type: "text",
          text: "Error: FASTMAIL_API_TOKEN must be provided in MCP client configuration",
        },
      ],
      isError: true,
    };
  }

  try {
    const layers = sessionManager.getLayers(bearerToken);
    const accountId = args.accountId || (await sessionManager.getAccountId(bearerToken));

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

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify((emailResult as any).list, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to get emails: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function handleEmailQuery(
  args: z.infer<typeof EmailQuerySchema>,
): Promise<CallToolResult> {
  const bearerToken = process.env.FASTMAIL_API_TOKEN;

  if (!bearerToken) {
    return {
      content: [
        {
          type: "text",
          text: "Error: FASTMAIL_API_TOKEN must be provided in MCP client configuration",
        },
      ],
      isError: true,
    };
  }

  try {
    const layers = sessionManager.getLayers(bearerToken);
    const accountId = args.accountId || (await sessionManager.getAccountId(bearerToken));

    // Build the filter from the query arguments
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

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(layers)),
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to query emails: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function handleEmailSend(
  args: z.infer<typeof EmailSendSchema>,
): Promise<CallToolResult> {
  const bearerToken = process.env.FASTMAIL_API_TOKEN;

  if (!bearerToken) {
    return {
      content: [
        {
          type: "text",
          text: "Error: FASTMAIL_API_TOKEN must be provided in MCP client configuration",
        },
      ],
      isError: true,
    };
  }

  try {
    const layers = sessionManager.getLayers(bearerToken);
    const accountId = await sessionManager.getAccountId(bearerToken);

    // Get identity (use provided ID or fetch default)
    const identity = args.identityId
      ? await (async () => {
          // If identityId is provided, fetch that specific identity
          const program = Effect.gen(function* () {
            const client = yield* JMAPClientService;
            const callId = `identity-get-${Date.now()}`;
            const methodCall: ["Identity/get", { accountId: string; ids: string[] }, string] = [
              "Identity/get",
              { accountId, ids: [args.identityId!] },
              callId
            ];
            const response = yield* client.batch([methodCall], [
              'urn:ietf:params:jmap:core',
              'urn:ietf:params:jmap:mail',
              'urn:ietf:params:jmap:submission'
            ]);
            const identityResponse = response.methodResponses.find(([method]) => method === "Identity/get");
            if (!identityResponse) {
              return yield* Effect.fail(new Error("Identity/get response not found"));
            }
            const [, data] = identityResponse;
            if (data.list && data.list.length > 0) {
              const identity = data.list[0];
              return { id: identity.id, email: identity.email, name: identity.name };
            }
            return yield* Effect.fail(new Error("Identity not found"));
          });
          return await Effect.runPromise(program.pipe(Effect.provide(layers)));
        })()
      : await getDefaultIdentity(accountId, layers);

    const identityId = identity.id;

    // Step 1: Build RFC 5322 email message
    const emailMessage = buildEmailMessage({
      identity,
      to: args.to,
      subject: args.subject,
      body: args.body,
      htmlBody: args.htmlBody,
    });

    // Step 2: Upload the email message as a blob
    const uploadResult = await uploadBlob(emailMessage, bearerToken, layers);

    // Step 3: Import the email into the Drafts mailbox
    const program = Effect.gen(function* () {
      const emailService = yield* EmailService;
      const submissionService = yield* EmailSubmissionService;

      // First, get the Drafts mailbox ID
      const mailboxService = yield* MailboxService;
      const mailboxes = yield* mailboxService.getAll(accountId);
      const draftsMailbox = mailboxes.find((mb) => mb.role === "drafts");

      if (!draftsMailbox) {
        return yield* Effect.fail(
          new Error("Drafts mailbox not found")
        );
      }

      // Import the email
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
        // Check if there are errors in notCreated
        if (importResult.notCreated) {
          const errors = Object.entries(importResult.notCreated).map(
            ([key, error]) => `${key}: ${JSON.stringify(error)}`
          );
          return yield* Effect.fail(
            new Error(`Failed to import email: ${errors.join(", ")}`)
          );
        }
        return yield* Effect.fail(
          new Error("Failed to import email: no created or notCreated field in response")
        );
      }

      // Get the created email ID
      const createdEmails = Object.values(importResult.created);
      if (createdEmails.length === 0) {
        return yield* Effect.fail(
          new Error(`No email was created. Import result: ${JSON.stringify(importResult)}`)
        );
      }

      const emailId = createdEmails[0].id;

      // Step 4: Send the email using EmailSubmission
      const submission = yield* submissionService.send(
        accountId,
        Common.createId(identityId),
        emailId
      );

      return submission;
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(layers)));

    return {
      content: [
        {
          type: "text",
          text: `Email sent successfully!\nSubmission ID: ${result.id}\nSent at: ${result.sendAt || "immediately"}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to send email: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Start the server
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Fastmail MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
