import { load } from "cheerio";

/**
 * Unescape JSON string escape sequences commonly found in JMAP body values.
 * JMAP returns HTML body content as JSON strings, so literal \n, \", \t etc.
 * must be converted to their real characters before HTML parsing.
 */
function unescapeJsonString(str: string): string {
  return str
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

/**
 * Sanitize email HTML using cheerio.
 * Strips scripts, styles, tracking pixels, hidden elements,
 * MSO conditional comments, and layout tables that produce noise.
 */
export function sanitizeEmailHtml(html: string): string {
  // Unescape JSON string escapes (JMAP body values are JSON strings)
  html = unescapeJsonString(html);

  // Strip MSO conditional comments: <!--[if ...]>...<![endif]-->
  // These contain <style> blocks and markup only relevant to Outlook
  html = html.replace(/<!--\[if[^\]]*\]>[\s\S]*?<!\[endif\]-->/gi, "");
  // Also handle the <![if !mso]> variant (non-comment form)
  html = html.replace(/<!\[if[^\]]*\]>/gi, "");
  html = html.replace(/<!--<!\[endif\]-->/gi, "");

  const $ = load(html);

  // Remove elements that should never appear in email text content
  $("script, style, noscript, iframe, object, embed, applet").remove();

  // Remove <head> content (meta tags, title) that leaks into output
  $("head").remove();

  // Remove hidden elements
  $("[style*='display:none'], [style*='display: none']").remove();
  $("[style*='visibility:hidden'], [style*='visibility: hidden']").remove();
  $("[hidden]").remove();

  // Remove tracking pixels (1x1 images or images with no meaningful src)
  $("img").each(function () {
    const width = $(this).attr("width");
    const height = $(this).attr("height");
    if ((width === "1" && height === "1") || (width === "0" && height === "0")) {
      $(this).remove();
    }
  });

  // Unwrap layout tables, keeping only data tables.
  // In email HTML, tables are almost exclusively used for layout.
  // A data table has <th> elements; everything else is layout.
  // Must iterate innermost-first so nested layout tables unwrap correctly.
  let changed = true;
  while (changed) {
    changed = false;
    $("table").each(function () {
      // Skip tables that contain nested tables — process inner ones first
      if ($(this).find("table").length > 0) return;

      const isDataTable =
        $(this).find("th").length > 0 ||
        $(this).attr("role") === "grid" ||
        $(this).attr("role") === "table";

      if (!isDataTable) {
        // Replace the table with the contents of its cells
        const cellContents: string[] = [];
        $(this)
          .find("td, th")
          .each(function () {
            const inner = $(this).html()?.trim();
            if (inner) cellContents.push(inner);
          });
        $(this).replaceWith(cellContents.join("\n"));
        changed = true;
      }
    });
  }

  // Remove all style attributes — they add noise and no value for text extraction
  $("[style]").removeAttr("style");

  // Remove presentational attributes that add no text value
  $("[class]").removeAttr("class");
  $("[bgcolor]").removeAttr("bgcolor");
  $("[align]").removeAttr("align");
  $("[valign]").removeAttr("valign");
  $("[cellpadding]").removeAttr("cellpadding");
  $("[cellspacing]").removeAttr("cellspacing");
  $("[border]").removeAttr("border");

  // Clean up leftover table wrapper elements
  $("tbody, thead, tfoot").each(function () {
    if ($(this).closest("table").length === 0) {
      $(this).replaceWith($(this).html() || "");
    }
  });
  $("tr").each(function () {
    if ($(this).closest("table").length === 0) {
      $(this).replaceWith($(this).html() || "");
    }
  });
  $("td, th").each(function () {
    if ($(this).closest("table").length === 0) {
      $(this).replaceWith($(this).html() || "");
    }
  });
  $("center").each(function () {
    $(this).replaceWith($(this).html() || "");
  });

  // Strip HTML comments
  let result = $.html();
  result = result.replace(/<!--[\s\S]*?-->/g, "");

  // Collapse runs of blank lines into a single blank line
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

/**
 * Get the body content from an email.
 * Prefers htmlBody (sanitized) for consistent output.
 * Falls back to textBody for plain-text emails.
 */
function getEmailBody(email: any): string {
  if (!email.bodyValues) return "";

  // Use htmlBody, sanitized for LLM consumption
  if (email.htmlBody && email.htmlBody.length > 0) {
    const htmlParts: string[] = [];
    for (const part of email.htmlBody) {
      const body = email.bodyValues[part.partId];
      if (body?.value) {
        htmlParts.push(body.value);
      }
    }
    if (htmlParts.length > 0) {
      return sanitizeEmailHtml(htmlParts.join("\n"));
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
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Format address list as XML nodes
 */
function formatAddressNodes(
  addresses: Array<{ name?: string; email: string }> | undefined,
  tagName: string,
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
function formatEmailXml(email: any): string {
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
  const body = getEmailBody(email);
  lines.push(`  <body>\n${body}\n  </body>`);

  lines.push("</email>");

  return lines.join("\n");
}

/**
 * Format emails into XML structure grouped by thread.
 * Sanitizes HTML bodies for cleaner LLM consumption.
 */
export function formatEmailsForLLM(emails: any[]): string {
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
    const emailTags = threadEmails.map(formatEmailXml);
    threadOutputs.push(`<thread id="${threadId}">\n${emailTags.join("\n")}\n</thread>`);
  }

  return threadOutputs.join("\n\n");
}
