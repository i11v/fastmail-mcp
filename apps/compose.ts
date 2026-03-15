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

function parseAddresses(str: string) {
  if (!str) return [];
  return str.split(/[,;]\s*/).filter(Boolean).map((addr) => {
    const match = addr.match(/^(.+?)\s*<(.+?)>$/);
    if (match) return { name: match[1].trim(), email: match[2].trim() };
    return { email: addr.trim() };
  });
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

// Create App instance
const app = new App({ name: "Fastmail Compose", version: "1.0.0" });

// Register handlers before connecting
app.ontoolinput = (params) => {
  console.info("Received tool input:", params);
  const args = params.arguments as PrefillData | undefined;
  if (args) prefillForm(args);
};

app.ontoolresult = (result) => {
  console.info("Received tool result:", result);
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

// Save Draft
document.getElementById("save-draft-btn")!.addEventListener("click", async () => {
  const data = getFormData();
  if (!data.to) { showStatus("Please enter a recipient.", "error"); return; }
  try {
    await app.callServerTool({
      name: "execute",
      arguments: {
        methodCalls: [
          ["Email/set", {
            create: {
              draft: {
                to: parseAddresses(data.to),
                cc: parseAddresses(data.cc),
                bcc: parseAddresses(data.bcc),
                subject: data.subject,
                keywords: { "$draft": true },
                bodyValues: { body: { value: data.body, isEncodingProblem: false } },
                textBody: [{ partId: "body", type: "text/plain" }],
              },
            },
          }, "save"],
        ],
      },
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
    await app.callServerTool({
      name: "execute",
      arguments: {
        methodCalls: [
          ["Identity/get", {}, "id"],
          ["Email/set", {
            create: {
              msg: {
                to: parseAddresses(data.to),
                cc: parseAddresses(data.cc),
                bcc: parseAddresses(data.bcc),
                subject: data.subject,
                from: [{ "#resultOf": "id", "name": "Identity/get", "path": "/list/0/email" }],
                bodyValues: { body: { value: data.body, isEncodingProblem: false } },
                textBody: [{ partId: "body", type: "text/plain" }],
                mailboxIds: {},
              },
            },
          }, "create"],
          ["EmailSubmission/set", {
            create: {
              sub: {
                emailId: "#msg",
                identityId: { resultOf: "id", name: "Identity/get", path: "/list/0/id" },
              },
            },
          }, "send"],
        ],
        confirmed: true,
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
