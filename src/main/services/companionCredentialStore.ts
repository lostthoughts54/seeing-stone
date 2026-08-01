import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { SessionProtector } from "./secureSession";
import { AppError } from "./errors";

const recordSchema = z.object({
  deviceId: z.string().uuid(),
  serverId: z.string().min(1).max(256),
  userId: z.string().min(1).max(256),
  name: z.string().min(1).max(40),
  credentialHash: z.string().regex(/^[a-f0-9]{64}$/),
  pairedAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
}).strict();

const fileSchema = z.object({
  schemaVersion: z.literal(1),
  devices: z.array(recordSchema).max(32),
}).strict();

export type CompanionDeviceRecord = z.infer<typeof recordSchema>;

export function companionCredentialHash(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function equalHash(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function normalizeCompanionDeviceName(value: string): string {
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > 40 || /[\p{Cc}\p{Cf}]/u.test(normalized)) {
    throw new AppError("COMPANION_DEVICE_NAME_INVALID", "Use a visible device name up to 40 characters.", 422);
  }
  return normalized;
}

export class CompanionCredentialStore {
  private readonly filePath: string;
  private devices: CompanionDeviceRecord[] | null = null;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(userDataPath: string, private readonly protector: SessionProtector) {
    this.filePath = join(userDataPath, "companion-devices.safe");
  }

  async isAvailable(): Promise<boolean> {
    try { return await this.protector.isAvailable(); } catch { return false; }
  }

  async list(serverId: string, userId: string): Promise<CompanionDeviceRecord[]> {
    const devices = await this.load();
    return devices
      .filter((entry) => entry.serverId === serverId && entry.userId === userId)
      .map((entry) => ({ ...entry }));
  }

  async create(serverId: string, userId: string, name: string, secret: string): Promise<CompanionDeviceRecord> {
    return this.exclusive(async () => {
      const devices = await this.load();
      if (devices.length >= 32) throw new AppError("COMPANION_DEVICE_LIMIT", "Revoke a paired device before adding another.", 409);
      const record = recordSchema.parse({
        deviceId: randomUUID(),
        serverId,
        userId,
        name: normalizeCompanionDeviceName(name),
        credentialHash: companionCredentialHash(secret),
        pairedAt: new Date().toISOString(),
        lastUsedAt: null,
      });
      devices.push(record);
      await this.persist();
      return { ...record };
    });
  }

  async authenticate(
    serverId: string,
    userId: string,
    deviceId: string,
    secret: string,
  ): Promise<CompanionDeviceRecord | null> {
    const record = (await this.load()).find((entry) => entry.deviceId === deviceId
      && entry.serverId === serverId && entry.userId === userId);
    return record && equalHash(record.credentialHash, companionCredentialHash(secret)) ? { ...record } : null;
  }

  async touch(deviceId: string): Promise<void> {
    return this.exclusive(async () => {
      const devices = await this.load();
      const record = devices.find((entry) => entry.deviceId === deviceId);
      if (!record) return;
      const previous = record.lastUsedAt ? Date.parse(record.lastUsedAt) : 0;
      if (Date.now() - previous < 60_000) return;
      record.lastUsedAt = new Date().toISOString();
      await this.persist();
    });
  }

  async rename(serverId: string, userId: string, deviceId: string, name: string): Promise<void> {
    return this.exclusive(async () => {
      const record = (await this.load()).find((entry) =>
        entry.deviceId === deviceId && entry.serverId === serverId && entry.userId === userId);
      if (!record) throw new AppError("COMPANION_DEVICE_NOT_FOUND", "That paired device is unavailable.", 404);
      record.name = normalizeCompanionDeviceName(name);
      await this.persist();
    });
  }

  async revoke(serverId: string, userId: string, deviceId: string): Promise<void> {
    return this.exclusive(async () => {
      const devices = await this.load();
      const next = devices.filter((entry) =>
        entry.deviceId !== deviceId || entry.serverId !== serverId || entry.userId !== userId);
      if (next.length === devices.length) throw new AppError("COMPANION_DEVICE_NOT_FOUND", "That paired device is unavailable.", 404);
      this.devices = next;
      await this.persist();
    });
  }

  async clearAll(): Promise<void> {
    return this.exclusive(async () => {
      this.devices = [];
      await rm(this.filePath, { force: true });
      await rm(`${this.filePath}.tmp`, { force: true });
    });
  }

  private async load(): Promise<CompanionDeviceRecord[]> {
    if (this.devices) return this.devices;
    if (!await this.isAvailable()) {
      throw new AppError("COMPANION_PROTECTION_UNAVAILABLE", "Windows protected storage is unavailable.", 503);
    }
    try {
      const decrypted = await this.protector.decrypt(await readFile(this.filePath));
      const parsed = fileSchema.parse(JSON.parse(decrypted.result));
      this.devices = parsed.devices;
      if (decrypted.shouldReEncrypt) await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.devices = [];
      else throw new AppError("COMPANION_CREDENTIAL_STORE_INVALID", "Paired-device storage could not be opened safely.", 503);
    }
    return this.devices;
  }

  private async persist(): Promise<void> {
    if (!this.devices) return;
    const safe = fileSchema.parse({ schemaVersion: 1, devices: this.devices });
    const encrypted = await this.protector.encrypt(JSON.stringify(safe));
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, encrypted, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}
