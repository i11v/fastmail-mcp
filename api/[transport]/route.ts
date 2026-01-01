import { createMcpHandler } from "@vercel/mcp-adapter";
import {
  mailboxGet,
  emailGet,
  emailQuery,
  emailSend,
  EmailGetSchema,
  EmailQuerySchema,
  EmailSendSchema,
} from "#tools";

const handler = createMcpHandler(
  (server) => {
    // Tool: Get all mailboxes
    server.tool(
      "mailbox_get",
      "Get all mailboxes using JMAP Mailbox/get method",
      async () => {
        try {
          const result = await mailboxGet();
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
      }
    );

    // Tool: Get emails by ID
    server.tool(
      "email_get",
      "Get specific emails by their IDs",
      {
        accountId: EmailGetSchema.shape.accountId,
        emailIds: EmailGetSchema.shape.emailIds,
        properties: EmailGetSchema.shape.properties,
        fetchTextBodyValues: EmailGetSchema.shape.fetchTextBodyValues,
        fetchHTMLBodyValues: EmailGetSchema.shape.fetchHTMLBodyValues,
        fetchAllBodyValues: EmailGetSchema.shape.fetchAllBodyValues,
        maxBodyValueBytes: EmailGetSchema.shape.maxBodyValueBytes,
      },
      async (args) => {
        try {
          const result = await emailGet(EmailGetSchema.parse(args));
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
      }
    );

    // Tool: Query emails
    server.tool(
      "email_query",
      "Query emails with filters and sorting",
      {
        accountId: EmailQuerySchema.shape.accountId,
        mailboxId: EmailQuerySchema.shape.mailboxId,
        limit: EmailQuerySchema.shape.limit,
        from: EmailQuerySchema.shape.from,
        to: EmailQuerySchema.shape.to,
        subject: EmailQuerySchema.shape.subject,
        hasKeyword: EmailQuerySchema.shape.hasKeyword,
        notKeyword: EmailQuerySchema.shape.notKeyword,
        before: EmailQuerySchema.shape.before,
        after: EmailQuerySchema.shape.after,
        sort: EmailQuerySchema.shape.sort,
        ascending: EmailQuerySchema.shape.ascending,
      },
      async (args) => {
        try {
          const result = await emailQuery(EmailQuerySchema.parse(args));
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
      }
    );

    // Tool: Send email
    server.tool(
      "email_send",
      "Send an email via Fastmail. Supports plain text, HTML, or multipart/alternative (both) emails.",
      {
        to: EmailSendSchema.shape.to,
        subject: EmailSendSchema.shape.subject,
        body: EmailSendSchema.shape.body,
        htmlBody: EmailSendSchema.shape.htmlBody,
        identityId: EmailSendSchema.shape.identityId,
      },
      async (args) => {
        try {
          const result = await emailSend(EmailSendSchema.parse(args));
          return {
            content: [
              {
                type: "text",
                text: `Email sent successfully!\nSubmission ID: ${result.id}\nSent at: ${result.sendAt}`,
              },
            ],
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
      }
    );
  },
  {
    capabilities: { tools: {} },
  },
  {
    maxDuration: 60,
    basePath: "/api",
  }
);

export { handler as GET, handler as POST };
