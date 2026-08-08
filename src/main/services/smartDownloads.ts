import type {
  JellyfinConnectionDiagnostics,
  MediaItem,
  SmartDownloadsState,
  SmartDownloadUnfollowResult,
  SmartSeriesSummary,
} from "../../shared/contracts";
import { AppError, toPublicError } from "./errors";
import type { AuthenticatedContext, JellyfinApi, SeriesEpisodesPage } from "./jellyfinApi";
import type { AppLogger } from "./logger";
import type { SqlitePersistenceService } from "./persistence";
import type { DownloadBundleRecord, SmartSeriesRecord } from "./persistenceTypes";

const EPISODE_PAGE_SIZE = 200;
const CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000;

type SmartDownloadApi = Pick<JellyfinApi,
  | "getAuthenticatedContext"
  | "getAuthenticatedSocketContext"
  | "getConnectionDiagnostics"
  | "onConnectionDiagnostics"
  | "getDetails"
  | "getSeriesEpisodesPage"
>;

interface SmartDownloadQueue {
  startSmart(itemId: string): Promise<unknown>;
  cancel(downloadId: string): Promise<unknown>;
  delete(downloadId: string): Promise<unknown>;
  setSmartManaged(downloadId: string, smartManaged: boolean): Promise<unknown>;
  refreshSummaries(): Promise<void>;
}

interface ReconcileResult {
  queued: number;
  removed: number;
}

function isOffline(diagnostics: JellyfinConnectionDiagnostics): boolean {
  return diagnostics.state === "offline" || diagnostics.state === "reconnecting";
}

function effectiveDownloadOccupiesTarget(bundle: DownloadBundleRecord): boolean {
  if (["queued", "downloading", "paused", "failed"].includes(bundle.job.state)) return true;
  return bundle.job.state === "completed"
    && bundle.localVersion?.fileState === "finalized"
    && bundle.localVersion.probeState === "valid";
}

function regularEpisode(item: MediaItem): boolean {
  return item.type === "Episode"
    && item.playable
    && item.parentIndexNumber !== null
    && item.parentIndexNumber > 0
    && item.indexNumber !== null
    && item.indexNumber > 0;
}

function episodeOrder(left: MediaItem, right: MediaItem): number {
  return (left.parentIndexNumber ?? Number.MAX_SAFE_INTEGER) - (right.parentIndexNumber ?? Number.MAX_SAFE_INTEGER)
    || (left.indexNumber ?? Number.MAX_SAFE_INTEGER) - (right.indexNumber ?? Number.MAX_SAFE_INTEGER)
    || left.id.localeCompare(right.id);
}

export class SmartDownloadService {
  private identity: AuthenticatedContext | null = null;
  private active = false;
  private serviceRevision = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<string | null> | null = null;
  private pendingAll = false;
  private readonly pendingSeries = new Set<string>();
  private readonly checkingSeries = new Set<string>();
  private readonly deferredCleanupSeries = new Set<string>();
  private readonly listeners = new Set<(state: SmartDownloadsState) => void>();
  private readonly unsubscribeConnection: () => void;
  private lastConnectionState: JellyfinConnectionDiagnostics["state"];

  constructor(
    private readonly api: SmartDownloadApi,
    private readonly persistence: SqlitePersistenceService,
    private readonly downloads: SmartDownloadQueue,
    private readonly isItemPlaying: (itemId: string) => boolean,
    private readonly logger: AppLogger,
    private readonly intervalMilliseconds = CHECK_INTERVAL_MS,
  ) {
    this.lastConnectionState = api.getConnectionDiagnostics().state;
    this.unsubscribeConnection = api.onConnectionDiagnostics((diagnostics) => {
      const previousState = this.lastConnectionState;
      this.lastConnectionState = diagnostics.state;
      if (previousState === diagnostics.state) return;
      void this.emit();
      if (this.active && diagnostics.state === "connected"
        && (previousState === "offline" || previousState === "reconnecting")) {
        void this.requestCheck();
      }
    });
  }

