import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { iptvCatalogueSchema, type IptvAccountTestStatus, type IptvSetup, type IptvPage, type IptvCatalogueItem, type IptvGroup, type IptvPlayableIdentity, type IptvChannelSchedule } from "../../shared/iptv";
import { IptvStream } from "./iptvStream";
import type { IptvCatalogueRecord, IptvCatalogueSnapshot } from "./persistenceTypes";
import type { SqlitePersistenceService } from "./persistence";
import { IptvProviderStore } from "./iptvProviderStore";
import { IptvProviderClient, iptvPublicFailure } from "./iptvProviderClient";
import { AppError } from "./errors";
import { isIptvProviderHeading } from "../../shared/iptv";
import { IptvGuideIndex } from "./iptvGuideIndex";

const cursorSchema = z.object({ snapshot: z.string().uuid(), filter: z.string().length(64), name: z.string().max(2048), id: z.string().max(512), favourite: z.boolean() }).strict();
export class IptvService {
  private readonly jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly activity = new Map<string, { phase: IptvAccountTestStatus["phase"]; message: string; imported: number }>();
  private closed = false;
  private readonly schedules = new Map<string, IptvChannelSchedule>();
  private readonly scheduleJobs = new Map<string, Promise<IptvChannelSchedule>>();
  private readonly lifetime = new AbortController();
  private readonly removed = new Set<string>();
  private readonly posters = new Map<string, { value: string | null; expires: number }>();
  private readonly posterJobs = new Map<string, Promise<string | null>>();
  private posterBytes = 0;
  private readonly guideIndexes = new Map<string, IptvGuideIndex>();
  constructor(private readonly store: IptvProviderStore, private readonly persistence: Pick<SqlitePersistenceService, "iptvCatalogue">, private readonly client = new IptvProviderClient()) {}

  async setup(input: IptvSetup) {
    if (this.closed) throw new AppError("IPTV_CLOSED", "IPTV is shutting down.", 409);
    const summary = await this.store.create(input);
    await this.refresh(summary.providerId);
    return summary;
  }

  async list(): Promise<IptvAccountTestStatus[]> {
    const providers = await this.store.list();
    return Promise.all(providers.map(async (provider) => {
      const snapshot = await this.snapshot(provider.providerId);
      return { provider, ...this.activity.get(provider.providerId) ?? { phase: snapshot ? "ready" as const : "saved" as const, message: snapshot ? "Saved catalogue ready. Refresh to test your account again." : "Ready to test this provider.", imported: 0 },
        lastSuccessfulAt: snapshot ? new Date(snapshot.completedAt).toISOString() : null, counts: snapshot?.counts ?? { live: 0, movie: 0, series: 0 } };
    }));
  }

  async refresh(providerId: string): Promise<void> {
    if (this.closed) throw new AppError("IPTV_CLOSED", "IPTV is shutting down.", 409);
    if (this.jobs.has(providerId)) return;
    if (!(await this.store.list()).some((provider) => provider.providerId === providerId)) throw new AppError("IPTV_NOT_FOUND", "This provider no longer exists.", 404);
    if (this.jobs.has(providerId) || this.closed) return;
    const controller = new AbortController();
    const snapshotId = randomUUID();
    this.activity.set(providerId, { phase: "connecting", message: "Checking provider access…", imported: 0 });
    const done = this.importCatalogue(providerId, snapshotId, controller.signal).finally(() => this.jobs.delete(providerId));
    this.jobs.set(providerId, { controller, done });
  }

