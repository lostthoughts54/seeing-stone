import { randomUUID } from "node:crypto";
import { z } from "zod";
import { iptvProviderIdSchema, iptvSetupSchema, type IptvSetup, type IptvProviderSummary } from "../../shared/iptv";
import { AppError } from "./errors";
import type { SqlitePersistenceService } from "./persistence";
import type { SessionProtector } from "./secureSession";

type ProviderPersistence = Pick<SqlitePersistenceService,
  "insertIptvProvider" | "getIptvProvider" | "listIptvProviders" | "deleteIptvProvider" | "rotateIptvProviderProtection">;
const envelope = z.object({ version: z.literal(1), providerId: iptvProviderIdSchema, setup: iptvSetupSchema }).strict();

/** Main-process credential boundary. Does not authenticate or contact a provider. */
export class IptvProviderStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly persistence: ProviderPersistence, private readonly protector: SessionProtector) {}

  create(input: IptvSetup): Promise<IptvProviderSummary> {
    // Do not surface Zod errors containing submitted values, especially URL credentials.
    const parsed = iptvSetupSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(new AppError("INVALID_IPTV_SETUP", "Provider setup is invalid.", 400));
    const setup = parsed.data;
    return this.exclusive(async () => {
      await this.requireProtection();
      const providerId = randomUUID();
      const protectedConfiguration = await this.encrypt(providerId, setup);
      const now = Date.now();
      const summary = { providerId, kind: setup.kind, name: setup.name };
      await this.persistence.insertIptvProvider({ ...summary, protectedConfiguration, createdAt: now, updatedAt: now });
      return summary;
    });
  }

  list(): Promise<IptvProviderSummary[]> { return this.exclusive(() => this.persistence.listIptvProviders()); }

  /** Sensitive return value: only the future provider service may call this method. */
  readConfiguration(providerId: string): Promise<IptvSetup | null> {
    return this.exclusive(async () => {
      const record = await this.persistence.getIptvProvider(iptvProviderIdSchema.parse(providerId));
      if (!record) return null;
      await this.requireProtection();
      try {
        const decrypted = await this.protector.decrypt(Buffer.from(record.protectedConfiguration));
        const restored = envelope.parse(JSON.parse(decrypted.result));
        if (restored.providerId !== providerId || restored.setup.kind !== record.kind || restored.setup.name !== record.name) throw new Error("mismatch");
        if (decrypted.shouldReEncrypt) {
          await this.persistence.rotateIptvProviderProtection(providerId, await this.encrypt(providerId, restored.setup));
        }
        return restored.setup;
      } catch {
        // Preserve the stored ciphertext on unavailable protection, corruption or failed rotation.
        throw new AppError("IPTV_CREDENTIALS_UNAVAILABLE", "Saved provider credentials could not be opened.", 503);
      }
    });
  }

  remove(providerId: string): Promise<void> {
    return this.exclusive(() => this.persistence.deleteIptvProvider(iptvProviderIdSchema.parse(providerId)));
  }

  private async requireProtection(): Promise<void> {
    if (!await this.protector.isAvailable().catch(() => false)) {
      throw new AppError("IPTV_PROTECTION_UNAVAILABLE", "OS-protected storage is unavailable. Provider credentials were not saved or opened.", 503);
    }
  }

  private async encrypt(providerId: string, setup: IptvSetup): Promise<Buffer> {
    try { return await this.protector.encrypt(JSON.stringify({ version: 1, providerId, setup })); }
    catch { throw new AppError("IPTV_PROTECTION_UNAVAILABLE", "Provider credentials could not be protected.", 503); }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
