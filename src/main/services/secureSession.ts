import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { SafeSession } from "../../shared/contracts";

const storedSessionSchema = z.object({
  serverUrl: z.string().url(),
  serverId: z.string().min(1),
  serverName: z.string().min(1),
  serverVersion: z.string(),
  userId: z.string().min(1),
  userName: z.string().min(1),
  accessToken: z.string().min(1),
});

export type StoredSession = z.infer<typeof storedSessionSchema>;

export interface SessionProtector {
  isAvailable(): Promise<boolean>;
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

export class SecureSessionStore {
  private readonly sessionPath: string;
  private memorySession: StoredSession | null = null;
  private persistence: SafeSession["persistence"] = "none";

  constructor(userDataPath: string, private readonly protector: SessionProtector) {
    this.sessionPath = join(userDataPath, "session.safe");
  }

  async save(session: StoredSession, remember: boolean): Promise<SafeSession["persistence"]> {
    this.memorySession = storedSessionSchema.parse(session);
    if (!remember || !(await this.protector.isAvailable())) {
      await this.removePersisted();
      this.persistence = "memory-only";
      return this.persistence;
    }

    let encrypted: Buffer;
    try {
      encrypted = await this.protector.encrypt(JSON.stringify(this.memorySession));
    } catch {
      await this.removePersisted();
      this.persistence = "memory-only";
      return this.persistence;
    }
    await mkdir(dirname(this.sessionPath), { recursive: true });
    const temporaryPath = `${this.sessionPath}.tmp`;
    await writeFile(temporaryPath, encrypted, { mode: 0o600 });
    await rename(temporaryPath, this.sessionPath);
    this.persistence = "protected";
    return this.persistence;
  }

  async restore(): Promise<StoredSession | null> {
    if (this.memorySession) return this.memorySession;
    if (!(await this.protector.isAvailable())) {
      this.persistence = "none";
      return null;
    }
    try {
      const encrypted = await readFile(this.sessionPath);
      const decrypted = await this.protector.decrypt(encrypted);
      this.memorySession = storedSessionSchema.parse(JSON.parse(decrypted.result));
      this.persistence = "protected";
      if (decrypted.shouldReEncrypt) await this.save(this.memorySession, true);
      return this.memorySession;
    } catch {
      // Preserve ciphertext when protected storage is temporarily unavailable.
      // A later successful restore or explicit login can recover/replace it.
      this.persistence = "none";
      return null;
    }
  }

  getMemory(): StoredSession | null {
    return this.memorySession;
  }

  getPersistence(): SafeSession["persistence"] {
    return this.memorySession ? this.persistence : "none";
  }

  async clear(): Promise<void> {
    this.memorySession = null;
    this.persistence = "none";
    await this.removePersisted();
  }

  private async removePersisted(): Promise<void> {
    await rm(this.sessionPath, { force: true });
    await rm(`${this.sessionPath}.tmp`, { force: true });
  }
}
