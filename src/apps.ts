import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { getSession, runJMAPDirect } from "./tools.js";
import { formatEmailBody } from "./format.js";
import composeHtml from "../public/apps/compose.html";
import readEmailHtml from "../public/apps/read-email.html";

// --- Zod schemas ---

const ComposeEmailSchema = {
  to: z.string().optional().describe("Recipient email address(es), comma-separated"),
  cc: z.string().optional().describe("CC email address(es), comma-separated"),
  bcc: z.string().optional().describe("BCC email address(es), comma-separated"),
  subject: z.string().optional().describe("Email subject line"),
  body: z.string().optional().describe("Email body text"),
};

const ReadEmailSchema = {
  emailId: z.string().describe("The JMAP email ID to read"),
};

// --- Resource & tool registration ---

export function registerApps(server: McpServer) {
  // Register UI resources
  registerAppResource(server, "Compose Email", "ui://fastmail-mcp/compose", {}, async () => ({
    contents: [
      {
        uri: "ui://fastmail-mcp/compose",
        mimeType: RESOURCE_MIME_TYPE,
        text: composeHtml,
      },
    ],
  }));

  registerAppResource(server, "Read Email", "ui://fastmail-mcp/read-email", {}, async () => ({
    contents: [
      {
        uri: "ui://fastmail-mcp/read-email",
        mimeType: RESOURCE_MIME_TYPE,
        text: readEmailHtml,
      },
    ],
  }));

  // Register app-enabled tools
  registerAppTool(
    server,
    "compose_email",
    {
      title: "Compose Email",
      description:
        "Open an interactive email compose form. " +
        "Optionally pre-fill fields (to, cc, bcc, subject, body). " +
        "The form allows the user to edit and send or save as draft.",
      inputSchema: ComposeEmailSchema,
      annotations: { title: "Compose Email", openWorldHint: true },
      _meta: {
        ui: { resourceUri: "ui://fastmail-mcp/compose" },
      },
    },
    async (args) => {
      // Return the pre-fill data as structured content for the UI to consume
      const prefill: Record<string, string> = {};
      if (args.to) prefill.to = args.to;
      if (args.cc) prefill.cc = args.cc;
      if (args.bcc) prefill.bcc = args.bcc;
      if (args.subject) prefill.subject = args.subject;
      if (args.body) prefill.body = args.body;

      const text =
        Object.keys(prefill).length > 0
          ? `Opening compose form with pre-filled fields: ${Object.keys(prefill).join(", ")}`
          : "Opening compose form.";

      return {
        content: [
          { type: "text", text: JSON.stringify(prefill) },
          { type: "text", text },
        ],
        structuredContent: prefill,
      };
    },
  );

  registerAppTool(
    server,
    "read_email",
    {
      title: "Read Email",
      description:
        "Display the full content of an email in a rich reader view widget shown to the user. " +
        "Fetches the email by ID and renders it with headers, body, and action buttons (reply, forward). " +
        "The full email is displayed to the user as an interactive widget; " +
        "the assistant receives only a brief confirmation with metadata.",
      inputSchema: ReadEmailSchema,
      annotations: { title: "Read Email", readOnlyHint: true },
      _meta: {
        ui: { resourceUri: "ui://fastmail-mcp/read-email" },
      },
    },
    async (args, extra) => {
      try {
        const { session, bearerToken } = await getSession(extra);
        const result = await runJMAPDirect(
          [
            [
              "Email/get",
              {
                ids: [args.emailId],
                properties: [
                  "id",
                  "threadId",
                  "from",
                  "to",
                  "cc",
                  "bcc",
                  "replyTo",
                  "subject",
                  "receivedAt",
                  "sentAt",
                  "keywords",
                  "hasAttachment",
                  "htmlBody",
                  "textBody",
                  "bodyValues",
                ],
                fetchHTMLBodyValues: true,
                fetchTextBodyValues: true,
              },
              "get",
            ],
          ],
          session,
          bearerToken,
        );

        // Extract email from JMAP response
        const getResult = result[0] as [string, { list?: any[] }, string] | undefined;
        const email = getResult?.[1]?.list?.[0];

        if (!email) {
          return {
            content: [{ type: "text", text: `Error: Email with ID "${args.emailId}" not found.` }],
            isError: true,
          };
        }

        const body = formatEmailBody(email);

        const emailData = {
          id: email.id,
          threadId: email.threadId,
          from: email.from,
          to: email.to,
          cc: email.cc,
          bcc: email.bcc,
          replyTo: email.replyTo,
          subject: email.subject,
          receivedAt: email.receivedAt,
          sentAt: email.sentAt,
          keywords: email.keywords,
          hasAttachment: email.hasAttachment,
          htmlBody: body.html,
          textBody: body.text,
          body: body.content,
        };

        // structuredContent powers the widget; content text is a brief summary for the AI
        const from = email.from?.[0];
        const fromStr = from
          ? from.name
            ? `${from.name} <${from.email}>`
            : from.email
          : "unknown";
        const summary = [
          `Email displayed in widget.`,
          `From: ${fromStr}`,
          `Subject: ${email.subject ?? "(no subject)"}`,
          `Date: ${email.sentAt ?? email.receivedAt ?? "unknown"}`,
          email.hasAttachment ? "Has attachments." : "",
        ]
          .filter(Boolean)
          .join("\n");

        return {
          content: [{ type: "text", text: summary }],
          structuredContent: emailData,
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
    },
  );
}
