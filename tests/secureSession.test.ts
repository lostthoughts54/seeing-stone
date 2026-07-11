import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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

  it("keeps the authenticated session in memory when protected-file I/O fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lf-session-"));
    const blockedPath = join(directory, "not-a-directory");
    await writeFile(blockedPath, "blocking file");
    const store = new SecureSessionStore(blockedPath, protector());
    expect(await store.save(session, true)).toBe("memory-only");
    expect(store.getMemory()).toEqual(session);
    expect((await readFile(blockedPath)).toString()).toBe("blocking file");
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

  it("re-encrypts restored ciphertext when the OS protector requests rotation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lf-session-"));
    const credentialPath = join(directory, "session.safe");
    await writeFile(credentialPath, "old-protected-ciphertext");
    const encrypt = vi.fn(async () => Buffer.from("rotated-protected-ciphertext"));
    const rotating: SessionProtector = {
      async isAvailable() { return true; },
      encrypt,
      async decrypt() { return { result: JSON.stringify(session), shouldReEncrypt: true }; },
    };
    const store = new SecureSessionStore(directory, rotating);
    expect(await store.restore()).toEqual(session);
    expect(encrypt).toHaveBeenCalledOnce();
    expect((await readFile(credentialPath)).toString()).toBe("rotated-protected-ciphertext");
  });

  it("does not resurrect a decrypted session after re-encryption cleanup fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lf-session-"));
    const credentialPath = join(directory, "session.safe");
    await writeFile(credentialPath, "old-protected-ciphertext");
    const decrypt = vi.fn(async () => ({ result: JSON.stringify(session), shouldReEncrypt: true }));
    const failingRotation: SessionProtector = {
      async isAvailable() { return true; },
      async encrypt() {
        // Reproduce a protected-write failure whose cleanup cannot remove the
        // credential path. The old implementation retained the decrypted
        // session in memory after this failure.
        await rm(credentialPath);
        await mkdir(credentialPath);
        throw new Error("rotation unavailable");
      },
      decrypt,
    };
    const store = new SecureSessionStore(directory, failingRotation);

    expect(await store.restore()).toBeNull();
    expect(store.getMemory()).toBeNull();
    expect(store.getPersistence()).toBe("none");
    expect(await store.restore()).toBeNull();
    expect(store.getMemory()).toBeNull();
    expect(decrypt).toHaveBeenCalledOnce();
  });

  it("serializes a clear requested while a protected save is still encrypting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lf-session-"));
    let releaseEncryption: ((value: Buffer) => void) | undefined;
    const delayed: SessionProtector = {
      async isAvailable() { return true; },
      async encrypt() { return new Promise<Buffer>((resolve) => { releaseEncryption = resolve; }); },
      async decrypt() { throw new Error("not used"); },
    };
    const store = new SecureSessionStore(directory, delayed);
    const pendingSave = store.save(session, true);
    await vi.waitFor(() => expect(releaseEncryption).toBeTypeOf("function"));
    const pendingClear = store.clear();
    releaseEncryption?.(Buffer.from("protected-ciphertext"));
    await expect(pendingSave).resolves.toBe("protected");
    await expect(pendingClear).resolves.toBeUndefined();
    expect(store.getMemory()).toBeNull();
    expect(store.getPersistence()).toBe("none");
    await expect(stat(join(directory, "session.safe"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
