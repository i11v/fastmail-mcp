import { load } from "cheerio";
import { unified } from "unified";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";

// HTML to Markdown converter using rehype-remark with GFM support for tables
const htmlToMarkdownProcessor = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeRemark)
  .use(remarkGfm)
  .use(remarkStringify);

/**
 * Sanitize email HTML using cheerio before Markdown conversion.
 * Strips scripts, styles, tracking pixels, and hidden elements
 * that produce noise in the converted output.
 */
function sanitizeEmailHtml(html: string): string {
  const $ = load(html);

  // Remove elements that should never appear in email text content
  $("script, style, noscript, iframe, object, embed, applet").remove();

  // Remove hidden elements
  $("[style*='display:none'], [style*='display: none']").remove();
  $("[style*='visibility:hidden'], [style*='visibility: hidden']").remove();
  $('[hidden]').remove();

  // Remove tracking pixels (1x1 images or images with no meaningful src)
  $("img").each(function () {
    const width = $(this).attr("width");
    const height = $(this).attr("height");
    if (
      (width === "1" && height === "1") ||
      (width === "0" && height === "0")
    ) {
      $(this).remove();
    }
  });

  return $.html();
}

/**
 * Convert HTML string to Markdown, with cheerio sanitization as a preprocessing step.
 */
async function htmlToMarkdown(html: string): Promise<string> {
  const sanitized = sanitizeEmailHtml(html);
  const result = await htmlToMarkdownProcessor.process(sanitized);
  return String(result);
}

/**
 * Extract plain text from HTML using cheerio. Used as a fallback
 * when the full Markdown conversion pipeline fails.
 */
function htmlToText(html: string): string {
  const $ = load(html);
  $("script, style, noscript").remove();
  return $("body").text().trim() || $.root().text().trim();
}

/**
 * Get the body content from an email.
 * Prefers htmlBody (converted to Markdown) for consistent output.
 * Concatenates all body parts if multiple exist.
 */
async function getEmailBody(email: any): Promise<string> {
  if (!email.bodyValues) return "";

  // Use htmlBody and convert to Markdown
  if (email.htmlBody && email.htmlBody.length > 0) {
    const htmlParts: string[] = [];
    for (const part of email.htmlBody) {
      const body = email.bodyValues[part.partId];
      if (body?.value) {
        htmlParts.push(body.value);
      }
    }
    if (htmlParts.length > 0) {
      const combinedHtml = htmlParts.join("\n");
      try {
        return (await htmlToMarkdown(combinedHtml)).trim();
      } catch {
        // Fall back to plain text extraction instead of returning raw HTML
        return htmlToText(combinedHtml);
      }
    }
  }

  // Fall back to textBody if no htmlBody
  if (email.textBody && email.textBody.length > 0) {
    const textParts: string[] = [];
    for (const part of email.textBody) {
      const body = email.bodyValues[part.partId];
      if (body?.value) {
        textParts.push(body.value);
      }
    }
    if (textParts.length > 0) {
      return textParts.join("\n").trim();
    }
  }

  return "";
}

/**
 * Escape XML attribute value
 */
function escapeXmlAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Escape XML text content
 */
function escapeXmlText(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Format address list as XML nodes
 */
function formatAddressNodes(
  addresses: Array<{ name?: string; email: string }> | undefined,
  tagName: string
): string | null {
  if (!addresses || addresses.length === 0) return null;

  const addressTags = addresses.map((addr) => {
    const nameAttr = addr.name ? ` name="${escapeXmlAttr(addr.name)}"` : "";
    return `    <address${nameAttr} email="${escapeXmlAttr(addr.email)}" />`;
  });

  return `  <${tagName}>\n${addressTags.join("\n")}\n  </${tagName}>`;
}

/**
 * Format a single email as XML
 */
async function formatEmailXml(email: any): Promise<string> {
  const lines: string[] = [];

  // Email opening tag with core attributes
  const attrs: string[] = [`id="${escapeXmlAttr(email.id)}"`];

  if (email.receivedAt) {
    attrs.push(`date="${new Date(email.receivedAt).toISOString()}"`);
  } else if (email.sentAt) {
    attrs.push(`date="${new Date(email.sentAt).toISOString()}"`);
  }

  const flags: string[] = [];
  if (!email.keywords?.$seen) flags.push("unread");
  if (email.keywords?.$flagged) flags.push("flagged");
  if (email.keywords?.$answered) flags.push("replied");
  if (email.keywords?.$draft) flags.push("draft");
  if (flags.length > 0) attrs.push(`status="${flags.join(", ")}"`);

  if (email.hasAttachment) attrs.push(`attachments="yes"`);

  lines.push(`<email ${attrs.join(" ")}>`);

  // Address fields per RFC 8621
  const fromNodes = formatAddressNodes(email.from, "from");
  if (fromNodes) lines.push(fromNodes);

  const toNodes = formatAddressNodes(email.to, "to");
  if (toNodes) lines.push(toNodes);

  const ccNodes = formatAddressNodes(email.cc, "cc");
  if (ccNodes) lines.push(ccNodes);

  const bccNodes = formatAddressNodes(email.bcc, "bcc");
  if (bccNodes) lines.push(bccNodes);

  const replyToNodes = formatAddressNodes(email.replyTo, "reply_to");
  if (replyToNodes) lines.push(replyToNodes);

  const senderNodes = formatAddressNodes(email.sender, "sender");
  if (senderNodes) lines.push(senderNodes);

  // Subject
  if (email.subject) {
    lines.push(`  <subject>${escapeXmlText(email.subject)}</subject>`);
  }

  // Body
  const body = await getEmailBody(email);
  lines.push(`  <body>\n${body}\n  </body>`);

  lines.push("</email>");

  return lines.join("\n");
}

/**
 * Format emails into XML structure grouped by thread.
 * Converts HTML bodies to Markdown for cleaner LLM consumption.
 */
export async function formatEmailsForLLM(emails: any[]): Promise<string> {
  // Group emails by threadId
  const threads = new Map<string, any[]>();

  for (const email of emails) {
    const threadId = email.threadId || email.id;
    if (!threads.has(threadId)) {
      threads.set(threadId, []);
    }
    threads.get(threadId)!.push(email);
  }

  // Sort emails within each thread by date (oldest first)
  for (const threadEmails of threads.values()) {
    threadEmails.sort((a, b) => {
      const dateA = new Date(a.receivedAt || a.sentAt || 0).getTime();
      const dateB = new Date(b.receivedAt || b.sentAt || 0).getTime();
      return dateA - dateB;
    });
  }

  // Format each thread
  const threadOutputs: string[] = [];

  for (const [threadId, threadEmails] of threads) {
    const emailTags = await Promise.all(threadEmails.map(formatEmailXml));
    threadOutputs.push(`<thread id="${threadId}">\n${emailTags.join("\n")}\n</thread>`);
  }

  return threadOutputs.join("\n\n");
}
