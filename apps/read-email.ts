import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

interface EmailData {
  id?: string;
  threadId?: string;
  from?: Array<{ name?: string; email: string }>;
  to?: Array<{ name?: string; email: string }>;
  cc?: Array<{ name?: string; email: string }>;
  replyTo?: Array<{ name?: string; email: string }>;
  subject?: string;
  receivedAt?: string;
  sentAt?: string;
  keywords?: Record<string, boolean>;
  hasAttachment?: boolean;
  htmlBody?: string;
  textBody?: string;
  body?: string;
}

let emailData: EmailData | null = null;

function formatAddress(addr: unknown): string {
  if (!addr) return "";
  if (Array.isArray(addr)) return addr.map(formatAddress).join(", ");
  const a = addr as { name?: string; email?: string };
  if (a.name) return `${a.name} <${a.email}>`;
  return a.email || String(addr);
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return "";
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      weekday: "short", year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function isDarkMode(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function buildSrcdoc(emailHtml: string, dark: boolean): string {
  const darkCss = dark
    ? `
      html, body {
        background: #1a1a1a !important;
        color: #e0e0e0 !important;
      }
      img { opacity: 0.9; }
    `
    : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <base target="_blank">
  <style>
    html, body {
      margin: 0;
      padding: 0;
      overflow: auto;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      line-height: 1.6;
      word-break: break-word;
      overflow-wrap: break-word;
    }
    img { max-width: 100%; height: auto; }
    table { max-width: 100% !important; }
    ${darkCss}
  </style>
</head>
<body>${emailHtml}</body>
</html>`;
}

function renderBodyInIframe(container: HTMLElement, html: string) {
  const iframe = document.createElement("iframe");
  // Bare sandbox: no allow-scripts, no allow-same-origin.
  // Scripts are stripped server-side; the iframe is fully inert.
  iframe.setAttribute("sandbox", "");
  iframe.style.width = "100%";
  iframe.style.height = "600px";
  iframe.style.border = "none";
  iframe.style.display = "block";

  const srcdoc = buildSrcdoc(html, isDarkMode());
  iframe.setAttribute("srcdoc", srcdoc);

  container.innerHTML = "";
  container.appendChild(iframe);
}

function addBadge(container: HTMLElement, cls: string, text: string) {
  const el = document.createElement("span");
  el.className = `badge ${cls}`;
  el.textContent = text;
  container.appendChild(el);
}

function renderEmail(data: EmailData) {
  emailData = data;
  document.getElementById("loading")!.style.display = "none";
  document.getElementById("email")!.style.display = "";

  document.getElementById("subject")!.textContent = data.subject || "(no subject)";
  document.getElementById("from")!.textContent = formatAddress(data.from);
  document.getElementById("to")!.textContent = formatAddress(data.to);

  if (data.cc && data.cc.length > 0) {
    document.getElementById("cc-row")!.style.display = "";
    document.getElementById("cc")!.textContent = formatAddress(data.cc);
  }

  document.getElementById("date")!.textContent = formatDate(data.receivedAt || data.sentAt);

  const badgesEl = document.getElementById("badges")!;
  badgesEl.innerHTML = "";
  if (data.keywords) {
    if (!data.keywords["$seen"]) addBadge(badgesEl, "unread", "Unread");
    if (data.keywords["$flagged"]) addBadge(badgesEl, "flagged", "Flagged");
    if (data.keywords["$draft"]) addBadge(badgesEl, "draft", "Draft");
  }
  if (data.hasAttachment) addBadge(badgesEl, "attachment", "Attachment");

  const bodyEl = document.getElementById("body")!;
  if (data.htmlBody) {
    renderBodyInIframe(bodyEl, data.htmlBody);
  } else if (data.textBody) {
    bodyEl.innerHTML = `<pre>${escapeHtml(data.textBody)}</pre>`;
  } else if (data.body) {
    if (/<[a-z][\s\S]*>/i.test(data.body)) {
      renderBodyInIframe(bodyEl, data.body);
    } else {
      bodyEl.innerHTML = `<pre>${escapeHtml(data.body)}</pre>`;
    }
  } else {
    bodyEl.textContent = "(empty message)";
  }
}

function extractEmailData(result: CallToolResult): EmailData | null {
  // Prefer structuredContent
  const sc = result.structuredContent as EmailData | undefined;
  if (sc && (sc.subject || sc.from)) return sc;

  // Fallback: parse content text blocks
  for (const block of result.content ?? []) {
    if (block.type === "text" && block.text) {
      try {
        return JSON.parse(block.text) as EmailData;
      } catch { /* ignore */ }
    }
  }
  return null;
}

function applyHostContext(ctx: McpUiHostContext) {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

// Create App instance
const app = new App({ name: "Fastmail Reader", version: "1.0.0" });

// Register handlers before connecting
app.ontoolinput = (params) => {
  // Tool input only has arguments (emailId) — not useful for rendering yet
  console.info("Received tool input:", params);
};

app.ontoolresult = (result) => {
  console.info("Received tool result:", result);
  const data = extractEmailData(result);
  if (data) {
    renderEmail(data);
  } else {
    document.getElementById("loading")!.style.display = "none";
    const errorEl = document.getElementById("error")!;
    errorEl.style.display = "";
    errorEl.textContent = "Failed to load email data.";
  }
};

app.ontoolcancelled = () => {
  document.getElementById("loading")!.textContent = "Cancelled.";
};

app.onerror = (err) => {
  console.error("App error:", err);
};

app.onhostcontextchanged = (ctx) => {
  applyHostContext(ctx);
  // Re-render iframe body with updated theme
  if (emailData) {
    const bodyEl = document.getElementById("body");
    const htmlContent = emailData.htmlBody || (emailData.body && /<[a-z][\s\S]*>/i.test(emailData.body) ? emailData.body : null);
    if (bodyEl && htmlContent) {
      renderBodyInIframe(bodyEl, htmlContent);
    }
  }
};

app.onteardown = async () => ({ });

function getEmailBodyText(): string {
  if (!emailData) return "";
  return emailData.textBody || emailData.body || "";
}

function buildEmailContext(): string {
  if (!emailData) return "";
  const lines: string[] = [];
  lines.push(`From: ${formatAddress(emailData.from)}`);
  if (emailData.to) lines.push(`To: ${formatAddress(emailData.to)}`);
  if (emailData.cc) lines.push(`CC: ${formatAddress(emailData.cc)}`);
  lines.push(`Date: ${formatDate(emailData.receivedAt || emailData.sentAt)}`);
  lines.push(`Subject: ${emailData.subject || "(no subject)"}`);
  lines.push("");
  lines.push(getEmailBodyText());
  return lines.join("\n");
}

// Action buttons
document.getElementById("reply-btn")!.addEventListener("click", () => {
  if (!emailData) return;
  const replyTo = formatAddress(emailData.replyTo || emailData.from);
  app.sendMessage({
    role: "user",
    content: [{
      type: "text",
      text: `Draft a reply to this email and open it in compose_email with to="${replyTo}" and subject="Re: ${emailData.subject || ""}". Write the reply body for me based on the original message below.\n\n--- Original message ---\n${buildEmailContext()}`,
    }],
  });
});

document.getElementById("reply-all-btn")!.addEventListener("click", () => {
  if (!emailData) return;
  const replyTo = formatAddress(emailData.replyTo || emailData.from);
  const to = replyTo;
  const cc = [
    ...(emailData.to || []),
    ...(emailData.cc || []),
  ].map(a => formatAddress(a)).filter(Boolean).join(", ");
  app.sendMessage({
    role: "user",
    content: [{
      type: "text",
      text: `Draft a reply-all to this email and open it in compose_email with to="${to}", cc="${cc}", and subject="Re: ${emailData.subject || ""}". Write the reply body for me based on the original message below.\n\n--- Original message ---\n${buildEmailContext()}`,
    }],
  });
});

document.getElementById("forward-btn")!.addEventListener("click", () => {
  if (!emailData) return;
  app.sendMessage({
    role: "user",
    content: [{
      type: "text",
      text: `Forward this email using compose_email with subject="Fwd: ${emailData.subject || ""}" and the original message quoted in the body. Leave the "to" field empty for me to fill in.\n\n--- Original message ---\n${buildEmailContext()}`,
    }],
  });
});

// Connect to host
app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) applyHostContext(ctx);
});
