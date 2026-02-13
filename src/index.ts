import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { registerTools } from "./tools.js";
import { registerPrompts } from "./prompts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");
const landingHtml = readFileSync(join(publicDir, "landing.html"), "utf-8");

const app = new Hono();

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

// Register tools and prompts
registerTools(mcpServer);
registerPrompts(mcpServer);

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

// Root - landing page with setup instructions
app.get("/", (c) => c.html(landingHtml));

// Local development server (only when not on Vercel)
if (!process.env.VERCEL) {
  const { serve } = await import("@hono/node-server");
  const port = parseInt(process.env.PORT || "3000", 10);
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`Fastmail MCP server running on http://localhost:${info.port}`);
    console.log(`MCP endpoint: http://localhost:${info.port}/mcp`);
  });
}

export default app;
