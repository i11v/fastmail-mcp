import { describe, it, expect } from "vitest";
import { SKILL_FILES } from "../skill.js";

const EXPECTED_URIS = [
  "file:///fastmail-skill/SKILL.md",
  "file:///fastmail-skill/core/request-format.md",
  "file:///fastmail-skill/core/error-handling.md",
  "file:///fastmail-skill/email/querying.md",
  "file:///fastmail-skill/email/reading.md",
  "file:///fastmail-skill/email/writing.md",
  "file:///fastmail-skill/email/search.md",
  "file:///fastmail-skill/mailbox/overview.md",
  "file:///fastmail-skill/patterns/unread-inbox.md",
  "file:///fastmail-skill/patterns/move-archive.md",
  "file:///fastmail-skill/patterns/reply.md",
  "file:///fastmail-skill/sending/workflow.md",
  "file:///fastmail-skill/thread/overview.md",
] as const;

describe("SKILL_FILES", () => {
  it("contains the expected number of entries", () => {
    expect(SKILL_FILES).toHaveLength(EXPECTED_URIS.length);
  });

  it("registers every expected URI", () => {
    const uris = new Set(SKILL_FILES.map((f) => f.uri));
    for (const uri of EXPECTED_URIS) {
      expect(uris.has(uri)).toBe(true);
    }
  });

  it("has unique URIs and unique names", () => {
    const uris = new Set(SKILL_FILES.map((f) => f.uri));
    const names = new Set(SKILL_FILES.map((f) => f.name));
    expect(uris.size).toBe(SKILL_FILES.length);
    expect(names.size).toBe(SKILL_FILES.length);
  });
});

describe("SKILL_FILES metadata", () => {
  it("marks SKILL.md with priority 1.0", () => {
    const skillMd = SKILL_FILES.find((f) => f.name === "SKILL.md");
    expect(skillMd).toBeDefined();
    expect(skillMd?.priority).toBe(1.0);
  });

  it("marks every other file with priority 0.5", () => {
    for (const f of SKILL_FILES) {
      if (f.name === "SKILL.md") continue;
      expect(f.priority).toBe(0.5);
    }
  });

  it("has non-empty title and description on every file", () => {
    for (const f of SKILL_FILES) {
      expect(f.title.length).toBeGreaterThan(0);
      expect(f.description.length).toBeGreaterThan(0);
    }
  });
});
