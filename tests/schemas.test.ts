import { describe, expect, it } from "vitest";
import { loginSchema, playbackStartSchema, searchSchema } from "../src/shared/schemas";

describe("IPC input schemas", () => {
  it("rejects extra privileged-looking properties", () => {
    expect(() => loginSchema.strict().parse({
      serverUrl: "http://127.0.0.1:8096",
      username: "viewer",
      password: "secret",
      remember: true,
      headers: { Authorization: "token" },
    })).toThrow();
    expect(() => searchSchema.strict().parse({ query: "movie", path: "D:\\Sensitive" })).toThrow();
    expect(() => playbackStartSchema.strict().parse({ itemId: "item", resumeMode: "resume", args: ["--script"] })).toThrow();
  });
});