  private async importCatalogue(providerId: string, snapshotId: string, signal: AbortSignal): Promise<void> {
    try {
      const setup = await this.store.readConfiguration(providerId);
      if (!setup) throw new AppError("IPTV_NOT_FOUND", "Provider removed.");
      signal.throwIfAborted();
      await this.client.authenticate(setup, signal);
      await this.persistence.iptvCatalogue({ action: "begin", providerId, snapshotId });
      let imported = 0;
      let batch: IptvCatalogueRecord[] = [];
      const flush = async () => {
        signal.throwIfAborted();
        await this.persistence.iptvCatalogue({ action: "batch", providerId, snapshotId, items: batch });
        imported += batch.length; batch = [];
        this.activity.set(providerId, { phase: "importing", message: "Importing catalogue…", imported });
      };
      this.activity.set(providerId, { phase: "importing", message: "Access accepted. Fetching catalogue…", imported });
      for await (const item of this.client.catalogue(setup, signal)) {
        batch.push(item);
        if (batch.length >= 250) await flush();
        if (imported + batch.length > 1_000_000) throw new AppError("IPTV_INVALID_FEED", "Catalogue exceeds the supported limit.");
      }
      if (batch.length) await flush();
      signal.throwIfAborted();
      if (!imported) throw new AppError("IPTV_INVALID_FEED", "No catalogue entries were returned.");
      const previous = await this.snapshot(providerId);
      await this.persistence.iptvCatalogue({ action: "publish", providerId, snapshotId, completedAt: Date.now() });
      this.activity.set(providerId, { phase: "ready", message: "Provider access and catalogue import succeeded.", imported });
      if (previous) await this.persistence.iptvCatalogue({ action: "discard", providerId, snapshotId: previous.snapshotId }).catch(() => undefined);
    } catch (error) {
      await this.persistence.iptvCatalogue({ action: "discard", providerId, snapshotId }).catch(() => undefined);
      if (!signal.aborted) this.activity.set(providerId, { phase: "failed", message: iptvPublicFailure(error), imported: 0 });
    }
  }

  async remove(providerId: string): Promise<void> {
    this.removed.add(providerId);
    const guide = this.guideIndexes.get(providerId); this.guideIndexes.delete(providerId); await guide?.close();
    for (const key of this.schedules.keys()) if (key.startsWith(`${providerId}:`)) this.schedules.delete(key);
    for (const [key, entry] of this.posters) if (key.startsWith(`${providerId}:`)) { this.posterBytes -= entry.value?.length ?? 0; this.posters.delete(key); }
    const job = this.jobs.get(providerId);
    job?.controller.abort();
    await job?.done;
    await this.store.remove(providerId);
    this.activity.delete(providerId);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    await Promise.allSettled([...this.guideIndexes.values()].map(index => index.close())); this.guideIndexes.clear();
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.all([...this.jobs.values()].map((job) => job.done));
    await Promise.allSettled(this.scheduleJobs.values());
    await Promise.allSettled(this.posterJobs.values());
    this.posters.clear(); this.posterBytes = 0;
  }

