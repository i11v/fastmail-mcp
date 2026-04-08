import { describe, it, expect } from "vitest";
import { ALLOWED_METHODS } from "../tools.js";

describe("ALLOWED_METHODS", () => {
  it("includes core JMAP methods", () => {
    expect(ALLOWED_METHODS.has("Email/query")).toBe(true);
    expect(ALLOWED_METHODS.has("Email/get")).toBe(true);
    expect(ALLOWED_METHODS.has("Email/set")).toBe(true);
    expect(ALLOWED_METHODS.has("Mailbox/get")).toBe(true);
    expect(ALLOWED_METHODS.has("EmailSubmission/set")).toBe(true);
  });

  it("rejects unknown methods", () => {
    expect(ALLOWED_METHODS.has("Evil/method")).toBe(false);
  });
});
