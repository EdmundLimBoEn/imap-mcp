import { describe, expect, it } from "vitest";
import { toSearchObject } from "../src/backend.js";

describe("IMAP search dates", () => {
  it.each(["since", "before"])("rejects invalid %s instead of losing the constraint", (field) => {
    for (const value of ["2026-99-99junk", "2026-01-01junk", "2026-01-01\n", "2026-02-29", "1900-02-29", "2026-04-31", ""]) {
      expect(() => toSearchObject({ from: "sender@example.com", [field]: value })).toThrow(/calendar-valid/);
    }
  });

  it("rejects inverted ranges", () => {
    expect(() => toSearchObject({ since: "2026-03-01", before: "2026-02-28" })).toThrow(/since/);
  });

  it("retains valid leap-day constraints as UTC dates", () => {
    expect(toSearchObject({ from: "sender@example.com", since: "2000-02-29", before: "2024-02-29" })).toEqual({
      from: "sender@example.com",
      since: new Date("2000-02-29T00:00:00.000Z"),
      before: new Date("2024-02-29T00:00:00.000Z"),
    });
  });
});
