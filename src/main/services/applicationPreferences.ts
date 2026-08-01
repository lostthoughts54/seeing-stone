import { z } from "zod";
import type { BufferingPolicyMode, PlaybackDiagnostics } from "../../shared/contracts";
import type { SqlitePersistenceService } from "./persistence";
import type { PlayerAdapterMode } from "./playerPreferences";

const adapterPreferenceSchema = z.object({ mode: z.enum(["legacy", "embedded", "libmpv"]) }).strict();
const bufferingPolicySchema = z.object({ mode: z.enum(["wait-for-all", "continue"]) }).strict();
const cachedDiagnosticsSchema = z.object({
  itemId: z.string().min(1).max(256),
  diagnostics: z.object({
    sourceKind: z.enum(["matched-local", "downloaded", "direct-play", "direct-stream", "transcode", "offline-local"]).nullable(),
    playbackRate: z.number().finite().min(0.25).max(4),
    bufferAheadTicks: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    container: z.string().max(64).nullable(),
    videoCodec: z.string().max(64).nullable(),
    audioCodec: z.string().max(64).nullable(),
    audioChannels: z.string().max(64).nullable(),
    resolution: z.string().max(64).nullable(),
    bitrate: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    videoRange: z.string().max(64).nullable(),
    transcodeReason: z.string().max(512).nullable(),
  }).strict(),
}).strict();
const companionSettingsSchema = z.object({
  enabled: z.boolean(),
  networkId: z.string().max(128).nullable(),
  port: z.number().int().min(49152).max(65535),
  hostSuffix: z.string().regex(/^[a-z0-9]{4,12}$/),
}).strict();

export type StoredCompanionSettings = z.infer<typeof companionSettingsSchema>;

export interface CachedPlaybackDiagnostics {
  itemId: string;
  diagnostics: PlaybackDiagnostics;
}

export interface ApplicationPreferences {
  getAdapterMode(): Promise<PlayerAdapterMode | null>;
  setAdapterMode(mode: PlayerAdapterMode): Promise<void>;
  getBufferingPolicy(): Promise<BufferingPolicyMode>;
  setBufferingPolicy(mode: BufferingPolicyMode): Promise<void>;
  getCachedDiagnostics(): Promise<CachedPlaybackDiagnostics | null>;
  setCachedDiagnostics(value: CachedPlaybackDiagnostics): Promise<void>;
  getCompanionSettings(): Promise<StoredCompanionSettings | null>;
  setCompanionSettings(value: StoredCompanionSettings): Promise<void>;
}

function parseRecord<T>(valueJson: string | null, schema: z.ZodType<T>): T | null {
  if (!valueJson) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(valueJson));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export class ApplicationPreferencesService implements ApplicationPreferences {
  constructor(private readonly persistence: Pick<SqlitePersistenceService, "getApplicationPreference" | "setApplicationPreference">) {}

  async getAdapterMode(): Promise<PlayerAdapterMode | null> {
    const record = await this.persistence.getApplicationPreference("player.adapter-mode");
    return parseRecord(record?.valueJson ?? null, adapterPreferenceSchema)?.mode ?? null;
  }

  async setAdapterMode(mode: PlayerAdapterMode): Promise<void> {
    const value = adapterPreferenceSchema.parse({ mode });
    await this.persistence.setApplicationPreference("player.adapter-mode", value);
  }

  async getBufferingPolicy(): Promise<BufferingPolicyMode> {
    const record = await this.persistence.getApplicationPreference("watchparty.buffering-policy");
    return parseRecord(record?.valueJson ?? null, bufferingPolicySchema)?.mode ?? "wait-for-all";
  }

  async setBufferingPolicy(mode: BufferingPolicyMode): Promise<void> {
    const value = bufferingPolicySchema.parse({ mode });
    await this.persistence.setApplicationPreference("watchparty.buffering-policy", value);
  }

  async getCachedDiagnostics(): Promise<CachedPlaybackDiagnostics | null> {
    const record = await this.persistence.getApplicationPreference("player.cached-diagnostics");
    return parseRecord(record?.valueJson ?? null, cachedDiagnosticsSchema);
  }

  async setCachedDiagnostics(value: CachedPlaybackDiagnostics): Promise<void> {
    const safe = cachedDiagnosticsSchema.parse(value);
    await this.persistence.setApplicationPreference("player.cached-diagnostics", safe);
  }

  async getCompanionSettings(): Promise<StoredCompanionSettings | null> {
    const record = await this.persistence.getApplicationPreference("companion.settings");
    return parseRecord(record?.valueJson ?? null, companionSettingsSchema);
  }

  async setCompanionSettings(value: StoredCompanionSettings): Promise<void> {
    await this.persistence.setApplicationPreference("companion.settings", companionSettingsSchema.parse(value));
  }
}
