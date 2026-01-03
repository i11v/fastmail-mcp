import { Hono } from "hono";
import { cors } from "hono/cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { serve } from "@hono/node-server";
import { registerTools } from "./tools.js";

const app = new Hono();

// CORS middleware
app.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Mcp-Session-Id"],
  })
);

// Create MCP server
const mcpServer = new McpServer({
  name: "fastmail-mcp",
  version: "1.0.0",
});

// Register tools
registerTools(mcpServer);

// Transport
const transport = new StreamableHTTPTransport();

// MCP endpoint
app.all("/mcp", async (c) => {
  if (!mcpServer.isConnected()) {
    await mcpServer.connect(transport);
  }
  return transport.handleRequest(c);
});

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// Root - server info
app.get("/", (c) =>
  c.json({
    name: "fastmail-mcp",
    version: "1.0.0",
    endpoints: { mcp: "/mcp", health: "/health" },
  })
);

// Local development server
const port = parseInt(process.env.PORT || "3000", 10);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Fastmail MCP server running on http://localhost:${info.port}`);
  console.log(`MCP endpoint: http://localhost:${info.port}/mcp`);
});

export default app;
