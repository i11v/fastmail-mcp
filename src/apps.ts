import { SpanStatusCode } from "@opentelemetry/api";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { getSession, runJMAPDirect, JMAPHttpError } from "./tools.js";
import { formatEmailBody } from "./format.js";
import { getTracer, forceFlush } from "./tracing.js";
import { recordEvent } from "./observability.js";
import { hashToken } from "./utils.js";
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

// --- Handlers ---

export async function readEmailHandler(
  args: { emailId: string },
  extra: RequestHandlerExtra<any, any>,
): Promise<CallToolResult> {
  const span = getTracer().startSpan("tool:read_email");
  span.setAttribute("mcp.tool", "read_email");
  span.setAttribute("email.id", args.emailId);
  try {
    const { session, bearerToken } = await getSession(extra, span);
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
      span,
    );

    // Extract email from JMAP response
    const getResult = result[0] as [string, { list?: any[] }, string] | undefined;
    const email = getResult?.[1]?.list?.[0];

    if (!email) {
      span.setAttribute("email.found", false);
      span.setAttribute("mcp.outcome", "error");
      span.setAttribute("error.class", "not_found");
      recordEvent(span, "read_email.not_found", { emailId: args.emailId });
      return {
        content: [{ type: "text", text: `Error: Email with ID "${args.emailId}" not found.` }],
        isError: true,
      };
    }

    span.setAttribute("email.found", true);

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
    const fromStr = from ? (from.name ? `${from.name} <${from.email}>` : from.email) : "unknown";
    const summary = [
      `Email displayed in widget.`,
      `From: ${fromStr}`,
      `Subject: ${email.subject ?? "(no subject)"}`,
      `Date: ${email.sentAt ?? email.receivedAt ?? "unknown"}`,
      email.hasAttachment ? "Has attachments." : "",
    ]
      .filter(Boolean)
      .join("\n");

    span.setAttribute("mcp.outcome", "success");
    return {
      content: [{ type: "text", text: summary }],
      structuredContent: emailData,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Classify before the noisy `alsoLog` so routine upstream failures
    // (Fastmail 5xx → JMAPHttpError) don't spam Workers Logs. Parity with
    // executeHandler's error-class taxonomy.
    const errorClass: "jmap_http" | "unknown" =
      error instanceof JMAPHttpError ? "jmap_http" : "unknown";
    span.setAttribute("mcp.outcome", "error");
    span.setAttribute("error.class", errorClass);
    span.recordException(error as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message });
    if (errorClass === "unknown") {
      // JMAPHttpError already emitted jmap.http_error on the child span; no
      // need to log again here.
      recordEvent(span, "read_email.unexpected_error", { message }, { alsoLog: true });
    }
    return {
      content: [
        {
          type: "text",
          text: `Error: ${message}`,
        },
      ],
      isError: true,
    };
  } finally {
    span.end();
    await forceFlush();
  }
}

export async function composeEmailHandler(
  args: {
    to?: string;
    cc?: string;
    bcc?: string;
    subject?: string;
    body?: string;
  },
  extra: RequestHandlerExtra<any, any>,
): Promise<CallToolResult> {
  const span = getTracer().startSpan("tool:compose_email");
  span.setAttribute("mcp.tool", "compose_email");
  try {
    // Best-effort user.id — do not fail the UI handoff if auth is missing.
    const authHeader =
      extra.requestInfo?.headers?.["authorization"] ||
      extra.requestInfo?.headers?.["Authorization"];
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      span.setAttribute("user.id", hashToken(authHeader.substring(7)));
    }

    const prefill: Record<string, string> = {};
    if (args.to) prefill.to = args.to;
    if (args.cc) prefill.cc = args.cc;
    if (args.bcc) prefill.bcc = args.bcc;
    if (args.subject) prefill.subject = args.subject;
    if (args.body) prefill.body = args.body;

    const prefillFields = Object.keys(prefill);
    span.setAttribute("mcp.prefill_fields", prefillFields);

    const text =
      prefillFields.length > 0
        ? `Opening compose form with pre-filled fields: ${prefillFields.join(", ")}`
        : "Opening compose form.";

    span.setAttribute("mcp.outcome", "success");
    return {
      content: [
        { type: "text", text: JSON.stringify(prefill) },
        { type: "text", text },
      ],
      structuredContent: prefill,
    };
  } finally {
    span.end();
    await forceFlush();
  }
}

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
    composeEmailHandler,
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
    readEmailHandler,
  );
}
