import { describe, it, expect } from "vitest";
import { parseAddresses } from "../tools.js";

describe("parseAddresses", () => {
  it("returns empty array for empty string", () => {
    expect(parseAddresses("")).toEqual([]);
  });

  it("parses a simple email address", () => {
    expect(parseAddresses("a@b.com")).toEqual([{ email: "a@b.com" }]);
  });

  it("parses name + email in angle brackets", () => {
    expect(parseAddresses("Alice <a@b.com>")).toEqual([{ name: "Alice", email: "a@b.com" }]);
  });

  it("parses comma-separated addresses", () => {
    expect(parseAddresses("a@b.com, c@d.com")).toEqual([
      { email: "a@b.com" },
      { email: "c@d.com" },
    ]);
  });

  it("parses semicolon-separated addresses", () => {
    expect(parseAddresses("a@b.com; c@d.com")).toEqual([
      { email: "a@b.com" },
      { email: "c@d.com" },
    ]);
  });

  it("parses mixed names and bare emails", () => {
    expect(parseAddresses("Alice <a@b.com>, c@d.com")).toEqual([
      { name: "Alice", email: "a@b.com" },
      { email: "c@d.com" },
    ]);
  });

  it("trims whitespace from addresses", () => {
    expect(parseAddresses("  a@b.com  ")).toEqual([{ email: "a@b.com" }]);
  });

  it("trims whitespace from name and email in brackets", () => {
    expect(parseAddresses("  Alice   <  a@b.com  >")).toEqual([
      { name: "Alice", email: "a@b.com" },
    ]);
  });

  it("handles quoted display names with commas", () => {
    expect(parseAddresses('"Doe, John" <john@example.com>, alice@example.com')).toEqual([
      { name: "Doe, John", email: "john@example.com" },
      { email: "alice@example.com" },
    ]);
  });

  it("handles quoted display names with semicolons", () => {
    expect(parseAddresses('"Smith; Jr" <jr@example.com>; bob@example.com')).toEqual([
      { name: "Smith; Jr", email: "jr@example.com" },
      { email: "bob@example.com" },
    ]);
  });
});
