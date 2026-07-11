import { describe, expect, it } from "vitest";
import { redactText, sanitizeLogValue } from "../src/main/services/logger";

describe("logging redaction", () => {
  it("redacts tokenized URLs, authorization values, paths, and secret keys", () => {
    const text = redactText("https://server/Videos/x?api_key=SECRET X-MediaBrowser-Token: TOKEN D:\\Sensitive\\movie.mkv");
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("TOKEN");
    expect(text).not.toContain("Sensitive");
    expect(sanitizeLogValue({ accessToken: "SECRET", nested: { password: "PW" }, safe: "ok" })).toEqual({
      accessToken: "[REDACTED]",
      nested: { password: "[REDACTED]" },
      safe: "ok",
    });
  });
});
