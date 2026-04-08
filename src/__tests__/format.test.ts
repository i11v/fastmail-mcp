import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { sanitizeEmailHtml, cleanEmailHtmlForDisplay, formatEmailsForLLM } from "../format.js";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures");

/**
 * Load an HTML fixture by filename (without extension).
 */
function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, `${name}.html`), "utf-8");
}

/**
 * Get all HTML fixture names available in the fixtures directory.
 */
function getFixtureNames(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".html") && !f.includes(".step-"))
    .map((f) => basename(f, ".html"));
}

// ---------------------------------------------------------------------------
// sanitizeEmailHtml
// ---------------------------------------------------------------------------
describe("sanitizeEmailHtml", () => {
  it("strips <script> tags", () => {
    const html = `<div>Hello</div><script>alert('xss')</script>`;
    const result = sanitizeEmailHtml(html);
    expect(result).not.toContain("<script");
    expect(result).toContain("Hello");
  });

  it("strips <style> tags", () => {
    const html = `<style>body{color:red}</style><p>Text</p>`;
    const result = sanitizeEmailHtml(html);
    expect(result).not.toContain("<style");
    expect(result).toContain("Text");
  });

  it("removes hidden elements (display:none)", () => {
    const html = `<div style="display:none">Hidden</div><p>Visible</p>`;
    const result = sanitizeEmailHtml(html);
    expect(result).not.toContain("Hidden");
    expect(result).toContain("Visible");
  });

  it("removes hidden elements (display: none with space)", () => {
    const html = `<div style="display: none">Hidden</div><p>Visible</p>`;
    const result = sanitizeEmailHtml(html);
    expect(result).not.toContain("Hidden");
  });

  it("removes visibility:hidden elements", () => {
    const html = `<span style="visibility:hidden">Ghost</span><p>Real</p>`;
    const result = sanitizeEmailHtml(html);
    expect(result).not.toContain("Ghost");
  });

  it("removes elements with [hidden] attribute", () => {
    const html = `<div hidden>Secret</div><p>Public</p>`;
    const result = sanitizeEmailHtml(html);
    expect(result).not.toContain("Secret");
  });

  it("removes tracking pixels (1x1 images)", () => {
    const html = `<img width="1" height="1" src="https://track.example.com/px.gif"><p>Content</p>`;
    const result = sanitizeEmailHtml(html);
    expect(result).not.toContain("track.example.com");
    expect(result).toContain("Content");
  });

  it("removes 0x0 images", () => {
    const html = `<img width="0" height="0" src="https://spy.example.com"><p>OK</p>`;
    const result = sanitizeEmailHtml(html);
    expect(result).not.toContain("spy.example.com");
  });

  it("keeps normal images", () => {
    const html = `<img width="200" height="100" src="https://example.com/photo.jpg">`;
    const result = sanitizeEmailHtml(html);
    expect(result).toContain("photo.jpg");
  });

  it("removes iframes, objects, embeds", () => {
    const html = `<iframe src="https://evil.com"></iframe><object data="x"></object><embed src="y"><p>Safe</p>`;
    const result = sanitizeEmailHtml(html);
    expect(result).not.toContain("<iframe");
    expect(result).not.toContain("<object");
    expect(result).not.toContain("<embed");
    expect(result).toContain("Safe");
  });

  it("unescapes JSON string escapes", () => {
    const html = `<p>Line one\\nLine two</p>`;
    const result = sanitizeEmailHtml(html);
    expect(result).toContain("Line one\nLine two");
  });

  it("strips MSO conditional comments", () => {
    const html = `<!--[if mso]><style>.x{color:red}</style><![endif]--><p>Content</p>`;
    const result = sanitizeEmailHtml(html);
    expect(result).not.toContain("mso");
    expect(result).toContain("Content");
  });

  it("unwraps layout tables", () => {
    const html = `<table><tr><td>Cell content</td></tr></table>`;
    const result = sanitizeEmailHtml(html);
    expect(result).not.toContain("<table");
    expect(result).toContain("Cell content");
  });

  it("preserves data tables (with <th>)", () => {
    const html = `<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>A</td><td>1</td></tr></tbody></table>`;
    const result = sanitizeEmailHtml(html);
    expect(result).toContain("<table");
    expect(result).toContain("Name");
  });
});

