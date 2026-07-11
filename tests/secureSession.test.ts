import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SecureSessionStore, type SessionProtector, type StoredSession } from "../src/main/services/secureSession";

const session: StoredSession = {
  serverUrl: "http://127.0.0.1:8096",
  serverId: "server-id",
  serverName: "Test Server",
  serverVersion: "10.11.11",
  userId: "user-id",
  userName: "Viewer",
  accessToken: "SECRET_TOKEN_SENTINEL",
};

function protector(available = true): SessionProtector {
  return {
    async isAvailable() { return available; },
    async encrypt(value) { return Buffer.from(`protected:${Buffer.from(value).toString("base64")}`); },
    async decrypt(value) {
      const encoded = value.toString().replace(/^protected:/, "");
      return { result: Buffer.from(encoded, "base64").toString(), shouldReEncrypt: false };
    },
  };
}

describe("SecureSessionStore", () => {
  it("persists only protected bytes and restores the session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lf-session-"));
    const store = new SecureSessionStore(directory, protector());
    expect(await store.save(session, true)).toBe("protected");
    const bytes = await readFile(join(directory, "session.safe"));
    expect(bytes.toString()).not.toContain(session.accessToken);

    const restored = new SecureSessionStore(directory, protector());
    expect(await restored.restore()).toEqual(session);
    expect(restored.getPersistence()).toBe("protected");
  });

  it("uses memory only and creates no credential file when protection is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lf-session-"));
    const store = new SecureSessionStore(directory, protector(false));
    expect(await store.save(session, true)).toBe("memory-only");
    await expect(stat(join(directory, "session.safe"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(store.getMemory()).toEqual(session);
  });

  it("never falls back to plaintext when encryption fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lf-session-"));
    const failing: SessionProtector = {
      async isAvailable() { return true; },
      async encrypt() { throw new Error("unavailable"); },
      async decrypt() { throw new Error("unavailable"); },
    };
    const store = new SecureSessionStore(directory, failing);
    expect(await store.save(session, true)).toBe("memory-only");
    await expect(stat(join(directory, "session.safe"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves ciphertext when decryption is temporarily unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lf-session-"));
    const credentialPath = join(directory, "session.safe");
    await writeFile(credentialPath, "protected-ciphertext");
    const failing: SessionProtector = {
      async isAvailable() { return true; },
      async encrypt() { throw new Error("unavailable"); },
      async decrypt() { throw new Error("temporarily unavailable"); },
    };
    const store = new SecureSessionStore(directory, failing);
    expect(await store.restore()).toBeNull();
    expect((await readFile(credentialPath)).toString()).toBe("protected-ciphertext");
  });
});
