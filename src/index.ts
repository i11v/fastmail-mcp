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
import { HttpClient } from "@effect/platform";
import { NodeHttpClient } from "@effect/platform-node";
import {
  JMAPClientLive,
  JMAPClientService,
  defaultConfig,
  MailboxService,
  MailboxServiceLive,
  EmailService,
  EmailServiceLive,
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
    ),
    NodeHttpClient.layer,
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
