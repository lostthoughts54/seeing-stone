import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { DownloadLocationSummary } from "../../shared/contracts";
import { AppError } from "./errors";

export const DOWNLOAD_FOLDER_NAME = "LocalFirst Jellyfin Downloads";

const locationSchema = z.object({
  schemaVersion: z.literal(1),
  activeRoot: z.string().max(32767).nullable(),
  authorizedRoots: z.array(z.string().max(32767)).max(128),
}).strict();

interface DownloadLocationState {
  activeRoot: string | null;
  authorizedRoots: string[];
}

function pathKey(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function uniqueRoots(values: string[]): string[] {
  const roots = new Map<string, string>();
  for (const value of values) {
    if (!isAbsolute(value)) throw new AppError("INVALID_DOWNLOAD_LOCATION", "The saved download location is invalid.", 500);
    const normalized = resolve(value);
    roots.set(pathKey(normalized), normalized);
  }
  return [...roots.values()];
}

export class DownloadLocationService {
  private readonly preferencesPath: string;
  private readonly defaultRoot: string;
  private cached: DownloadLocationState | null = null;
  private initialization: Promise<DownloadLocationState> | null = null;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(userDataPath: string, defaultRoot: string) {
    if (!isAbsolute(defaultRoot)) throw new AppError("INVALID_DOWNLOAD_LOCATION", "The default download location is invalid.", 500);
    this.defaultRoot = resolve(defaultRoot);
    this.preferencesPath = join(userDataPath, "download-location.json");
  }

  async getActiveRoot(): Promise<string> {
    const state = await this.getState();
    return state.activeRoot ?? this.defaultRoot;
  }

  async getAuthorizedRoots(): Promise<string[]> {
    const state = await this.getState();
    return uniqueRoots([this.defaultRoot, ...state.authorizedRoots, ...(state.activeRoot ? [state.activeRoot] : [])]);
  }

  async getSummary(): Promise<DownloadLocationSummary> {
    const state = await this.getState();
    if (!state.activeRoot) return { mode: "default", label: "Windows Videos folder" };
    const drive = /^([a-z]):[\\/]/i.exec(state.activeRoot)?.[1]?.toUpperCase();
    return { mode: "custom", label: drive ? `Custom folder on ${drive}:` : "Custom folder" };
  }

  async chooseParent(parentFolder: string): Promise<DownloadLocationSummary> {
    return this.runExclusive(async () => {
      if (!isAbsolute(parentFolder)) throw new AppError("INVALID_DOWNLOAD_LOCATION", "Choose a valid local download folder.", 400);
      const selected = resolve(parentFolder);
      const root = basename(selected).toLocaleLowerCase("en-US") === DOWNLOAD_FOLDER_NAME.toLocaleLowerCase("en-US")
        ? selected
        : join(selected, DOWNLOAD_FOLDER_NAME);
      await mkdir(root, { recursive: true });
      const folder = await stat(root);
      if (!folder.isDirectory()) throw new AppError("INVALID_DOWNLOAD_LOCATION", "The selected download location is not a folder.", 400);

      const current = await this.getState();
      const activeRoot = pathKey(root) === pathKey(this.defaultRoot) ? null : root;
      const authorizedRoots = uniqueRoots([...current.authorizedRoots, root]);
      const next = { activeRoot, authorizedRoots };
      await this.persist(next);
      this.cached = next;
      return this.getSummary();
    });
  }

  async useDefault(): Promise<DownloadLocationSummary> {
    return this.runExclusive(async () => {
      const current = await this.getState();
      if (current.activeRoot === null) return this.getSummary();
      const next = { ...current, activeRoot: null };
      await this.persist(next);
      this.cached = next;
      return this.getSummary();
    });
  }

  async ensureActiveFolder(): Promise<string> {
    const root = await this.getActiveRoot();
    await mkdir(root, { recursive: true });
    const folder = await stat(root);
    if (!folder.isDirectory()) throw new AppError("INVALID_DOWNLOAD_LOCATION", "The download location is not a folder.", 400);
    return root;
  }

  private async getState(): Promise<DownloadLocationState> {
    if (this.cached) return { activeRoot: this.cached.activeRoot, authorizedRoots: [...this.cached.authorizedRoots] };
    if (!this.initialization) this.initialization = this.initialize();
    try {
      const state = await this.initialization;
      return { activeRoot: state.activeRoot, authorizedRoots: [...state.authorizedRoots] };
    } finally {
      this.initialization = null;
    }
  }

  private async initialize(): Promise<DownloadLocationState> {
    try {
      const parsed = locationSchema.parse(JSON.parse(await readFile(this.preferencesPath, "utf8")));
      const activeRoot = parsed.activeRoot === null ? null : uniqueRoots([parsed.activeRoot])[0];
      this.cached = {
        activeRoot: activeRoot && pathKey(activeRoot) !== pathKey(this.defaultRoot) ? activeRoot : null,
        authorizedRoots: uniqueRoots(parsed.authorizedRoots),
      };
    } catch {
      this.cached = { activeRoot: null, authorizedRoots: [] };
      await this.persist(this.cached);
    }
    return this.cached;
  }

  private async persist(state: DownloadLocationState): Promise<void> {
    const safe = locationSchema.parse({ schemaVersion: 1, ...state });
    await mkdir(dirname(this.preferencesPath), { recursive: true });
    const temporaryPath = `${this.preferencesPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(safe, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.preferencesPath);
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolveOperation) => { release = resolveOperation; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
