import { Hono } from "hono";
import { cors } from "hono/cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { registerTools } from "./tools.js";
import { setKVBinding } from "./cache.js";
import type { KVNamespace } from "@cloudflare/workers-types";

type Bindings = {
  SESSION_KV: KVNamespace;
};

const app = new Hono<{ Bindings: Bindings }>();

// CORS middleware
app.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Mcp-Session-Id", "Authorization"],
  }),
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
  setKVBinding(c.env.SESSION_KV);
  if (!mcpServer.isConnected()) {
    await mcpServer.connect(transport);
  }
  return transport.handleRequest(c);
});

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

export default app;
