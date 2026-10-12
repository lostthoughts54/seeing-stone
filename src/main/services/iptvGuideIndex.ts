import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { IptvSetup, IptvChannelSchedule } from "../../shared/iptv";
import { AppError } from "./errors";

const unavailable = () => new AppError("IPTV_PROGRAMME_SEARCH_UNAVAILABLE", "Programme search is unavailable. The provider's full guide could not be loaded. Try again later.", 502);
export class IptvGuideIndex {
  readonly generation = randomUUID();
  readonly createdAt = Date.now();
  private worker: Worker;
  private ready: Promise<void>;
  private sequence = 0;
  private failed = false;
  loaded = false;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  constructor(setup: IptvSetup) {
    this.worker = new Worker(join(__dirname, "iptvGuideIndexWorker.js"), { workerData: { setup }, resourceLimits: { maxOldGenerationSizeMb: 384 } });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(), 185000); timer.unref();
      const fail = () => {
        clearTimeout(timer); this.failed = true; this.loaded = false; reject(unavailable());
        for (const entry of this.pending.values()) entry.reject(unavailable());
        this.pending.clear(); void this.worker.terminate();
      };
      this.worker.on("error", fail);
      this.worker.on("exit", () => { if (!this.failed) fail(); });
      this.worker.on("message", message => {
        if (message.failed) { fail(); return; }
        if (message.ready) { clearTimeout(timer); this.loaded = true; resolve(); return; }
        const entry = this.pending.get(message.id); if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(unavailable()); else entry.resolve(message.result);
      });
    });
    void this.ready.catch(() => undefined);
  }
  private async request(input: object): Promise<unknown> {
    await this.ready;
    if (this.failed) throw unavailable();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ id, ...input }); });
  }
  async search(query: string, start: number, end: number): Promise<string[]> { return await this.request({ query, start, end }) as string[]; }
  async schedule(channelId: string): Promise<IptvChannelSchedule> {
    return { programmes: await this.request({ channelId }) as IptvChannelSchedule["programmes"], fetchedAt: new Date(this.createdAt).toISOString(), stale: false };
  }
  async close(): Promise<void> { await this.worker.terminate(); }
}