  onChanged(listener: (state: SmartDownloadsState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async activate(): Promise<void> {
    this.identity = this.api.getAuthenticatedContext();
    this.active = true;
    this.serviceRevision += 1;
    if (!this.timer) {
      this.timer = setInterval(() => { void this.requestCheck(); }, this.intervalMilliseconds);
      this.timer.unref?.();
    }
    await this.emit();
    void this.requestCheck();
  }

  async deactivate(): Promise<void> {
    this.active = false;
    this.identity = null;
    this.serviceRevision += 1;
    this.pendingAll = false;
    this.pendingSeries.clear();
    this.checkingSeries.clear();
    this.deferredCleanupSeries.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    await this.deactivate();
    this.unsubscribeConnection();
    this.listeners.clear();
  }

  async getState(notice: string | null = null): Promise<SmartDownloadsState> {
    const identity = this.requireIdentity();
    const records = await this.persistence.listSmartSeries(identity.serverId, identity.userId);
    const offline = isOffline(this.api.getConnectionDiagnostics());
    return {
      series: records.map((record) => this.toSummary(record, offline)),
      notice,
    };
  }

  async follow(seriesId: string, episodeLimit: number): Promise<SmartDownloadsState> {
    const identity = this.requireIdentity();
    const item = await this.api.getDetails(seriesId);
    if (item.id !== seriesId || item.type !== "Series") {
      throw new AppError("SMART_DOWNLOAD_SERIES_REQUIRED", "Smart Downloads can follow only a series.", 422);
    }
    await this.persistence.upsertSmartSeries({
      serverId: identity.serverId,
      userId: identity.userId,
      seriesId,
      seriesName: item.name,
      episodeLimit,
    });
    await this.emit();
    return this.requestCheck(seriesId);
  }

  async setLimit(seriesId: string, episodeLimit: number): Promise<SmartDownloadsState> {
    const identity = this.requireIdentity();
    const existing = (await this.persistence.listSmartSeries(identity.serverId, identity.userId))
      .find((record) => record.seriesId === seriesId);
    if (!existing) throw new AppError("SMART_SERIES_NOT_FOUND", "That series is not followed.", 404);
    await this.persistence.upsertSmartSeries({
      serverId: identity.serverId,
      userId: identity.userId,
      seriesId,
      seriesName: existing.seriesName,
      episodeLimit,
    });
    await this.emit();
    return this.requestCheck(seriesId);
  }

  async checkNow(): Promise<SmartDownloadsState> {
    return this.requestCheck();
  }

  async skip(downloadId: string): Promise<SmartDownloadsState> {
    const identity = this.requireIdentity();
    const bundle = await this.persistence.getDownloadBundle(downloadId);
    if (!bundle || bundle.job.serverId !== identity.serverId || bundle.job.userId !== identity.userId
      || !bundle.job.smartManaged || !bundle.item.seriesId) {
      throw new AppError("SMART_DOWNLOAD_NOT_FOUND", "That Smart Download could not be found.", 404);
    }
    const followed = (await this.persistence.listSmartSeries(identity.serverId, identity.userId))
      .some((record) => record.seriesId === bundle.item.seriesId);
    if (!followed) throw new AppError("SMART_SERIES_NOT_FOUND", "That series is no longer followed.", 404);
    await this.persistence.addSmartEpisodeSkip(identity.serverId, identity.userId, bundle.item.seriesId, bundle.job.itemId);
    await this.removeBundle(bundle);
    await this.downloads.setSmartManaged(downloadId, false).catch(() => undefined);
    return this.requestCheck(bundle.item.seriesId);
  }

  async unfollow(seriesId: string, disposition: "keep" | "remove"): Promise<SmartDownloadUnfollowResult> {
    const identity = this.requireIdentity();
    const followed = (await this.persistence.listSmartSeries(identity.serverId, identity.userId))
      .some((record) => record.seriesId === seriesId);
    if (!followed) throw new AppError("SMART_SERIES_NOT_FOUND", "That series is not followed.", 404);
    let warning: string | null = null;
    if (disposition === "keep") {
      await this.persistence.unfollowSmartSeriesKeep(identity.serverId, identity.userId, seriesId);
    } else {
      const bundles = (await this.persistence.listDownloadBundles(identity.serverId, identity.userId))
        .filter((bundle) => bundle.item.seriesId === seriesId && bundle.job.smartManaged);
      for (const bundle of bundles) {
        if (bundle.job.keepDownloaded || this.isItemPlaying(bundle.job.itemId)) {
          await this.downloads.setSmartManaged(bundle.job.downloadId, false);
          continue;
        }
        try {
          await this.removeBundle(bundle);
          await this.downloads.setSmartManaged(bundle.job.downloadId, false);
        } catch (error) {
          await this.downloads.setSmartManaged(bundle.job.downloadId, false).catch(() => undefined);
          warning = "Some copies could not be removed and were kept as ordinary downloads.";
          this.logger.warn("A Smart Download copy could not be removed during unfollow.", error);
        }
      }
      await this.persistence.deleteSmartSeries(identity.serverId, identity.userId, seriesId);
    }
    this.deferredCleanupSeries.delete(seriesId);
    await this.downloads.refreshSummaries();
    const state = await this.getState();
    await this.emitState(state);
    return { state, warning };
  }

  async notifyWatchedItem(itemId: string): Promise<void> {
    if (!this.active || !this.identity) return;
    const item = await this.persistence.getMediaItem(this.identity.serverId, this.identity.userId, itemId).catch(() => null);
    if (item?.seriesId) void this.requestCheck(item.seriesId);
  }

  notifyPlaybackStopped(): void {
    if (!this.active || this.deferredCleanupSeries.size === 0) return;
    const pending = [...this.deferredCleanupSeries];
    this.deferredCleanupSeries.clear();
    for (const seriesId of pending) this.pendingSeries.add(seriesId);
    void this.requestCheckDrain();
  }

  private requireIdentity(): AuthenticatedContext {
    if (!this.active || !this.identity) throw new AppError("NOT_AUTHENTICATED", "Sign in to Jellyfin first.", 401);
    return this.identity;
  }

  private toSummary(record: SmartSeriesRecord, offline: boolean): SmartSeriesSummary {
    const status: SmartSeriesSummary["status"] = this.checkingSeries.has(record.seriesId)
      ? "checking"
      : offline
        ? "offline"
        : record.lastErrorCode
          ? "attention"
          : "ready";
    return {
      seriesId: record.seriesId,
      name: record.seriesName,
      episodeLimit: record.episodeLimit,
      status,
      lastSuccessfulCheck: record.lastSuccessfulCheck,
      error: record.lastErrorCode && record.lastErrorMessage && record.lastErrorAt !== null
        ? { code: record.lastErrorCode, message: record.lastErrorMessage, occurredAt: record.lastErrorAt }
        : null,
    };
  }

  private requestCheck(seriesId?: string): Promise<SmartDownloadsState> {
    if (seriesId) this.pendingSeries.add(seriesId);
    else {
      this.pendingAll = true;
      this.pendingSeries.clear();
    }
    return this.requestCheckDrain();
  }

  private async requestCheckDrain(): Promise<SmartDownloadsState> {
    if (!this.active) return this.getState();
    let notice: string | null = null;
    do {
      if (!this.running) {
        this.running = this.drainChecks().finally(() => { this.running = null; });
      }
      notice = (await this.running) ?? notice;
    } while (this.pendingAll || this.pendingSeries.size > 0);
    return this.getState(notice);
  }

  private async drainChecks(): Promise<string | null> {
    let queued = 0;
    while (this.active && (this.pendingAll || this.pendingSeries.size > 0)) {
      const identity = this.requireIdentity();
      const records = await this.persistence.listSmartSeries(identity.serverId, identity.userId);
      const requested = this.pendingAll
        ? records
        : records.filter((record) => this.pendingSeries.has(record.seriesId));
      this.pendingAll = false;
      this.pendingSeries.clear();
      for (const record of requested) {
        if (!this.active) break;
        const result = await this.reconcileSafely(record);
        queued += result.queued;
      }
    }
    const notice = queued > 0
      ? `Smart Downloads queued ${queued} ${queued === 1 ? "episode" : "episodes"}.`
      : null;
    await this.emit(notice);
    return notice;
  }

  private async reconcileSafely(rule: SmartSeriesRecord): Promise<ReconcileResult> {
    const identity = this.requireIdentity();
    const serviceRevision = this.serviceRevision;
    this.checkingSeries.add(rule.seriesId);
    await this.emit();
    try {
      const result = await this.reconcile(rule, identity, serviceRevision);
      if (this.active && this.serviceRevision === serviceRevision) {
        await this.persistence.recordSmartSeriesCheck(identity.serverId, identity.userId, rule.seriesId, {
          success: true,
          checkedAt: Date.now(),
        });
      }
      return result;
    } catch (error) {
      const publicError = toPublicError(error);
      if (this.active && this.serviceRevision === serviceRevision) {
        await this.persistence.recordSmartSeriesCheck(identity.serverId, identity.userId, rule.seriesId, {
          success: false,
          errorCode: publicError.code,
          errorMessage: publicError.message,
          errorAt: Date.now(),
        }).catch(() => undefined);
      }
      this.logger.warn("A Smart Download series check failed.", { seriesId: rule.seriesId, error: publicError });
      return { queued: 0, removed: 0 };
    } finally {
      this.checkingSeries.delete(rule.seriesId);
      await this.emit();
    }
  }

  private async reconcile(
    rule: SmartSeriesRecord,
    identity: AuthenticatedContext,
    serviceRevision: number,
  ): Promise<ReconcileResult> {
    const sessionRevision = this.api.getAuthenticatedSocketContext().sessionRevision;
    const episodes = await this.enumerateEpisodes(rule.seriesId, sessionRevision);
    this.assertCurrent(identity, serviceRevision, sessionRevision);
    const [skips, bundles, playbackHeads] = await Promise.all([
      this.persistence.listSmartEpisodeSkips(identity.serverId, identity.userId, rule.seriesId),
      this.persistence.listDownloadBundles(identity.serverId, identity.userId),
      this.persistence.listPlaybackHeadsForSeries(identity.serverId, identity.userId, rule.seriesId),
    ]);
    this.assertCurrent(identity, serviceRevision, sessionRevision);
    const skipIds = new Set(skips);
    const watchedIds = new Set(playbackHeads.filter((head) => head.watched).map((head) => head.itemId));
    const targets = episodes
      .filter(regularEpisode)
      .filter((episode) => !episode.userData.played && !watchedIds.has(episode.id) && !skipIds.has(episode.id))
      .sort(episodeOrder)
      .slice(0, rule.episodeLimit);
    const targetIds = new Set(targets.map((episode) => episode.id));
    const enumeratedIds = new Set(episodes.map((episode) => episode.id));
    const seriesBundles = bundles.filter((bundle) => bundle.item.seriesId === rule.seriesId);
    let queued = 0;
    let removed = 0;
    for (const target of targets) {
      const occupied = seriesBundles.some((bundle) => bundle.job.itemId === target.id && effectiveDownloadOccupiesTarget(bundle));
      if (occupied) continue;
      this.assertCurrent(identity, serviceRevision, sessionRevision);
      await this.downloads.startSmart(target.id);
      queued += 1;
    }
    this.assertCurrent(identity, serviceRevision, sessionRevision);
    for (const bundle of seriesBundles) {
      if (!bundle.job.smartManaged || bundle.job.keepDownloaded || targetIds.has(bundle.job.itemId)) continue;
      if (!enumeratedIds.has(bundle.job.itemId)) continue;
      if (this.isItemPlaying(bundle.job.itemId)) {
        this.deferredCleanupSeries.add(rule.seriesId);
        continue;
      }
      await this.removeBundle(bundle);
      await this.downloads.setSmartManaged(bundle.job.downloadId, false);
      removed += 1;
    }
    return { queued, removed };
  }

  private async enumerateEpisodes(seriesId: string, sessionRevision: number): Promise<MediaItem[]> {
    const items: MediaItem[] = [];
    const identities = new Set<string>();
    let expectedTotal: number | null = null;
    let startIndex = 0;
    while (expectedTotal === null || startIndex < expectedTotal) {
      const page: SeriesEpisodesPage = await this.api.getSeriesEpisodesPage(seriesId, startIndex, EPISODE_PAGE_SIZE);
      if (page.startIndex !== startIndex || page.sessionRevision !== sessionRevision) {
        throw new AppError("EPISODE_ENUMERATION_STALE", "The Jellyfin session changed while episodes were loading.", 409);
      }
      if (expectedTotal === null) expectedTotal = page.totalRecordCount;
      if (page.totalRecordCount !== expectedTotal) {
        throw new AppError("EPISODE_ENUMERATION_CHANGED", "The episode list changed while it was loading.", 409);
      }
      const expectedPageLength = Math.min(EPISODE_PAGE_SIZE, expectedTotal - startIndex);
      if (page.items.length !== expectedPageLength) {
        throw new AppError("EPISODE_ENUMERATION_INCOMPLETE", "Jellyfin returned an incomplete episode list.", 502);
      }
      for (const item of page.items) {
        if (!item.id.trim() || item.type !== "Episode" || identities.has(item.id)) {
          throw new AppError("EPISODE_ENUMERATION_INVALID", "Jellyfin returned invalid episode identities.", 502);
        }
        identities.add(item.id);
        items.push(item);
      }
      startIndex += page.items.length;
    }
    if (expectedTotal === null || items.length !== expectedTotal || identities.size !== expectedTotal) {
      throw new AppError("EPISODE_ENUMERATION_INCOMPLETE", "Jellyfin returned an incomplete episode list.", 502);
    }
    return items;
  }

  private assertCurrent(identity: AuthenticatedContext, serviceRevision: number, sessionRevision: number): void {
    const current = this.api.getAuthenticatedContext();
    const currentSessionRevision = this.api.getAuthenticatedSocketContext().sessionRevision;
    if (!this.active || this.serviceRevision !== serviceRevision || currentSessionRevision !== sessionRevision
      || current.serverId !== identity.serverId || current.userId !== identity.userId) {
      throw new AppError("SESSION_CHANGED", "The Jellyfin session changed during the Smart Download check.", 409);
    }
  }

  private async removeBundle(bundle: DownloadBundleRecord): Promise<void> {
    if (["queued", "downloading", "paused", "failed"].includes(bundle.job.state)) {
      await this.downloads.cancel(bundle.job.downloadId);
      return;
    }
    if (bundle.job.state === "completed" && bundle.localVersion?.fileState === "finalized") {
      await this.downloads.delete(bundle.job.downloadId);
      return;
    }
    await this.downloads.setSmartManaged(bundle.job.downloadId, false);
  }

  private async emit(notice: string | null = null): Promise<void> {
    if (!this.active || !this.identity) return;
    try { await this.emitState(await this.getState(notice)); } catch { /* Session teardown races are expected. */ }
  }

  private async emitState(state: SmartDownloadsState): Promise<void> {
    for (const listener of this.listeners) listener(state);
  }
}

export { CHECK_INTERVAL_MS, EPISODE_PAGE_SIZE };
