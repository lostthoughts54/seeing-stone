import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

const preferencesSchema = z.object({
  schemaVersion: z.literal(1),
  windowMaximized: z.boolean(),
});

export interface PlayerPreferences {
  windowMaximized: boolean;
}

export interface PlayerPreferencesStore {
  get(): Promise<PlayerPreferences>;
  setWindowMaximized(windowMaximized: boolean): Promise<void>;
}

const DEFAULTS: PlayerPreferences = { windowMaximized: true };

export class PlayerPreferencesService implements PlayerPreferencesStore {
  private readonly preferencesPath: string;
  private cached: PlayerPreferences | null = null;
  private initialization: Promise<PlayerPreferences> | null = null;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(userDataPath: string) {
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
      const next = { windowMaximized };
      await this.persist(next);
      this.cached = next;
    });
  }

  private async initialize(): Promise<PlayerPreferences> {
    try {
      const parsed = preferencesSchema.parse(JSON.parse(await readFile(this.preferencesPath, "utf8")));
      this.cached = { windowMaximized: parsed.windowMaximized };
    } catch {
      this.cached = { ...DEFAULTS };
      await this.persist(this.cached);
    }
    return this.cached;
  }

  private async persist(preferences: PlayerPreferences): Promise<void> {
    const safe = preferencesSchema.parse({ schemaVersion: 1, ...preferences });
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
