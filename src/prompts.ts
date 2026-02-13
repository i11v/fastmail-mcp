import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Register all prompts with the MCP server
 */
export function registerPrompts(server: McpServer) {
  // Prompt: Inbox Summary
  server.prompt(
    "inbox-summary",
    "Get a summary of unread emails in your inbox",
    async () => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Please help me get a summary of my unread emails.

First, use the mailbox_get tool to find my Inbox folder and get its mailbox ID.

Then, use the email_query tool to find unread emails by:
- Setting the mailboxId to the Inbox ID
- Using notKeyword: "$seen" to filter for unread emails
- Limiting to 20 emails
- Sorting by receivedAt (newest first)

Finally, use the email_get tool to fetch the details of those emails, and provide me with a concise summary including:
- Total number of unread emails
- A brief overview of each email (sender, subject, and a one-line preview)
- Any emails that appear urgent or time-sensitive`,
            },
          },
        ],
      };
    }
  );

  // Prompt: Compose Email
  server.prompt(
    "compose-email",
    "Draft a new email to send",
    {
      to: z.string().describe("Recipient email address"),
      subject: z.string().describe("Email subject line"),
      context: z.string().optional().describe("Additional context or key points to include"),
    },
    async (args) => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Please help me compose and send an email.

Recipient: ${args.to}
Subject: ${args.subject}
${args.context ? `Context/Key Points: ${args.context}` : ""}

Please draft a professional email with the given subject. Once I approve the content, use the email_send tool to send it with:
- to: ${args.to}
- subject: ${args.subject}
- body: [the plain text version]
- htmlBody: [an optional HTML version for better formatting]

Please show me the draft first before sending.`,
            },
          },
        ],
      };
    }
  );

  // Prompt: Search Emails
  server.prompt(
    "search-emails",
    "Find emails matching specific criteria",
    {
      query: z.string().describe("What to search for (e.g., 'from:john about invoices')"),
      timeframe: z.string().optional().describe("Time range (e.g., 'last week', 'past month')"),
    },
    async (args) => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Please help me search for emails matching: "${args.query}"${args.timeframe ? ` within ${args.timeframe}` : ""}.

Use the email_query tool to search with appropriate filters:
- Parse the query to extract: sender (from:), recipient (to:), subject keywords
- ${args.timeframe ? `Apply date filters for ${args.timeframe}` : "No specific date range"}
- Limit to 25 results
- Sort by receivedAt (newest first)

Then use email_get to fetch the matching emails and present them as a list with:
- Sender and date
- Subject
- Brief preview of content

Highlight any patterns or group related emails if applicable.`,
            },
          },
        ],
      };
    }
  );

  // Prompt: Email Digest
  server.prompt(
    "email-digest",
    "Get a digest of recent emails",
    {
      period: z.enum(["today", "yesterday", "this-week", "last-week"]).default("today").describe("Time period for the digest"),
      folder: z.string().optional().describe("Specific folder to digest (default: all)"),
    },
    async (args) => {
      const periodDescriptions: Record<string, string> = {
        today: "today",
        yesterday: "yesterday",
        "this-week": "this week",
        "last-week": "last week",
      };

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Please create an email digest for ${periodDescriptions[args.period] || args.period}.

${args.folder ? `Focus on the "${args.folder}" folder.` : "Include all folders."}

Steps:
1. ${args.folder ? `Use mailbox_get to find the "${args.folder}" folder ID` : "Use mailbox_get to list all folders"}
2. Use email_query with date filters for ${periodDescriptions[args.period]}:
   - For "today": after = today's date at midnight
   - For "yesterday": after = yesterday at midnight, before = today at midnight
   - For "this-week": after = start of current week
   - For "last-week": after = start of last week, before = start of current week
3. Fetch email details with email_get
4. Create a structured digest with:
   - Summary statistics (total emails, by folder/sender)
   - Emails grouped by category (if identifiable) or sender
   - Action items or emails requiring response
   - Newsletters and automated emails (separate section)`,
            },
          },
        ],
      };
    }
  );

  // Prompt: Reply Draft
  server.prompt(
    "reply-draft",
    "Draft a reply to a specific email",
    {
      emailId: z.string().describe("The ID of the email to reply to"),
      tone: z.enum(["professional", "friendly", "brief", "detailed"]).default("professional").describe("Tone for the reply"),
      keyPoints: z.string().optional().describe("Key points to address in the reply"),
    },
    async (args) => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Please help me draft a reply to an email.

First, use email_get to fetch the original email with ID: ${args.emailId}
Make sure to include the full body content.

Then, draft a ${args.tone} reply that:
- Addresses the main points of the original email
${args.keyPoints ? `- Incorporates these key points: ${args.keyPoints}` : ""}
- Maintains appropriate greeting and sign-off
- Includes "Re: [original subject]" as the subject

Show me the draft for review. When approved, use email_send to send with:
- to: [original sender's email]
- subject: Re: [original subject]
- body: [the reply text]`,
            },
          },
        ],
      };
    }
  );

  // Prompt: Folder Overview
  server.prompt(
    "folder-overview",
    "Get an overview of your email folders and their contents",
    async () => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Please provide an overview of my email folders.

Use the mailbox_get tool to retrieve all folders.

Present the information as:
1. A summary of all folders with:
   - Folder name and role (inbox, sent, drafts, etc.)
   - Total email count
   - Unread email count
2. Identify folders that need attention (high unread count)
3. Show the folder hierarchy/structure if there are nested folders

This helps me understand my email organization and identify areas needing attention.`,
            },
          },
        ],
      };
    }
  );

  // Prompt: Cleanup Suggestions
  server.prompt(
    "cleanup-suggestions",
    "Get suggestions for cleaning up your mailbox",
    {
      folder: z.string().optional().describe("Specific folder to analyze (default: Inbox)"),
    },
    async (args) => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Please analyze my ${args.folder || "Inbox"} and suggest cleanup actions.

Steps:
1. Use mailbox_get to find the ${args.folder || "Inbox"} folder
2. Use email_query to fetch recent emails (last 100)
3. Analyze and identify:
   - Newsletters or automated emails that could be unsubscribed
   - Old emails (> 30 days) that might be archived
   - Emails from unknown or potentially spam senders
   - Large email threads that could be summarized
   - Duplicate or similar emails

Present cleanup suggestions organized by category, with specific counts and examples.
Note: This is for analysis only - no emails will be deleted without explicit confirmation.`,
            },
          },
        ],
      };
    }
  );
}
