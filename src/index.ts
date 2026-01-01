#!/usr/bin/env node

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

import {
  mailboxGet,
  emailGet,
  emailQuery,
  emailSend,
  EmailGetSchema,
  EmailQuerySchema,
  EmailSendSchema,
} from "./tools.js";

const PORT = parseInt(process.env.PORT || "3000", 10);

/**
 * Create and configure the MCP server
 */
function createMcpServer(): Server {
  const server = new Server(
    {
      name: "fastmail-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "mailbox_get",
        description: "Get all mailboxes using JMAP Mailbox/get method",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "email_get",
        description: "Get specific emails by their IDs",
        inputSchema: {
          type: "object",
          properties: {
            accountId: { type: "string", description: "Account ID (optional)" },
            emailIds: {
              type: "array",
              items: { type: "string" },
              description: "Array of email IDs",
            },
            properties: {
              type: "array",
              items: { type: "string" },
              description: "Properties to fetch",
            },
            fetchTextBodyValues: { type: "boolean" },
            fetchHTMLBodyValues: { type: "boolean" },
            fetchAllBodyValues: { type: "boolean" },
            maxBodyValueBytes: { type: "number" },
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
            mailboxId: { type: "string" },
            limit: { type: "number", minimum: 1, maximum: 100, default: 10 },
            from: { type: "string" },
            to: { type: "string" },
            subject: { type: "string" },
            hasKeyword: { type: "string" },
            notKeyword: { type: "string" },
            before: { type: "string" },
            after: { type: "string" },
            sort: {
              type: "string",
              enum: ["receivedAt", "sentAt", "subject", "from"],
            },
            ascending: { type: "boolean" },
          },
        },
      },
      {
        name: "email_send",
        description: "Send an email via Fastmail",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string", description: "Recipient email" },
            subject: { type: "string", description: "Email subject" },
            body: { type: "string", description: "Plain text body" },
            htmlBody: { type: "string", description: "HTML body (optional)" },
            identityId: { type: "string", description: "Identity ID (optional)" },
          },
          required: ["to", "subject", "body"],
        },
      },
    ] satisfies Tool[],
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "mailbox_get": {
          const result = await mailboxGet();
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }
        case "email_get": {
          const result = await emailGet(EmailGetSchema.parse(args));
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }
        case "email_query": {
          const result = await emailQuery(EmailQuerySchema.parse(args));
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }
        case "email_send": {
          const result = await emailSend(EmailSendSchema.parse(args));
          return {
            content: [
              {
                type: "text",
                text: `Email sent successfully!\nSubmission ID: ${result.id}\nSent at: ${result.sendAt}`,
              },
            ],
          };
        }
        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
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
  });

  return server;
}

// Map to store transports by session ID
const transports = new Map<string, StreamableHTTPServerTransport>();

/**
 * Handle MCP requests
 */
async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // Handle POST requests for JSON-RPC
  if (req.method === "POST") {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      // Reuse existing transport for session
      transport = transports.get(sessionId)!;
    } else {
      // Create new transport
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        },
      });

      // Connect MCP server to transport
      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);

      // Clean up on close
      transport.onclose = () => {
        const id = (transport as any).sessionId;
        if (id) transports.delete(id);
      };
    }

    // Handle the request
    await transport.handleRequest(req, res);
    return;
  }

  // Handle GET requests for SSE streams
  if (req.method === "GET") {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Session ID required for GET requests" }));
    return;
  }

  // Handle DELETE for session cleanup
  if (req.method === "DELETE") {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.close();
      transports.delete(sessionId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "session closed" }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Session not found" }));
    return;
  }

  // Method not allowed
  res.writeHead(405, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Method not allowed" }));
}

/**
 * Send JSON response
 */
function jsonResponse(
  res: ServerResponse,
  status: number,
  data: unknown
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * Main HTTP server
 */
const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  try {
    // MCP endpoint
    if (url.pathname === "/mcp") {
      await handleMcpRequest(req, res);
      return;
    }

    // Health check
    if (url.pathname === "/health") {
      jsonResponse(res, 200, { status: "ok" });
      return;
    }

    // Root - server info
    if (url.pathname === "/") {
      jsonResponse(res, 200, {
        name: "fastmail-mcp-server",
        version: "1.0.0",
        endpoints: {
          mcp: "/mcp",
          health: "/health",
        },
      });
      return;
    }

    // 404 for unknown routes
    jsonResponse(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("Request error:", error);
    jsonResponse(res, 500, {
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

// Start server
server.listen(PORT, () => {
  console.log(`Fastmail MCP server running on http://localhost:${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});
