import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import skillMd from "../fastmail-skill/SKILL.md";
import coreRequestFormat from "../fastmail-skill/core/request-format.md";
import coreErrorHandling from "../fastmail-skill/core/error-handling.md";
import emailQuerying from "../fastmail-skill/email/querying.md";
import emailReading from "../fastmail-skill/email/reading.md";
import emailWriting from "../fastmail-skill/email/writing.md";
import emailSearch from "../fastmail-skill/email/search.md";
import mailboxOverview from "../fastmail-skill/mailbox/overview.md";
import patternsUnreadInbox from "../fastmail-skill/patterns/unread-inbox.md";
import patternsMoveArchive from "../fastmail-skill/patterns/move-archive.md";
import patternsReply from "../fastmail-skill/patterns/reply.md";
import sendingWorkflow from "../fastmail-skill/sending/workflow.md";
import threadOverview from "../fastmail-skill/thread/overview.md";

export interface SkillFile {
  /** Resource URI, e.g. "file:///fastmail-skill/email/querying.md". */
  uri: string;
  /** Unique, machine-friendly name. Full relative path so basename collisions are avoided. */
  name: string;
  /** Human-readable label. */
  title: string;
  /** One-line purpose. */
  description: string;
  /** Markdown body. */
  content: string;
  /** MCP annotation. 1.0 for SKILL.md, 0.5 for references. */
  priority: number;
}

export const SKILL_FILES: readonly SkillFile[] = [
  {
    uri: "file:///fastmail-skill/SKILL.md",
    name: "SKILL.md",
    title: "Fastmail Skill (entry point)",
    description: "JMAP methods, rules, and UI tools. Start here.",
    content: skillMd,
    priority: 1.0,
  },
  {
    uri: "file:///fastmail-skill/core/request-format.md",
    name: "core/request-format.md",
    title: "Core: request format",
    description: "Method-call triples, back-references, callId rules.",
    content: coreRequestFormat,
    priority: 0.5,
  },
  {
    uri: "file:///fastmail-skill/core/error-handling.md",
    name: "core/error-handling.md",
    title: "Core: error handling",
    description: "How JMAP errors surface and how to recover.",
    content: coreErrorHandling,
    priority: 0.5,
  },
  {
    uri: "file:///fastmail-skill/email/querying.md",
    name: "email/querying.md",
    title: "Email: querying",
    description: "Filter and sort emails with Email/query.",
    content: emailQuerying,
    priority: 0.5,
  },
  {
    uri: "file:///fastmail-skill/email/reading.md",
    name: "email/reading.md",
    title: "Email: reading",
    description: "Fetch email content with Email/get.",
    content: emailReading,
    priority: 0.5,
  },
  {
    uri: "file:///fastmail-skill/email/writing.md",
    name: "email/writing.md",
    title: "Email: writing",
    description: "Create drafts, update flags, move, delete.",
    content: emailWriting,
    priority: 0.5,
  },
  {
    uri: "file:///fastmail-skill/email/search.md",
    name: "email/search.md",
    title: "Email: search",
    description: "Full-text search highlights via SearchSnippet/get.",
    content: emailSearch,
    priority: 0.5,
  },
  {
    uri: "file:///fastmail-skill/mailbox/overview.md",
    name: "mailbox/overview.md",
    title: "Mailbox: overview",
    description: "List, find, create, update, and delete mailboxes.",
    content: mailboxOverview,
    priority: 0.5,
  },
  {
    uri: "file:///fastmail-skill/patterns/unread-inbox.md",
    name: "patterns/unread-inbox.md",
    title: "Pattern: unread inbox",
    description: "Show unread messages in the inbox.",
    content: patternsUnreadInbox,
    priority: 0.5,
  },
  {
    uri: "file:///fastmail-skill/patterns/move-archive.md",
    name: "patterns/move-archive.md",
    title: "Pattern: move / archive",
    description: "Move or archive emails between mailboxes.",
    content: patternsMoveArchive,
    priority: 0.5,
  },
  {
    uri: "file:///fastmail-skill/patterns/reply.md",
    name: "patterns/reply.md",
    title: "Pattern: reply",
    description: "Compose a reply to an existing email.",
    content: patternsReply,
    priority: 0.5,
  },
  {
    uri: "file:///fastmail-skill/sending/workflow.md",
    name: "sending/workflow.md",
    title: "Sending: workflow",
    description: "End-to-end flow for sending via EmailSubmission/set.",
    content: sendingWorkflow,
    priority: 0.5,
  },
  {
    uri: "file:///fastmail-skill/thread/overview.md",
    name: "thread/overview.md",
    title: "Thread: overview",
    description: "Fetch conversation threads with Thread/get.",
    content: threadOverview,
    priority: 0.5,
  },
];

export function registerSkillResources(_server: McpServer): void {
  // Filled in by Task 5.
}
