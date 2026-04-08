import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

interface PrefillData {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
}

interface SenderContext {
  draftsMailboxId: string;
  identity: { id: string; name: string; email: string };
}

function showStatus(message: string, type: "error" | "success") {
  const el = document.getElementById("status")!;
  el.textContent = message;
  el.className = `status ${type}`;
}

function getFormData() {
  return {
    to: (document.getElementById("to") as HTMLInputElement).value.trim(),
    cc: (document.getElementById("cc") as HTMLInputElement).value.trim(),
    bcc: (document.getElementById("bcc") as HTMLInputElement).value.trim(),
    subject: (document.getElementById("subject") as HTMLInputElement).value.trim(),
    body: (document.getElementById("body") as HTMLTextAreaElement).value,
  };
}

function prefillForm(data: PrefillData) {
  if (data.to) (document.getElementById("to") as HTMLInputElement).value = data.to;
  if (data.cc) {
    (document.getElementById("cc") as HTMLInputElement).value = data.cc;
    document.getElementById("cc-bcc-fields")!.classList.remove("hidden");
  }
  if (data.bcc) {
    (document.getElementById("bcc") as HTMLInputElement).value = data.bcc;
    document.getElementById("cc-bcc-fields")!.classList.remove("hidden");
  }
  if (data.subject) (document.getElementById("subject") as HTMLInputElement).value = data.subject;
  if (data.body) (document.getElementById("body") as HTMLTextAreaElement).value = data.body;
}

function extractPrefill(result: CallToolResult): PrefillData {
  const sc = result.structuredContent as PrefillData | undefined;
  if (sc && Object.keys(sc).length > 0) return sc;

  for (const block of result.content ?? []) {
    if (block.type === "text" && block.text) {
      try {
        return JSON.parse(block.text) as PrefillData;
      } catch { /* ignore */ }
    }
  }
  return {};
}

function applyHostContext(ctx: McpUiHostContext) {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

/** Parse comma/semicolon-separated addresses into JMAP EmailAddress objects. */
function parseAddresses(str: string): { name?: string; email: string }[] {
  if (!str) return [];
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of str) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if ((ch === "," || ch === ";") && !inQuotes) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean).map((addr) => {
    const match = addr.match(/^"?(.+?)"?\s*<(.+?)>$/);
    if (match) return { name: match[1].trim(), email: match[2].trim() };
    return { email: addr.trim() };
  });
}

/** Call execute to look up drafts mailbox and sender identity. */
async function fetchSenderContext(app: App): Promise<SenderContext> {
  const result = await app.callServerTool({
    name: "execute",
    arguments: {
      methodCalls: [
        ["Mailbox/query", { filter: { role: "drafts" }, limit: 1 }, "mbox"],
        ["Identity/get", {}, "ident"],
      ],
    },
  });

  const text = result.content?.find((b: any) => b.type === "text")?.text;
  if (!text) throw new Error("Empty response from execute");
  const responses = JSON.parse(text);

  const mboxIds = responses[0]?.[1]?.ids;
  if (!mboxIds?.[0]) throw new Error("Could not find Drafts mailbox");

  const identList = responses[1]?.[1]?.list;
  if (!identList?.[0]) throw new Error("Could not find sender identity");

  const ident = identList[0];
  return {
    draftsMailboxId: mboxIds[0],
    identity: { id: ident.id, name: ident.name ?? "", email: ident.email },
  };
}

function buildEmailCreate(
  data: ReturnType<typeof getFormData>,
  ctx: SenderContext,
  creationId: string,
): Record<string, Record<string, unknown>> {
  return {
    [creationId]: {
      mailboxIds: { [ctx.draftsMailboxId]: true },
      keywords: { $draft: true, $seen: true },
      from: [{ name: ctx.identity.name, email: ctx.identity.email }],
      to: parseAddresses(data.to),
      cc: parseAddresses(data.cc),
      bcc: parseAddresses(data.bcc),
      subject: data.subject || "",
      bodyStructure: { type: "text/plain", partId: "body" },
      bodyValues: { body: { value: data.body || "" } },
    },
  };
}

// Create App instance
const app = new App({ name: "Fastmail Compose", version: "1.0.0" });
let senderCtx: SenderContext | null = null;

// Register handlers before connecting
app.ontoolinput = (params) => {
  const args = params.arguments as PrefillData | undefined;
  if (args) prefillForm(args);
};

app.ontoolresult = (result) => {
  prefillForm(extractPrefill(result));
};

app.onerror = (err) => console.error("App error:", err);
app.onhostcontextchanged = applyHostContext;
app.onteardown = async () => ({});

// CC/BCC toggle
document.getElementById("toggle-cc-bcc-btn")!.addEventListener("click", () => {
  const fields = document.getElementById("cc-bcc-fields")!;
  fields.classList.toggle("hidden");
  const btn = document.getElementById("toggle-cc-bcc-btn")!;
  btn.textContent = fields.classList.contains("hidden") ? "Show CC/BCC" : "Hide CC/BCC";
});

async function ensureSenderContext(): Promise<SenderContext> {
  if (!senderCtx) senderCtx = await fetchSenderContext(app);
  return senderCtx;
}

// Save Draft
document.getElementById("save-draft-btn")!.addEventListener("click", async () => {
  const data = getFormData();
  try {
    const ctx = await ensureSenderContext();
    const create = buildEmailCreate(data, ctx, "draft");
    await app.callServerTool({
      name: "execute",
      arguments: { methodCalls: [["Email/set", { create }, "create"]] },
    });
    showStatus("Draft saved.", "success");
  } catch (err) {
    showStatus(`Failed to save draft: ${err instanceof Error ? err.message : err}`, "error");
  }
});

// Send Email
document.getElementById("send-btn")!.addEventListener("click", async () => {
  const data = getFormData();
  if (!data.to) { showStatus("Please enter a recipient.", "error"); return; }
  if (!data.subject && !data.body) { showStatus("Please enter a subject or body.", "error"); return; }
  try {
    const ctx = await ensureSenderContext();
    const create = buildEmailCreate(data, ctx, "msg");
    await app.callServerTool({
      name: "execute",
      arguments: {
        methodCalls: [
          ["Email/set", { create }, "create"],
          [
            "EmailSubmission/set",
            {
              create: {
                sub: {
                  "#emailId": { resultOf: "create", name: "Email/set", path: "/created/msg/id" },
                  identityId: ctx.identity.id,
                },
              },
            },
            "submit",
          ],
        ],
      },
    });
    showStatus("Email sent.", "success");
    app.sendMessage({
      role: "user",
      content: [{ type: "text", text: `Email sent to ${data.to} with subject: ${data.subject}` }],
    });
  } catch (err) {
    showStatus(`Failed to send: ${err instanceof Error ? err.message : err}`, "error");
  }
});

// Connect to host
app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) applyHostContext(ctx);
});
