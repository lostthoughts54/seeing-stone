import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
  private operationTail: Promise<void> = Promise.resolve();

  constructor(userDataPath: string, private readonly protector: SessionProtector) {
    this.sessionPath = join(userDataPath, "session.safe");
  }

  async save(session: StoredSession, remember: boolean): Promise<SafeSession["persistence"]> {
    return this.runExclusive(() => this.saveInternal(session, remember));
  }

  private async saveInternal(session: StoredSession, remember: boolean): Promise<SafeSession["persistence"]> {
    const previousSession = this.memorySession;
    const previousPersistence = this.persistence;
    const nextSession = storedSessionSchema.parse(session);
    let protectionAvailable = false;
    try {
      protectionAvailable = remember && await this.protector.isAvailable();
    } catch {
      protectionAvailable = false;
    }
    if (!protectionAvailable) return this.fallBackToMemory(nextSession, previousSession, previousPersistence);

    try {
      await this.writeProtected(nextSession);
      this.memorySession = nextSession;
      this.persistence = "protected";
      return this.persistence;
    } catch {
      return this.fallBackToMemory(nextSession, previousSession, previousPersistence);
    }
  }

  async restore(): Promise<StoredSession | null> {
    return this.runExclusive(() => this.restoreInternal());
  }

  private async restoreInternal(): Promise<StoredSession | null> {
    if (this.memorySession) return this.memorySession;
    let protectionAvailable = false;
    try { protectionAvailable = await this.protector.isAvailable(); } catch { /* Reauthenticate without deleting ciphertext. */ }
    if (!protectionAvailable) {
      this.persistence = "none";
      return null;
    }
    try {
      const encrypted = await readFile(this.sessionPath);
      const decrypted = await this.protector.decrypt(encrypted);
      const restoredSession = storedSessionSchema.parse(JSON.parse(decrypted.result));
      // Rotation is part of the restore transaction. Do not publish the
      // decrypted credential in memory until its replacement is protected.
      if (decrypted.shouldReEncrypt) await this.writeProtected(restoredSession);
      this.memorySession = restoredSession;
      this.persistence = "protected";
      return this.memorySession;
    } catch {
      // Preserve ciphertext when protected storage is temporarily unavailable.
      // A later successful restore or explicit login can recover/replace it.
      this.memorySession = null;
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
    return this.runExclusive(() => this.clearInternal());
  }

  private async clearInternal(): Promise<void> {
    try {
      await this.removePersisted();
    } catch (error) {
      if (await this.persistedSessionMayRemain()) throw error;
    }
    this.memorySession = null;
    this.persistence = "none";
  }

  private async removePersisted(): Promise<void> {
    await rm(this.sessionPath, { force: true });
    await rm(`${this.sessionPath}.tmp`, { force: true });
  }

  private async writeProtected(session: StoredSession): Promise<void> {
    const encrypted = await this.protector.encrypt(JSON.stringify(session));
    await mkdir(dirname(this.sessionPath), { recursive: true });
    const temporaryPath = `${this.sessionPath}.tmp`;
    await writeFile(temporaryPath, encrypted, { mode: 0o600 });
    await rename(temporaryPath, this.sessionPath);
  }

  private async fallBackToMemory(
    nextSession: StoredSession,
    previousSession: StoredSession | null,
    previousPersistence: SafeSession["persistence"],
  ): Promise<SafeSession["persistence"]> {
    try {
      await this.removePersisted();
    } catch (error) {
      if (await this.persistedSessionMayRemain()) {
        this.memorySession = previousSession;
        this.persistence = previousPersistence;
        throw error;
      }
    }
    this.memorySession = nextSession;
    this.persistence = "memory-only";
    return this.persistence;
  }

  private async persistedSessionMayRemain(): Promise<boolean> {
    try {
      await stat(this.sessionPath);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code !== "ENOENT" && code !== "ENOTDIR";
    }
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
