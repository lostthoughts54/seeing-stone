import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

const identitySchema = z.object({
  schemaVersion: z.literal(1),
  deviceId: z.string().uuid(),
});

export interface DeviceIdentity {
  deviceId: string;
  clientName: string;
  clientVersion: string;
  deviceName: string;
}

export class DeviceIdentityService {
  private readonly identityPath: string;
  private cached: DeviceIdentity | null = null;
  private initialization: Promise<DeviceIdentity> | null = null;

  constructor(
    userDataPath: string,
    private readonly deviceName: string,
    private readonly clientName: string,
    private readonly clientVersion: string,
  ) {
    this.identityPath = join(userDataPath, "device-identity.json");
  }

  async get(): Promise<DeviceIdentity> {
    if (this.cached) return this.cached;
    if (this.initialization) return this.initialization;
    this.initialization = this.initialize();
    try {
      return await this.initialization;
    } finally {
      this.initialization = null;
    }
  }

  private async initialize(): Promise<DeviceIdentity> {
    try {
      const parsed = identitySchema.parse(JSON.parse(await readFile(this.identityPath, "utf8")));
      this.cached = {
        deviceId: parsed.deviceId,
        clientName: this.clientName,
        clientVersion: this.clientVersion,
        deviceName: this.deviceName,
      };
      return this.cached;
    } catch {
      this.cached = {
        deviceId: randomUUID(),
        clientName: this.clientName,
        clientVersion: this.clientVersion,
        deviceName: this.deviceName,
      };
      await this.persist(this.cached);
      return this.cached;
    }
  }

  private async persist(identity: DeviceIdentity): Promise<void> {
    await mkdir(dirname(this.identityPath), { recursive: true });
    const temporaryPath = `${this.identityPath}.tmp`;
    const safe = identitySchema.parse({ schemaVersion: 1, deviceId: identity.deviceId });
    await writeFile(temporaryPath, `${JSON.stringify(safe, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.identityPath);
  }
}
