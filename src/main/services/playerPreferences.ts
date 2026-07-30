import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

const preferencesSchema = z.object({
  schemaVersion: z.literal(4),
  windowMaximized: z.boolean(),
  adapterMode: z.enum(["legacy", "embedded", "libmpv"]),
  adapterModeExplicit: z.boolean(),
});

const versionThreePreferencesSchema = z.object({
  schemaVersion: z.literal(3),
  windowMaximized: z.boolean(),
  adapterMode: z.enum(["legacy", "embedded"]),
  adapterModeExplicit: z.boolean(),
});

const previousPreferencesSchema = z.object({
  schemaVersion: z.literal(2),
  windowMaximized: z.boolean(),
  adapterMode: z.enum(["legacy", "embedded"]),
});
const legacyPreferencesSchema = z.object({ schemaVersion: z.literal(1), windowMaximized: z.boolean() });

export type PlayerAdapterMode = "legacy" | "embedded" | "libmpv";

export interface PlayerPreferences {
  windowMaximized: boolean;
  adapterMode?: PlayerAdapterMode;
}

export interface PlayerPreferencesStore {
  get(): Promise<PlayerPreferences>;
  setWindowMaximized(windowMaximized: boolean): Promise<void>;
  setAdapterMode?(adapterMode: PlayerAdapterMode): Promise<void>;
}

export interface AdapterPreferencePersistence {
  getAdapterMode(): Promise<PlayerAdapterMode | null>;
  setAdapterMode(mode: PlayerAdapterMode): Promise<void>;
}

export class PlayerPreferencesService implements PlayerPreferencesStore {
  private readonly preferencesPath: string;
  private cached: PlayerPreferences | null = null;
  private adapterModeExplicit = false;
  private initialization: Promise<PlayerPreferences> | null = null;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    userDataPath: string,
    private readonly durablePreferences?: AdapterPreferencePersistence,
    private readonly defaultAdapterMode: PlayerAdapterMode = "legacy",
  ) {
    this.preferencesPath = join(userDataPath, "player-preferences.json");
  }

  async get(): Promise<PlayerPreferences> {
    if (this.cached) return { ...this.cached };
    if (!this.initialization) this.initialization = this.initialize();
    try {
      return { ...(await this.initialization) };
    } finally {
      this.initialization = null;
    }
  }

  async setWindowMaximized(windowMaximized: boolean): Promise<void> {
    await this.runExclusive(async () => {
      const current = await this.get();
      if (current.windowMaximized === windowMaximized) return;
      const next = { ...current, windowMaximized };
      await this.persist(next, this.adapterModeExplicit);
      this.cached = next;
    });
  }

  async setAdapterMode(adapterMode: PlayerAdapterMode): Promise<void> {
    await this.runExclusive(async () => {
      const current = await this.get();
      if (current.adapterMode === adapterMode && this.adapterModeExplicit) return;
      const next = { ...current, adapterMode };
      await this.durablePreferences?.setAdapterMode(adapterMode);
      this.adapterModeExplicit = true;
      await this.persist(next, true);
      this.cached = next;
    });
  }

  private async initialize(): Promise<PlayerPreferences> {
    try {
      const raw = JSON.parse(await readFile(this.preferencesPath, "utf8"));
      const parsed = preferencesSchema.safeParse(raw);
      if (parsed.success) {
        this.adapterModeExplicit = parsed.data.adapterModeExplicit;
        this.cached = {
          windowMaximized: parsed.data.windowMaximized,
          adapterMode: parsed.data.adapterModeExplicit ? parsed.data.adapterMode : this.defaultAdapterMode,
        };
      } else {
        const versionThree = versionThreePreferencesSchema.safeParse(raw);
        if (versionThree.success) {
          this.adapterModeExplicit = versionThree.data.adapterModeExplicit;
          this.cached = {
            windowMaximized: versionThree.data.windowMaximized,
            adapterMode: versionThree.data.adapterModeExplicit ? versionThree.data.adapterMode : this.defaultAdapterMode,
          };
          await this.persist(this.cached, this.adapterModeExplicit);
          return this.cached;
        }
        const previous = previousPreferencesSchema.safeParse(raw);
        const windowMaximized = previous.success
          ? previous.data.windowMaximized
          : legacyPreferencesSchema.parse(raw).windowMaximized;
        // Schema 1/2 never exposed an engine selector. Their stored adapter value was
        // an automatic launch default, not evidence of an intentional user choice.
        this.adapterModeExplicit = false;
        this.cached = { windowMaximized, adapterMode: this.defaultAdapterMode };
      }
      await this.persist(this.cached, this.adapterModeExplicit);
    } catch {
      this.adapterModeExplicit = false;
      this.cached = { windowMaximized: true, adapterMode: this.defaultAdapterMode };
      await this.persist(this.cached, false);
    }
    if (this.adapterModeExplicit) {
      const durableMode = await this.durablePreferences?.getAdapterMode().catch(() => null) ?? null;
      if (durableMode) {
        this.cached = { ...this.cached, adapterMode: durableMode };
        await this.persist(this.cached, true);
      } else if (this.durablePreferences && this.cached.adapterMode) {
        await this.durablePreferences.setAdapterMode(this.cached.adapterMode).catch(() => undefined);
      }
    }
    return this.cached;
  }

  private async persist(preferences: PlayerPreferences, adapterModeExplicit: boolean): Promise<void> {
    const safe = preferencesSchema.parse({
      schemaVersion: 4,
      ...preferences,
      adapterMode: preferences.adapterMode ?? this.defaultAdapterMode,
      adapterModeExplicit,
    });
    await mkdir(dirname(this.preferencesPath), { recursive: true });
    const temporaryPath = `${this.preferencesPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(safe, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.preferencesPath);
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