// ---------------------------------------------------------------------------
// cleanEmailHtmlForDisplay
// ---------------------------------------------------------------------------
describe("cleanEmailHtmlForDisplay", () => {
  it("removes tracking pixels (1x1)", () => {
    const html = `<img width="1" height="1" src="https://track.example.com/px.gif"><p>Content</p>`;
    const result = cleanEmailHtmlForDisplay(html);
    expect(result).not.toContain("track.example.com");
    expect(result).toContain("Content");
  });

  it("removes tracking pixels (0x0)", () => {
    const html = `<img width="0" height="0" src="https://spy.example.com"><p>OK</p>`;
    const result = cleanEmailHtmlForDisplay(html);
    expect(result).not.toContain("spy.example.com");
  });

  it("strips MSO conditional comments", () => {
    const html = `<!--[if mso]><style>.x{color:red}</style><![endif]--><p>Content</p>`;
    const result = cleanEmailHtmlForDisplay(html);
    expect(result).not.toContain("mso");
    expect(result).toContain("Content");
  });

  it("preserves <style> tags", () => {
    const html = `<html><head><style>.foo{color:red}</style><title>X</title></head><body><p>Text</p></body></html>`;
    const result = cleanEmailHtmlForDisplay(html);
    expect(result).toContain("<style>");
    expect(result).toContain(".foo{color:red}");
  });

  it("preserves inline styles", () => {
    const html = `<div style="color: red; font-size: 16px;">Styled</div>`;
    const result = cleanEmailHtmlForDisplay(html);
    expect(result).toContain('style="color: red; font-size: 16px;"');
    expect(result).toContain("Styled");
  });

  it("preserves classes", () => {
    const html = `<div class="container main"><p class="text">Hello</p></div>`;
    const result = cleanEmailHtmlForDisplay(html);
    expect(result).toContain('class="container main"');
    expect(result).toContain('class="text"');
  });

  it("preserves tables and layout structure", () => {
    const html = `<table><tr><td style="padding:10px">Cell</td></tr></table>`;
    const result = cleanEmailHtmlForDisplay(html);
    expect(result).toContain("<table>");
    expect(result).toContain("<td");
    expect(result).toContain("padding:10px");
  });

  it("removes <meta> and <title> from head but keeps <style>", () => {
    const html = `<html><head><meta charset="UTF-8"><title>Email</title><style>body{margin:0}</style></head><body><p>Body</p></body></html>`;
    const result = cleanEmailHtmlForDisplay(html);
    expect(result).not.toContain("<title>");
    expect(result).not.toContain("<meta");
    expect(result).toContain("<style>");
    expect(result).toContain("body{margin:0}");
    expect(result).toContain("Body");
  });

  it("keeps normal images", () => {
    const html = `<img width="200" height="100" src="https://example.com/photo.jpg">`;
    const result = cleanEmailHtmlForDisplay(html);
    expect(result).toContain("photo.jpg");
  });

  it("unescapes JSON string escapes", () => {
    const html = `<p>Line one\\nLine two</p>`;
    const result = cleanEmailHtmlForDisplay(html);
    expect(result).toContain("Line one\nLine two");
  });

  it("strips scripts", () => {
    const html = `<div>Hello</div><script>alert('x')</script>`;
    const result = cleanEmailHtmlForDisplay(html);
    expect(result).not.toContain("<script");
    expect(result).toContain("Hello");
  });
});

