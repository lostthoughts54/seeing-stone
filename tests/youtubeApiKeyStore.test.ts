import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YouTubeApiKeyStore } from "../src/main/services/youtubeApiKeyStore";
const directories: string[] = [];
const key = "test_youtube_key_1234567890";
const protector = () => ({ isAvailable: vi.fn(async () => true), encrypt: vi.fn(async (text: string) => Buffer.from(text).reverse()), decrypt: vi.fn(async (bytes: Buffer) => ({ result: Buffer.from(bytes).reverse().toString(), shouldReEncrypt: false })) });
afterEach(async () => { for (const directory of directories.splice(0)) { if (!directory.startsWith(join(tmpdir(), "youtube-key-test-"))) throw new Error("Unexpected cleanup path"); await rm(directory, { recursive: true, force: true }); } });
async function directory() { const value = await mkdtemp(join(tmpdir(), "youtube-key-test-")); directories.push(value); return value; }
describe("YouTube API key storage", () => {
  it("protects the key on disk, restores it, and returns only configuration status", async () => {
    const path = await directory(); const protection = protector();
    const store = new YouTubeApiKeyStore(path, protection, () => "");
    await store.load(); expect(store.getStatus().configured).toBe(false);
    expect(await store.setKey(key)).toEqual({ configured: true, source: "saved", storageUnavailable: false });
    expect(protection.encrypt).toHaveBeenCalledWith(key);
    expect((await readFile(join(path, "youtube-api-key.safe"))).toString()).not.toContain(key);
    expect(JSON.stringify(store.getStatus())).not.toContain(key);
    const restored = new YouTubeApiKeyStore(path, protection, () => ""); await restored.load();
    expect(restored.getKey()).toBe(key);
    await restored.setKey("");
    expect(restored.getStatus().configured).toBe(false);
    await expect(readFile(join(path, "youtube-api-key.safe"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("keeps the previous key when protected storage fails", async () => {
    const path = await directory(); const protection = protector();
    const store = new YouTubeApiKeyStore(path, protection, () => "");
    await store.setKey(key);
    const before = await readFile(join(path, "youtube-api-key.safe"));
    protection.encrypt.mockRejectedValueOnce(new Error("Sensitive internals"));
    await expect(store.setKey("replacement_api_key_1234567890")).rejects.toMatchObject({ code: "YOUTUBE_KEY_STORAGE" });
    expect(store.getKey()).toBe(key); expect(await readFile(join(path, "youtube-api-key.safe"))).toEqual(before);
  });
  it("reports unreadable protected storage and preserves the ciphertext", async () => {
    const path = await directory(); const protection = protector();
    const store = new YouTubeApiKeyStore(path, protection, () => ""); await store.setKey(key);
    protection.isAvailable.mockResolvedValue(false);
    const restored = new YouTubeApiKeyStore(path, protection, () => ""); await restored.load();
    expect(restored.getStatus()).toEqual({ configured: false, source: "none", storageUnavailable: true });
    expect((await readFile(join(path, "youtube-api-key.safe"))).length).toBeGreaterThan(0);
  });
  it("uses saved keys before environment keys, and falls back after removal", async () => {
    const store = new YouTubeApiKeyStore(await directory(), protector(), () => "environment_key_123456789");
    expect(store.getStatus().source).toBe("environment");
    await store.setKey(key); expect(store.getKey()).toBe(key);
    await store.setKey(""); expect(store.getKey()).toBe("environment_key_123456789");
    await expect(store.setKey("bad key")).rejects.toThrow();
  });
});
