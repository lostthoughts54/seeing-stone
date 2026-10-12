import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { YouTubeSearchSettings } from "../../shared/companionContracts";
import type { SessionProtector } from "./secureSession";
import { AppError } from "./errors";

const keySchema = z.string().trim().regex(/^[A-Za-z0-9_-]{20,256}$/);

export class YouTubeApiKeyStore {
  private savedKey = "";
  private unavailable = false;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly path: string;

  constructor(private readonly directory: string, private readonly protector: SessionProtector,
    private readonly environmentKey = () => process.env.SEEING_STONE_YOUTUBE_API_KEY?.trim() ?? "") {
    this.path = join(directory, "youtube-api-key.safe");
  }

  async load(): Promise<void> {
    try {
      const bytes = await readFile(this.path);
      if (!await this.protector.isAvailable()) throw new Error("Storage unavailable");
      const decrypted = await this.protector.decrypt(bytes);
      this.savedKey = keySchema.parse(decrypted.result);
      this.unavailable = false;
    } catch (error) {
      this.savedKey = "";
      this.unavailable = (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  }

  getKey(): string { return this.savedKey || this.environmentKey(); }

  getStatus(): YouTubeSearchSettings {
    return {
      configured: Boolean(this.getKey()),
      source: this.savedKey ? "saved" : this.environmentKey() ? "environment" : "none",
      storageUnavailable: this.unavailable,
    };
  }

  async setKey(input: string): Promise<YouTubeSearchSettings> {
    const key = input.trim() ? keySchema.parse(input) : "";
    const operation = this.tail.then(async () => {
      try {
        if (key) {
          if (!await this.protector.isAvailable()) throw new Error("Storage unavailable");
          const encrypted = await this.protector.encrypt(key);
          await mkdir(this.directory, { recursive: true });
          await writeFile(`${this.path}.tmp`, encrypted, { mode: 0o600 });
          await rename(`${this.path}.tmp`, this.path);
        } else {
          await rm(this.path, { force: true });
          await rm(`${this.path}.tmp`, { force: true });
        }
      } catch {
        throw new AppError("YOUTUBE_KEY_STORAGE", "The YouTube key could not be saved securely. Your previous setting has been kept.", 503);
      }
      this.savedKey = key;
      this.unavailable = false;
      return this.getStatus();
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }
}
