import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { registerTools } from "./tools.js";

// AsyncLocalStorage for storing bearer token per request
export const tokenStorage = new AsyncLocalStorage<string>();

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
  // Extract bearer token from Authorization header
  const authHeader = c.req.header("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.substring(7)
    : undefined;

  if (!bearerToken) {
    return c.json(
      { error: "Missing or invalid Authorization header. Expected: Bearer <token>" },
      401
    );
  }

  if (!mcpServer.isConnected()) {
    await mcpServer.connect(transport);
  }

  // Run the request handler within AsyncLocalStorage context with the bearer token
  return tokenStorage.run(bearerToken, () => transport.handleRequest(c));
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
