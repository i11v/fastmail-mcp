// Side-effect import: must be first to initialize OTEL before other modules
import "./tracing.js"; // eslint-disable-line import/no-unassigned-import
import { Hono } from "hono";
import { cors } from "hono/cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { registerTools } from "./tools.js";
import { registerApps } from "./apps.js";
import { registerSkillResources } from "./skill.js";
import landingHtml from "../public/landing.html";

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

// Register tools and MCP Apps
registerTools(mcpServer);
registerApps(mcpServer);
registerSkillResources(mcpServer);

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

export default app;
