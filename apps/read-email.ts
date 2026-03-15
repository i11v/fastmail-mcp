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
    bodyEl.innerHTML = data.htmlBody;
  } else if (data.textBody) {
    bodyEl.innerHTML = `<pre>${escapeHtml(data.textBody)}</pre>`;
  } else if (data.body) {
    if (/<[a-z][\s\S]*>/i.test(data.body)) {
      bodyEl.innerHTML = data.body;
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

app.onhostcontextchanged = applyHostContext;

app.onteardown = async () => ({ });

// Action buttons
document.getElementById("reply-btn")!.addEventListener("click", () => {
  if (!emailData) return;
  const replyTo = emailData.replyTo || emailData.from;
  app.sendMessage({
    role: "user",
    content: [{
      type: "text",
      text: `Reply to this email from ${formatAddress(replyTo)} with subject: Re: ${emailData.subject || ""}`,
    }],
  });
});

document.getElementById("reply-all-btn")!.addEventListener("click", () => {
  if (!emailData) return;
  const replyTo = emailData.replyTo || emailData.from;
  const recipients = [formatAddress(replyTo)];
  if (emailData.to) recipients.push(formatAddress(emailData.to));
  if (emailData.cc) recipients.push(formatAddress(emailData.cc));
  app.sendMessage({
    role: "user",
    content: [{
      type: "text",
      text: `Reply all to this email. Recipients: ${recipients.join(", ")} with subject: Re: ${emailData.subject || ""}`,
    }],
  });
});

document.getElementById("forward-btn")!.addEventListener("click", () => {
  if (!emailData) return;
  app.sendMessage({
    role: "user",
    content: [{
      type: "text",
      text: `Forward this email with subject: Fwd: ${emailData.subject || ""}`,
    }],
  });
});

// Connect to host
app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) applyHostContext(ctx);
});