  async poster(identity: { providerId: string; contentType: "movie" | "series"; itemId: string }): Promise<string | null> {
    if (this.closed || this.removed.has(identity.providerId)) return null;
    const key = `${identity.providerId}:${identity.contentType}:${identity.itemId}`;
    const cached = this.posters.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const existing = this.posterJobs.get(key); if (existing) return existing;
    if (this.posterJobs.size >= 8) return null;
    const pending = (async () => {
      let value: string | null = null;
      try {
        const item = await this.persistence.iptvCatalogue({ action: "item", ...identity });
        const setup = item ? await this.store.readConfiguration(identity.providerId) : null;
        if (setup) value = await this.client.poster(setup, identity.contentType, identity.itemId, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(20000)]));
      } catch { /* Missing artwork must not interrupt catalogue browsing or expose upstream URLs. */ }
      if (this.closed || this.removed.has(identity.providerId)) return null;
      const previous = this.posters.get(key);
      if (previous) { this.posterBytes -= previous.value?.length ?? 0; this.posters.delete(key); }
      while (this.posters.size >= 100 || this.posterBytes + (value?.length ?? 0) > 24 * 1024 * 1024) {
        const oldest = this.posters.keys().next().value; if (!oldest) break;
        this.posterBytes -= this.posters.get(oldest)?.value?.length ?? 0; this.posters.delete(oldest);
      }
      this.posters.set(key, { value, expires: Date.now() + (value ? 30 : 5) * 60000 });
      this.posterBytes += value?.length ?? 0;
      return value;
    })().finally(() => this.posterJobs.delete(key));
    this.posterJobs.set(key, pending); return pending;
  }

  async resolveLive(identity: IptvPlayableIdentity, signal: AbortSignal): Promise<IptvStream> {
    if (this.closed || this.removed.has(identity.providerId)) throw new AppError("IPTV_NOT_FOUND", "Provider removed or application closing.", 404);
    if (identity.contentType !== "live") throw new AppError("IPTV_PLAYBACK_UNAVAILABLE", "Movie and episode playback is coming in a later update.", 422);
    const item = await this.persistence.iptvCatalogue({ action: "item", providerId: identity.providerId, contentType: "live", itemId: identity.itemId });
    if (!item) throw new AppError("IPTV_NOT_FOUND", "This channel is no longer in the saved catalogue.", 404);
    if (isIptvProviderHeading((item as IptvCatalogueRecord).name)) throw new AppError("IPTV_CHANNEL_HEADING", "This is a provider section heading. Choose a station from the channel list.", 422);
    const setup = await this.store.readConfiguration(identity.providerId);
    signal.throwIfAborted();
    if (!setup) throw new AppError("IPTV_NOT_FOUND", "Provider removed.", 404);
    return new IptvStream(this.client.liveAddress(setup, identity.itemId));
  }

  async schedule(providerId: string, channelId: string): Promise<IptvChannelSchedule> {
    if (this.closed || this.removed.has(providerId)) throw new AppError("IPTV_NOT_FOUND", "Provider removed or application closing.", 404);
    const key = `${providerId}:${channelId}`;
    const guide = this.guideIndexes.get(providerId);
    if (guide?.loaded && Date.now() - guide.createdAt < 3600000) {
      const result = await guide.schedule(channelId).catch(() => null);
      if (result?.programmes.length) return result;
    }
    const cached = this.schedules.get(key);
    if (cached && Date.now() - Date.parse(cached.fetchedAt) < 5 * 60_000) return cached;
    const existing = this.scheduleJobs.get(key); if (existing) return existing;
    if (this.scheduleJobs.size >= 8) throw new AppError("IPTV_GUIDE_BUSY", "Guide requests are busy. Retry shortly.", 429);
    const pending = (async () => {
      try {
        const item = await this.persistence.iptvCatalogue({ action: "item", providerId, contentType: "live", itemId: channelId });
        const setup = await this.store.readConfiguration(providerId);
        if (!item || !setup || this.closed) throw new AppError("IPTV_NOT_FOUND", "Provider or channel removed.", 404);
        const result = await this.client.schedule(setup, channelId, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(20000)]));
        if (this.closed || this.removed.has(providerId)) throw new Error();
        if (this.schedules.size >= 200) this.schedules.delete(this.schedules.keys().next().value!);
        this.schedules.set(key, result); return result;
      } catch {
        if (cached && !this.closed && !this.removed.has(providerId)) return { ...cached, stale: true };
        throw new AppError("IPTV_GUIDE_UNAVAILABLE", "Programme information is unavailable for this channel. You can still watch live.", 502);
      }
    })().finally(() => this.scheduleJobs.delete(key));
    this.scheduleJobs.set(key, pending); return pending;
  }

  private async snapshot(providerId: string): Promise<IptvCatalogueSnapshot | null> {
    return this.persistence.iptvCatalogue({ action: "status", providerId }) as Promise<IptvCatalogueSnapshot | null>;
  }

  async groups(providerId: string, contentType: IptvCatalogueRecord["contentType"]): Promise<IptvGroup[]> {
    return this.persistence.iptvCatalogue({ action: "groups", providerId, contentType }) as Promise<IptvGroup[]>;
  }

  async favourite(input: { providerId: string; channelId: string; favourite: boolean }): Promise<void> {
    if (this.closed || this.removed.has(input.providerId)) throw new AppError("IPTV_NOT_FOUND", "Provider removed.", 404);
    const item = await this.persistence.iptvCatalogue({ action: "item", providerId: input.providerId, contentType: "live", itemId: input.channelId }) as IptvCatalogueRecord | null;
    if (!item || isIptvProviderHeading(item.name)) throw new AppError("IPTV_NOT_FOUND", "This channel is no longer available.", 404);
    await this.persistence.iptvCatalogue({ action: "favourite", ...input });
  }

  async catalogue(input: z.input<typeof iptvCatalogueSchema>): Promise<IptvPage<IptvCatalogueItem>> {
    const value = iptvCatalogueSchema.parse(input);
    if (value.includeHidden) throw new AppError("IPTV_FILTER_UNAVAILABLE", "Hidden channels are not available in this preview.", 422);
    const snapshot = await this.snapshot(value.providerId);
    if (!snapshot) return { items: [], nextCursor: null, snapshotId: "" };
    const query = value.query?.normalize("NFKC").toLowerCase() ?? "";
    let programmeChannelIds: string[] | undefined;
    let guideGeneration: string | undefined;
    if (query && value.contentType === "live" && value.programmeWindow) {
      let index = this.guideIndexes.get(value.providerId);
      if (index && Date.now() - index.createdAt >= 3600000) { this.guideIndexes.delete(value.providerId); await index.close(); index = undefined; }
      if (!index) {
        const setup = await this.store.readConfiguration(value.providerId);
        if (!setup || this.closed || this.removed.has(value.providerId)) throw new AppError("IPTV_NOT_FOUND", "Provider unavailable.", 404);
        index = this.guideIndexes.get(value.providerId);
        if (!index) { index = new IptvGuideIndex(setup); this.guideIndexes.set(value.providerId, index); }
      }
      try { programmeChannelIds = await index.search(query, Date.parse(value.programmeWindow.startUtc), Date.parse(value.programmeWindow.endUtc)); guideGeneration = index.generation; }
      catch (error) { if (this.guideIndexes.get(value.providerId) === index) this.guideIndexes.delete(value.providerId); await index.close(); throw error; }
    }
    const filter = createHash("sha256").update(JSON.stringify([value.providerId, value.contentType, query, value.groupId ?? null, value.favouritesOnly, value.programmeWindow, guideGeneration])).digest("hex");
    let afterName: string | null = null; let afterId: string | null = null;
    let afterFavourite = false;
    if (value.cursor) {
      try {
        const cursor = cursorSchema.parse(JSON.parse(Buffer.from(value.cursor, "base64url").toString("utf8")));
        if (cursor.filter !== filter || cursor.snapshot !== snapshot.snapshotId) throw new Error("stale");
        afterName = cursor.name; afterId = cursor.id;
        afterFavourite = cursor.favourite;
      } catch { throw new AppError("IPTV_SNAPSHOT_STALE", "The catalogue changed. Search again.", 409); }
    }
    const rows = await this.persistence.iptvCatalogue({ action: "page", providerId: value.providerId, snapshotId: snapshot.snapshotId, contentType: value.contentType, query, groupId: value.groupId ?? null, afterName, afterId, afterFavourite, limit: value.limit + 1, favouritesOnly: value.favouritesOnly, programmeChannelIds }) as IptvCatalogueRecord[];
    const more = rows.length > value.limit;
    const page = rows.slice(0, value.limit);
    const last = page.at(-1);
    return {
      snapshotId: snapshot.snapshotId,
      items: page.map((row) => ({ identity: { providerId: value.providerId, contentType: row.contentType, itemId: row.itemId }, name: row.name, groupId: row.groupId, groupName: row.groupName, channelNumber: row.channelNumber, favourite: row.favourite ?? false, hidden: false })),
      nextCursor: more && last ? Buffer.from(JSON.stringify({ snapshot: snapshot.snapshotId, filter, name: last.nameKey, id: last.itemId, favourite: last.favourite ?? false })).toString("base64url") : null,
    };
  }
}