// ---------------------------------------------------------------------------
// cleanEmailHtmlForDisplay — fixture-based snapshot tests
// ---------------------------------------------------------------------------
describe("cleanEmailHtmlForDisplay fixtures", () => {
  const names = getFixtureNames();

  describe.runIf(names.length > 0).each(names)("%s", (name) => {
    let html: string;
    let cleaned: string;

    beforeAll(() => {
      html = loadFixture(name);
      cleaned = cleanEmailHtmlForDisplay(html);
    });

    it("cleaned HTML for display", () => {
      expect(cleaned).toMatchSnapshot();
    });

    it("removes tracking pixels", () => {
      expect(cleaned).not.toMatch(/width="1"[^>]*height="1"/i);
      expect(cleaned).not.toMatch(/width="0"[^>]*height="0"/i);
    });

    it("preserves inline styles when present in source", () => {
      // If the original had inline styles, they should still be present
      const sourceHasStyles = /style="/.test(html);
      const cleanedHasStyles = /style="/.test(cleaned);
      // Cleaned output should never strip inline styles
      expect(!sourceHasStyles || cleanedHasStyles).toBe(true);
    });

    it("cleaned output is non-empty", () => {
      expect(cleaned.trim().length).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// formatEmailsForLLM
// ---------------------------------------------------------------------------
describe("formatEmailsForLLM", () => {
  it("formats a plain-text email", () => {
    const emails = [
      {
        id: "msg-1",
        threadId: "thread-1",
        from: [{ name: "Alice", email: "alice@example.com" }],
        to: [{ email: "bob@example.com" }],
        subject: "Hello Bob",
        receivedAt: "2025-01-15T10:00:00Z",
        textBody: [{ partId: "1" }],
        bodyValues: { "1": { value: "Hi Bob, how are you?" } },
      },
    ];

    const output = formatEmailsForLLM(emails);
    expect(output).toContain('<thread id="thread-1">');
    expect(output).toContain('id="msg-1"');
    expect(output).toContain("alice@example.com");
    expect(output).toContain("Hello Bob");
    expect(output).toContain("Hi Bob, how are you?");
  });

  it("sanitizes HTML body", () => {
    const emails = [
      {
        id: "msg-2",
        threadId: "thread-2",
        from: [{ email: "sender@example.com" }],
        subject: "HTML Email",
        receivedAt: "2025-01-15T12:00:00Z",
        htmlBody: [{ partId: "1" }],
        bodyValues: {
          "1": {
            value:
              '<h1>Important</h1><p>Please <a href="https://example.com">click here</a></p><script>alert("xss")</script>',
          },
        },
      },
    ];

    const output = formatEmailsForLLM(emails);
    expect(output).toContain("Important");
    expect(output).toContain("click here");
    expect(output).toContain("https://example.com");
    expect(output).not.toContain("<script");
  });
});

// ---------------------------------------------------------------------------
// Fixture-based tests — real email HTML files
//
// Each fixture produces snapshots for each pipeline step:
//   - {name} > sanitized HTML
//   - {name} > formatEmailsForLLM
// ---------------------------------------------------------------------------
describe("real email fixtures", () => {
  const names = getFixtureNames();

  describe.runIf(names.length > 0).each(names)("%s", (name) => {
    let html: string;
    let sanitized: string;
    let llmOutput: string;

    beforeAll(() => {
      html = loadFixture(name);
      sanitized = sanitizeEmailHtml(html);

      const emails = [
        {
          id: `fixture-${name}`,
          threadId: `thread-${name}`,
          from: [{ email: "test@example.com" }],
          subject: `Fixture: ${name}`,
          receivedAt: "2025-01-01T00:00:00Z",
          htmlBody: [{ partId: "1" }],
          bodyValues: { "1": { value: html } },
        },
      ];
      llmOutput = formatEmailsForLLM(emails);
    });

    it("sanitized HTML", () => {
      expect(sanitized).toMatchSnapshot();
    });

    it("formatEmailsForLLM", () => {
      expect(llmOutput).toMatchSnapshot();
    });

    it("sanitize removes scripts and styles", () => {
      expect(sanitized).not.toMatch(/<script[\s>]/i);
      expect(sanitized).not.toMatch(/<style[\s>]/i);
    });

    it("sanitize removes tracking pixels", () => {
      expect(sanitized).not.toMatch(/width="1"[^>]*height="1"/i);
      expect(sanitized).not.toMatch(/width="0"[^>]*height="0"/i);
    });

    it("sanitized output is non-empty", () => {
      expect(sanitized.trim().length).toBeGreaterThan(0);
    });
  });
});
