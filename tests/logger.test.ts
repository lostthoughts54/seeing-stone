import { describe, expect, it } from "vitest";
import { redactText, sanitizeLogValue } from "../src/main/services/logger";

describe("logging redaction", () => {
  it("redacts tokenized URLs, authorization values, paths, and secret keys", () => {
    const text = redactText([
      "https://server/Videos/x?api_key=SECRET",
      'X-Emby-Authorization: MediaBrowser Client="LocalFirst Jellyfin", Device="Windows Desktop", Token="SECRET_TOKEN_SENTINEL"',
      "X-MediaBrowser-Token: TOKEN_SENTINEL",
      '{"Authorization":"Bearer JSON_SECRET_SENTINEL"}',
      '{"X-MediaBrowser-Token":"JSON_TOKEN_SENTINEL"}',
      '{"password":"JSON_PASSWORD_SENTINEL","deviceId":"JSON_DEVICE_SENTINEL"}',
      'MediaBrowser Client="Client", Token="STANDALONE_TOKEN_SENTINEL"',
      'DeviceId="STANDALONE_DEVICE_SENTINEL", Password="STANDALONE_PASSWORD_SENTINEL"',
      'D:\\Sensitive Folder\\Private Movie.mkv',
      'D:/Forward Slash Secret/Private Movie.mkv',
      'file:///D:/File URL Secret/Private Movie.mkv',
      '"D:\\Quoted Sensitive Folder\\Private Movie.mkv"',
      '\\\\server\\Private Share\\Private Movie.mkv',
    ].join("\n"));
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("TOKEN");
    expect(text).not.toContain("DEVICE_SENTINEL");
    expect(text).not.toContain("PASSWORD_SENTINEL");
    expect(text).not.toContain("Sensitive");
    expect(text).not.toContain("Private Movie");
    expect(text).not.toContain("Private Share");
    expect(text).not.toContain("Forward Slash Secret");
    expect(text).not.toContain("File URL Secret");
    expect(sanitizeLogValue({ accessToken: "SECRET", deviceId: "PRIVATE_DEVICE", nested: { password: "PW" }, safe: "ok" })).toEqual({
      accessToken: "[REDACTED]",
      deviceId: "[REDACTED]",
      nested: { password: "[REDACTED]" },
      safe: "ok",
    });
  });
});
