import { mkdir, open, rename, rm, stat, statfs } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DownloadSummary, MediaItem, MediaSourceCapabilities, OfflinePlayableSummary, PlaybackDiagnostics } from "../../shared/contracts";
import { materializeCachedMediaItem } from "./cachedMedia";
import { AppError, toPublicError } from "./errors";
import type { AuthenticatedContext, JellyfinApi } from "./jellyfinApi";
import type { AppLogger } from "./logger";
import type { MediaProbeService } from "./mediaProbe";
import type { SqlitePersistenceService } from "./persistence";
import type { DownloadBundleRecord, DownloadJobRecord, LocalVersionRecord } from "./persistenceTypes";
import {
  ActiveProgressiveDownloadLease,
  type ProgressiveDownloadLease,
  type ProgressiveDownloadProvider,
  type ProgressiveLeaseInvalidationReason,
} from "./progressiveDownload";

type DownloadApi = Pick<JellyfinApi,
  "getAuthenticatedContext" | "getDetails" | "getMediaSourceCapabilities" | "fetchStaticStream"
>;

type StopIntent = "pause" | "cancel" | "session" | "shutdown";

interface ActiveTransfer {
  controller: AbortController;
  promise: Promise<void>;
}

interface DownloadManagerOptions {
  concurrency?: number;
  storageReserveBytes?: number;
  availableBytes?: (storageRoot: string) => Promise<number>;
  authorizedRoots?: string[];
}

const DEFAULT_STORAGE_RESERVE = 1024 * 1024 * 1024;

export function progressiveStartupThreshold(expectedSize: number, bitrate: number | null): number {
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) return Number.MAX_SAFE_INTEGER;
  const thirtySecondBytes = bitrate !== null && Number.isFinite(bitrate) && bitrate > 0
    ? Math.ceil(bitrate * 30 / 8)
    : 32 * 1024 * 1024;
  return Math.min(expectedSize, Math.max(8 * 1024 * 1024, thirtySecondBytes));
}

function safeExpectedSize(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeContainer(value: string | null): string {
  const candidate = value?.split(",", 1)[0]?.trim().toLocaleLowerCase("en-US") ?? "";
  return /^[a-z0-9]{1,8}$/.test(candidate) ? candidate : "media";
}

function responseExpectedSize(response: Response, offset: number): number | null {
  const range = response.headers.get("content-range");
  const rangeMatch = range ? /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(range) : null;
  if (rangeMatch && rangeMatch[3] !== "*") {
    const total = Number(rangeMatch[3]);
    if (Number.isSafeInteger(total) && total >= offset) return total;
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(length) && length >= 0) return offset + length;
  return null;
}

function isNoSpaceError(error: unknown): boolean {
  return (error as { code?: unknown })?.code === "ENOSPC";
}

function cachedSourceDiagnostics(
  source: MediaSourceCapabilities["sources"][number],
  sourceKind: PlaybackDiagnostics["sourceKind"],
): PlaybackDiagnostics {
  return {
    sourceKind,
    playbackRate: 1,
    bufferAheadTicks: null,
    container: source.container,
    videoCodec: source.videoCodec ?? null,
    audioCodec: source.audioCodec ?? null,
    audioChannels: source.audioChannels ?? null,
    resolution: source.width && source.height ? `${source.width}×${source.height}` : null,
    bitrate: source.bitrate ?? null,
    videoRange: source.videoRange ?? null,
    transcodeReason: null,
  };
}

export class DownloadManager implements ProgressiveDownloadProvider {
  private readonly concurrency: number;
  private readonly storageReserveBytes: number;
  private readonly availableBytes: (storageRoot: string) => Promise<number>;
  private identity: AuthenticatedContext | null = null;
  private revision = 0;
  private stopped = false;
  private pumping = false;
  private readonly transfers = new Map<string, ActiveTransfer>();
  private readonly stopIntents = new Map<string, StopIntent>();
  private readonly listeners = new Set<(downloads: DownloadSummary[]) => void>();
  private readonly progressiveLeases = new Map<string, Set<ActiveProgressiveDownloadLease>>();
  private readonly transferBytes = new Map<string, number>();
  private readonly authorizedRoots = new Map<string, string>();
  private storageRoot: string;

  constructor(
    private readonly api: DownloadApi,
    private readonly persistence: SqlitePersistenceService,
    private readonly probe: MediaProbeService,
    storageRoot: string,
    private readonly logger: AppLogger,
    options: DownloadManagerOptions = {},
  ) {
    if (!isAbsolute(storageRoot)) throw new AppError("INVALID_DOWNLOAD_STORAGE", "Download storage must use an absolute path.", 500);
    this.storageRoot = resolve(storageRoot);
    this.addAuthorizedRoot(this.storageRoot);
    for (const root of options.authorizedRoots ?? []) this.addAuthorizedRoot(root);
    this.concurrency = Math.max(1, Math.min(4, options.concurrency ?? 2));
    this.storageReserveBytes = Math.max(0, options.storageReserveBytes ?? DEFAULT_STORAGE_RESERVE);
    this.availableBytes = options.availableBytes ?? (async (root) => {
      const value = await statfs(root, { bigint: true });
      const available = value.bavail * value.bsize;
      return available > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(available);
    });
  }

  setStorageRoot(storageRoot: string): void {
    if (!isAbsolute(storageRoot)) throw new AppError("INVALID_DOWNLOAD_STORAGE", "Download storage must use an absolute path.", 500);
    this.storageRoot = resolve(storageRoot);
    this.addAuthorizedRoot(this.storageRoot);
  }

  addAuthorizedRoot(storageRoot: string): void {
    if (!isAbsolute(storageRoot)) throw new AppError("INVALID_DOWNLOAD_STORAGE", "Download storage must use an absolute path.", 500);
    const normalized = resolve(storageRoot);
    const key = process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
    this.authorizedRoots.set(key, normalized);
  }

  onChanged(listener: (downloads: DownloadSummary[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async activate(): Promise<void> {
    if (this.stopped) throw new AppError("DOWNLOADS_STOPPED", "The download service is stopping.", 503);
    const identity = this.api.getAuthenticatedContext();
    const changed = !this.identity
      || this.identity.serverId !== identity.serverId
      || this.identity.userId !== identity.userId;
    if (changed && this.transfers.size) await this.deactivate("session");
    this.identity = identity;
    this.revision += 1;
    await this.persistence.upsertCatalogIdentity({
      serverId: identity.serverId,
      serverAddress: identity.serverAddress,
      serverName: identity.serverName,
      userId: identity.userId,
      userName: identity.userName,
    });
    await this.notify();
    this.pump();
  }

  async deactivate(intent: "session" | "shutdown" = "session"): Promise<void> {
    this.revision += 1;
    this.identity = null;
    await this.invalidateAllLeases(intent === "shutdown" ? "shutdown" : "session-changed");
    const pending: Promise<void>[] = [];
    for (const [downloadId, transfer] of this.transfers) {
      this.stopIntents.set(downloadId, intent);
      transfer.controller.abort();
      pending.push(transfer.promise);
    }
    await Promise.allSettled(pending);
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.deactivate("shutdown");
    this.listeners.clear();
  }

  async list(): Promise<DownloadSummary[]> {
    const identity = this.requireIdentity();
    return this.listFor(identity);
  }

  async listOfflinePlayable(): Promise<OfflinePlayableSummary[]> {
    const identity = this.requireIdentity();
    const records = await this.persistence.listOfflinePlayableItems(identity.serverId, identity.userId);
    return records.map((record) => {
      const item = materializeCachedMediaItem(record.item, record.playbackHead);
      return {
        item,
        resumePositionTicks: item.userData.playbackPositionTicks,
        sourceKind: "offline-local",
        localPlaybackAvailable: true,
      };
    });
  }

  async acquireProgressive(itemId: string): Promise<ProgressiveDownloadLease | null> {
    const identity = this.requireIdentity();
    const bundles = await this.persistence.listDownloadBundles(identity.serverId, identity.userId);
    const bundle = bundles.find((candidate) => candidate.job.itemId === itemId);
    const job = bundle?.job;
    if (!bundle || !job || !job.mediaSourceId || !job.expectedSize || job.expectedSize <= 0) return null;
    const candidate = await this.progressiveCandidate(bundle);
    if (!candidate) return null;
    const { partialPath, recordedBytes } = candidate;
    const local = bundle.localVersion!;
    const item = materializeCachedMediaItem(bundle.item, bundle.playbackHead);
    const mediaSource = await this.persistence.getMediaSource(
      identity.serverId,
      identity.userId,
      itemId,
      job.mediaSourceId,
    ).catch(() => null);
    const diagnostics: PlaybackDiagnostics = {
      sourceKind: "downloading",
      playbackRate: 1,
      bufferAheadTicks: null,
      container: mediaSource?.diagnostics?.container ?? local.container,
      videoCodec: mediaSource?.diagnostics?.videoCodec ?? null,
      audioCodec: mediaSource?.diagnostics?.audioCodec ?? null,
      audioChannels: mediaSource?.diagnostics?.audioChannels ?? null,
      resolution: mediaSource?.diagnostics?.resolution ?? null,
      bitrate: mediaSource?.diagnostics?.bitrate ?? null,
      videoRange: mediaSource?.diagnostics?.videoRange ?? null,
      transcodeReason: null,
    };
    let lease!: ActiveProgressiveDownloadLease;
    lease = new ActiveProgressiveDownloadLease({
      descriptor: {
        item,
        itemId,
        itemType: bundle.itemType,
        seriesId: item.seriesId,
        mediaSourceId: job.mediaSourceId,
        durationTicks: Math.max(0, item.runTimeTicks),
        expectedSize: job.expectedSize,
        container: local.container,
        diagnostics,
      },
      initialPath: partialPath,
      initialBytes: recordedBytes,
      fetchMetadataRange: (range, signal) => this.api.fetchStaticStream(itemId, job.mediaSourceId!, range, signal),
      onRelease: () => {
        const leases = this.progressiveLeases.get(job.downloadId);
        leases?.delete(lease);
        if (leases?.size === 0) this.progressiveLeases.delete(job.downloadId);
      },
    });
    const leases = this.progressiveLeases.get(job.downloadId) ?? new Set<ActiveProgressiveDownloadLease>();
    leases.add(lease);
    this.progressiveLeases.set(job.downloadId, leases);
    return lease;
  }

  async start(itemId: string): Promise<DownloadSummary> {
    return this.startDownload(itemId, "manual");
  }

  async startSmart(itemId: string): Promise<DownloadSummary> {
    return this.startDownload(itemId, "smart");
  }

  private async startDownload(itemId: string, origin: "manual" | "smart"): Promise<DownloadSummary> {
    const identity = this.requireIdentity();
    const storageRoot = this.storageRoot;
    const existing = (await this.persistence.listDownloadBundles(identity.serverId, identity.userId))
      .find((bundle) => bundle.job.itemId === itemId
        && bundle.job.state !== "cancelled"
        && !(bundle.job.state === "completed" && bundle.localVersion?.fileState !== "finalized"));
    if (existing) return this.toSummary(existing);

    const item = await this.api.getDetails(itemId);
    if (item.type !== "Movie" && item.type !== "Episode") {
      throw new AppError("DOWNLOAD_NOT_SUPPORTED", "Only movies and individual episodes can be downloaded.", 400);
    }
    const capabilities = await this.api.getMediaSourceCapabilities(item.id);
    const source = this.chooseSource(capabilities);
    const expectedSize = safeExpectedSize(source.size);
    const container = safeContainer(source.container);
    const downloadId = crypto.randomUUID();
    const localPath = join(storageRoot, downloadId, `media.${container}`);

    await this.persistence.upsertMediaItem({
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: item.id,
      itemType: item.type,
      name: item.name,
      seriesId: item.seriesId,
      seasonId: item.seasonId,
      runTimeTicks: Math.max(0, Math.floor(item.runTimeTicks)),
      metadata: item,
    });
    await this.persistence.upsertMediaSource({
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: item.id,
      mediaSourceId: source.id,
      container: source.container,
      expectedSize,
      diagnostics: cachedSourceDiagnostics(source, "downloaded"),
    });
    const bundle = await this.persistence.createDownloadBundle({
      downloadId,
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: item.id,
      mediaSourceId: source.id,
      origin,
      smartManaged: origin === "smart",
      keepDownloaded: false,
      qualityProfile: null,
      expectedSize,
    }, {
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: item.id,
      mediaSourceId: source.id,
      downloadId,
      storageRoot,
      localPath,
      origin,
      smartManaged: origin === "smart",
      keepDownloaded: false,
      fileState: "staging",
      probeState: "pending",
      expectedSize,
      actualSize: null,
      container,
    });
    await this.notify();
    this.pump();
    return this.toSummary(bundle);
  }

  async pause(downloadId: string): Promise<DownloadSummary> {
    const bundle = await this.requireBundle(downloadId);
    const transfer = this.transfers.get(downloadId);
    if (transfer && (bundle.job.state === "queued" || bundle.job.state === "downloading")) {
      this.stopIntents.set(downloadId, "pause");
      transfer.controller.abort();
      await transfer.promise;
      return this.toSummary(await this.requireBundle(downloadId));
    }
    if (bundle.job.state === "queued") {
      const updated = await this.persistence.transitionDownload({ downloadId, state: "paused" });
      await this.notify();
      return this.toSummary({ ...bundle, job: updated });
    }
    if (bundle.job.state !== "downloading") throw new AppError("DOWNLOAD_NOT_PAUSABLE", "That download cannot be paused.", 409);
    const updated = await this.persistence.transitionDownload({ downloadId, state: "paused" });
    await this.notify();
    return this.toSummary({ ...bundle, job: updated });
  }

  async resume(downloadId: string): Promise<DownloadSummary> {
    const bundle = await this.requireBundle(downloadId);
    if (bundle.job.state !== "paused") throw new AppError("DOWNLOAD_NOT_RESUMABLE", "That download cannot be resumed.", 409);
    const job = await this.persistence.transitionDownload({ downloadId, state: "queued" });
    const updated = { ...bundle, job };
    await this.notify();
    this.pump();
    return this.toSummary(updated);
  }

  async retry(downloadId: string): Promise<DownloadSummary> {
    const bundle = await this.requireBundle(downloadId);
    if (bundle.job.state !== "failed") throw new AppError("DOWNLOAD_NOT_RETRYABLE", "That download cannot be retried.", 409);
    const job = await this.persistence.transitionDownload({ downloadId, state: "queued" });
    const updated = { ...bundle, job };
    await this.notify();
    this.pump();
    return this.toSummary(updated);
  }

  async cancel(downloadId: string): Promise<DownloadSummary> {
    const bundle = await this.requireBundle(downloadId);
    if (bundle.job.state === "completed" || bundle.job.state === "cancelled") {
      throw new AppError("DOWNLOAD_NOT_CANCELLABLE", "That download cannot be cancelled.", 409);
    }
    await this.invalidateLeases(downloadId, "cancelled");
    const transfer = this.transfers.get(downloadId);
    if (transfer && (bundle.job.state === "queued" || bundle.job.state === "downloading")) {
      this.stopIntents.set(downloadId, "cancel");
      transfer.controller.abort();
      await transfer.promise;
    } else {
      const job = await this.persistence.transitionDownload({ downloadId, state: "cancelled" });
      await this.cleanup(bundle.localVersion);
      if (bundle.localVersion) await this.persistence.updateLocalVersion({
        localVersionId: bundle.localVersion.localVersionId,
        fileState: "missing",
        probeState: "pending",
        actualSize: null,
      });
      await this.notify();
      return this.toSummary({ ...bundle, job, localVersion: bundle.localVersion ? { ...bundle.localVersion, fileState: "missing", actualSize: null } : null });
    }
    return this.toSummary(await this.requireBundle(downloadId));
  }

  async delete(downloadId: string): Promise<DownloadSummary> {
    const bundle = await this.requireBundle(downloadId);
    if (bundle.job.state !== "completed" || !bundle.localVersion) {
      throw new AppError("DOWNLOAD_NOT_DELETABLE", "Only completed downloaded copies can be deleted.", 409);
    }
    await this.invalidateLeases(downloadId, "deleted");
    await this.cleanup(bundle.localVersion);
    const localVersion = await this.persistence.updateLocalVersion({
      localVersionId: bundle.localVersion.localVersionId,
      fileState: "missing",
      probeState: "pending",
      actualSize: null,
    });
    const updated = { ...bundle, localVersion };
    await this.notify();
    return this.toSummary(updated);
  }

  async setKeep(downloadId: string, keepDownloaded: boolean): Promise<DownloadSummary> {
    await this.requireBundle(downloadId);
    const bundle = await this.persistence.setDownloadKeep(downloadId, keepDownloaded);
    await this.notify();
    return this.toSummary(bundle);
  }

  async setSmartManaged(downloadId: string, smartManaged: boolean): Promise<DownloadSummary> {
    await this.requireBundle(downloadId);
    const bundle = await this.persistence.setDownloadSmartManaged(downloadId, smartManaged);
    await this.notify();
    return this.toSummary(bundle);
  }

  async refreshSummaries(): Promise<void> {
    if (this.identity) await this.notify();
  }

  private requireIdentity(): AuthenticatedContext {
    if (!this.identity) throw new AppError("NOT_AUTHENTICATED", "Sign in to Jellyfin first.", 401);
    return this.identity;
  }

  private async requireBundle(downloadId: string): Promise<DownloadBundleRecord> {
    const identity = this.requireIdentity();
    const bundle = await this.persistence.getDownloadBundle(downloadId);
    if (!bundle || bundle.job.serverId !== identity.serverId || bundle.job.userId !== identity.userId) {
      throw new AppError("DOWNLOAD_NOT_FOUND", "That download could not be found.", 404);
    }
    return bundle;
  }

  private chooseSource(capabilities: MediaSourceCapabilities): MediaSourceCapabilities["sources"][number] {
    const source = capabilities.sources.find((entry) => entry.supportsDirectPlay) ?? capabilities.sources[0];
    if (!source) throw new AppError("DOWNLOAD_SOURCE_UNAVAILABLE", "Jellyfin did not provide a downloadable media source.", 422);
    return source;
  }

  private pump(): void {
    if (this.pumping || this.stopped || !this.identity) return;
    this.pumping = true;
    void this.pumpNow().finally(() => { this.pumping = false; });
  }

  private async pumpNow(): Promise<void> {
    const identity = this.identity;
    if (!identity) return;
    const revision = this.revision;
    const bundles = await this.persistence.listDownloadBundles(identity.serverId, identity.userId);
    for (const bundle of bundles.reverse()) {
      if (this.transfers.size >= this.concurrency) break;
      if (bundle.job.state !== "queued" || this.transfers.has(bundle.job.downloadId)) continue;
      const controller = new AbortController();
      const promise = this.runTransfer(bundle, revision, controller.signal)
        .catch((error) => this.logger.error("Download task failed safely.", { error }))
        .finally(() => {
          this.transfers.delete(bundle.job.downloadId);
          this.stopIntents.delete(bundle.job.downloadId);
          void this.notify();
          this.pump();
        });
      this.transfers.set(bundle.job.downloadId, { controller, promise });
    }
  }

  private async runTransfer(initial: DownloadBundleRecord, revision: number, signal: AbortSignal): Promise<void> {
    const downloadId = initial.job.downloadId;
    try {
      this.assertRevision(initial.job, revision);
      const local = initial.localVersion;
      if (!local) throw new AppError("DOWNLOAD_RECORD_INVALID", "The download has no authorized local destination.", 500);
      const storageRoot = resolve(local.storageRoot);
      const finalPath = this.authorizedPath(storageRoot, local.localPath);
      const folder = dirname(finalPath);
      const partialPath = this.authorizedPath(storageRoot, join(folder, "media.part"));
      await mkdir(folder, { recursive: true });

      const finalFile = await stat(finalPath).catch(() => null);
      if (finalFile?.isFile()) {
        const expected = initial.job.expectedSize;
        if (expected === null || finalFile.size === expected) {
          await this.persistence.transitionDownload({ downloadId, state: "downloading", bytesDownloaded: finalFile.size });
          const result = await this.probe.probe(storageRoot, finalPath, signal);
          await this.persistence.updateLocalVersion({
            localVersionId: local.localVersionId,
            fileState: "finalized",
            probeState: "valid",
            actualSize: result.actualSize,
          });
          await this.persistence.transitionDownload({ downloadId, state: "completed", bytesDownloaded: result.actualSize });
          this.completeLeases(downloadId, finalPath);
          return;
        }
        await rm(finalPath, { force: true });
      }

      const partial = await stat(partialPath).catch(() => null);
      let offset = partial?.isFile() ? partial.size : 0;
      this.transferBytes.set(downloadId, offset);
      if (initial.job.expectedSize !== null && offset > initial.job.expectedSize) {
        await rm(partialPath, { force: true });
        offset = 0;
        this.transferBytes.set(downloadId, offset);
      }
      if (initial.job.expectedSize !== null && offset === initial.job.expectedSize && offset > 0) {
        await this.persistence.transitionDownload({ downloadId, state: "downloading", bytesDownloaded: offset });
        await this.beginLeaseFinalization(downloadId);
        try {
          await rename(partialPath, finalPath);
          this.publishLeaseRenamed(downloadId, finalPath);
        } catch (error) {
          this.endLeaseFinalization(downloadId);
          throw error;
        }
        const result = await this.probe.probe(storageRoot, finalPath, signal);
        await this.persistence.updateLocalVersion({
          localVersionId: local.localVersionId,
          fileState: "finalized",
          probeState: "valid",
          actualSize: result.actualSize,
        });
        await this.persistence.transitionDownload({ downloadId, state: "completed", bytesDownloaded: result.actualSize });
        this.completeLeases(downloadId, finalPath);
        return;
      }
      await this.assertStorage(storageRoot, initial.job.expectedSize === null ? null : initial.job.expectedSize - offset);
      this.assertRevision(initial.job, revision);

      const response = await this.api.fetchStaticStream(
        initial.job.itemId,
        initial.job.mediaSourceId!,
        offset > 0 ? `bytes=${offset}-` : undefined,
        signal,
      );
      if (!response.body) throw new AppError("DOWNLOAD_RESPONSE_INVALID", "Jellyfin returned an empty download response.", 502);
      if (offset > 0 && response.status === 206) {
        const match = /^bytes\s+(\d+)-/i.exec(response.headers.get("content-range") ?? "");
        if (!match || Number(match[1]) !== offset) {
          await response.body.cancel();
          throw new AppError("DOWNLOAD_RANGE_INVALID", "Jellyfin returned an invalid resume response.", 502);
        }
      } else if (offset > 0) {
        offset = 0;
      }

      let expectedSize = initial.job.expectedSize;
      const headerSize = responseExpectedSize(response, offset);
      if (expectedSize === null && headerSize !== null) {
        expectedSize = headerSize;
        await this.persistence.setDownloadExpectedSize(downloadId, expectedSize);
      }
      await this.assertStorage(storageRoot, expectedSize === null ? null : expectedSize - offset);
      await this.persistence.transitionDownload({ downloadId, state: "downloading", bytesDownloaded: offset });
      await this.notify();

      const handle = await open(partialPath, offset > 0 ? "a" : "w");
      let bytes = offset;
      let lastSaved = Date.now();
      try {
        const reader = response.body.getReader();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (signal.aborted) throw new AppError("DOWNLOAD_CANCELLED", "The download was interrupted.", 409);
          await handle.write(chunk.value);
          bytes += chunk.value.byteLength;
          this.transferBytes.set(downloadId, bytes);
          this.publishLeaseBytes(downloadId, bytes);
          if (expectedSize !== null && bytes > expectedSize) {
            throw new AppError("DOWNLOAD_SIZE_MISMATCH", "The downloaded file exceeded its expected size.", 422);
          }
          if (Date.now() - lastSaved >= 500) {
            await this.persistence.transitionDownload({ downloadId, state: "downloading", bytesDownloaded: bytes });
            lastSaved = Date.now();
            void this.notify();
          }
        }
        await handle.sync();
      } finally {
        await handle.close().catch(() => undefined);
      }

      if (expectedSize !== null && bytes !== expectedSize) {
        throw new AppError("DOWNLOAD_SIZE_MISMATCH", "The downloaded file did not match its expected size.", 422);
      }
      await this.persistence.transitionDownload({ downloadId, state: "downloading", bytesDownloaded: bytes });
      await this.beginLeaseFinalization(downloadId);
      try {
        await rename(partialPath, finalPath);
        this.publishLeaseRenamed(downloadId, finalPath);
      } catch (error) {
        this.endLeaseFinalization(downloadId);
        throw error;
      }
      const result = await this.probe.probe(storageRoot, finalPath, signal);
      if (result.actualSize !== bytes) throw new AppError("DOWNLOAD_SIZE_MISMATCH", "The finalized file size changed unexpectedly.", 422);
      await this.persistence.updateLocalVersion({
        localVersionId: local.localVersionId,
        fileState: "finalized",
        probeState: "valid",
        actualSize: result.actualSize,
      });
      await this.persistence.transitionDownload({ downloadId, state: "completed", bytesDownloaded: result.actualSize });
      this.completeLeases(downloadId, finalPath);
    } catch (error) {
      await this.handleTransferError(initial, error);
    }
  }

  private async handleTransferError(initial: DownloadBundleRecord, error: unknown): Promise<void> {
    const downloadId = initial.job.downloadId;
    const intent = this.stopIntents.get(downloadId);
    const current = await this.persistence.getDownloadBundle(downloadId);
    if (!current || current.job.state === "completed" || current.job.state === "cancelled") return;
    if (intent === "cancel") {
      await this.invalidateLeases(downloadId, "cancelled");
      await this.persistence.transitionDownload({ downloadId, state: "cancelled" });
      await this.cleanup(current.localVersion);
      if (current.localVersion) await this.persistence.updateLocalVersion({
        localVersionId: current.localVersion.localVersionId,
        fileState: "missing",
        probeState: "pending",
        actualSize: null,
      });
      return;
    }
    if (intent) {
      await this.persistence.transitionDownload({
        downloadId,
        state: "paused",
        bytesDownloaded: this.transferBytes.get(downloadId) ?? current.job.bytesDownloaded,
      });
      return;
    }
    if (isNoSpaceError(error)) {
      await this.persistence.transitionDownload({
        downloadId,
        state: "paused",
        bytesDownloaded: this.transferBytes.get(downloadId) ?? current.job.bytesDownloaded,
        errorCode: "STORAGE_LIMIT",
        errorMessage: "Download paused because storage is full. Free space manually, then resume it.",
      });
      return;
    }
    const safe = toPublicError(error);
    await this.persistence.transitionDownload({
      downloadId,
      state: safe.code === "STORAGE_LIMIT" ? "paused" : "failed",
      bytesDownloaded: this.transferBytes.get(downloadId) ?? current.job.bytesDownloaded,
      errorCode: safe.code,
      errorMessage: safe.message,
    });
    if (current.localVersion && (safe.code.startsWith("MEDIA_PROBE") || safe.code === "DOWNLOAD_SIZE_MISMATCH")) {
      const finalPath = this.authorizedPath(current.localVersion.storageRoot, current.localVersion.localPath);
      const finalFile = await stat(finalPath).catch(() => null);
      if (!finalFile?.isFile()) return;
      await this.persistence.updateLocalVersion({
        localVersionId: current.localVersion.localVersionId,
        fileState: "invalid",
        probeState: "invalid",
        actualSize: finalFile.size,
      });
      await this.invalidateLeases(downloadId, "probe-failed");
    }
  }

  private assertRevision(job: DownloadJobRecord, revision: number): void {
    const identity = this.identity;
    if (!identity || revision !== this.revision || identity.serverId !== job.serverId || identity.userId !== job.userId) {
      throw new AppError("SESSION_CHANGED", "The Jellyfin session changed while downloading.", 409);
    }
  }

  private async assertStorage(storageRoot: string, remainingBytes: number | null): Promise<void> {
    const available = await this.availableBytes(storageRoot);
    const required = this.storageReserveBytes + Math.max(0, remainingBytes ?? 0);
    if (!Number.isFinite(available) || available < required) {
      throw new AppError("STORAGE_LIMIT", "Download paused because storage is full. Free space manually, then resume it.", 507);
    }
  }

  private authorizedPath(storageRoot: string, candidate: string): string {
    if (!isAbsolute(storageRoot)) {
      throw new AppError("INVALID_LOCAL_PATH", "A download path failed its storage-boundary check.", 400);
    }
    const root = resolve(storageRoot);
    const key = process.platform === "win32" ? root.toLocaleLowerCase("en-US") : root;
    if (!this.authorizedRoots.has(key)) {
      throw new AppError("INVALID_LOCAL_PATH", "A download path failed its storage-boundary check.", 400);
    }
    const target = resolve(candidate);
    const child = relative(root, target);
    if (!child || child.startsWith("..") || isAbsolute(child)) {
      throw new AppError("INVALID_LOCAL_PATH", "A download path failed its storage-boundary check.", 400);
    }
    return target;
  }

  private async cleanup(local: LocalVersionRecord | null): Promise<void> {
    if (!local) return;
    const target = this.authorizedPath(local.storageRoot, local.localPath);
    const folder = dirname(target);
    this.authorizedPath(local.storageRoot, folder);
    await rm(folder, { recursive: true, force: true });
  }

  private partialPath(local: LocalVersionRecord): string {
    const finalPath = this.authorizedPath(local.storageRoot, local.localPath);
    return this.authorizedPath(local.storageRoot, join(dirname(finalPath), "media.part"));
  }

  private progressiveThreshold(bundle: DownloadBundleRecord, bitrate: number | null = null): number {
    const expectedSize = bundle.job.expectedSize;
    return expectedSize === null ? Number.MAX_SAFE_INTEGER : progressiveStartupThreshold(expectedSize, bitrate);
  }

  private async progressiveCandidate(bundle: DownloadBundleRecord): Promise<{
    partialPath: string;
    recordedBytes: number;
  } | null> {
    const { job, localVersion: local } = bundle;
    if ((job.state !== "downloading" && job.state !== "paused")
      || !local || local.fileState !== "staging"
      || !job.mediaSourceId || !job.expectedSize || job.expectedSize <= 0) return null;
    let partialPath: string;
    try {
      partialPath = this.partialPath(local);
    } catch {
      return null;
    }
    const file = await stat(partialPath).catch(() => null);
    const recordedBytes = this.transferBytes.get(job.downloadId) ?? job.bytesDownloaded;
    const mediaSource = await this.persistence.getMediaSource(
      job.serverId,
      job.userId,
      job.itemId,
      job.mediaSourceId,
    ).catch(() => null);
    const bitrate = mediaSource?.diagnostics?.bitrate ?? null;
    if (!file?.isFile() || file.size !== recordedBytes || recordedBytes < this.progressiveThreshold(bundle, bitrate)) return null;
    return { partialPath, recordedBytes };
  }

  private publishLeaseBytes(downloadId: string, bytes: number): void {
    for (const lease of this.progressiveLeases.get(downloadId) ?? []) lease.publishBytes(bytes);
  }

  private async beginLeaseFinalization(downloadId: string): Promise<void> {
    await Promise.all([...this.progressiveLeases.get(downloadId) ?? []].map((lease) => lease.beginFinalization()));
  }

  private publishLeaseRenamed(downloadId: string, finalPath: string): void {
    for (const lease of this.progressiveLeases.get(downloadId) ?? []) lease.publishRenamed(finalPath);
  }

  private endLeaseFinalization(downloadId: string): void {
    for (const lease of this.progressiveLeases.get(downloadId) ?? []) lease.endFinalization();
  }

  private completeLeases(downloadId: string, finalPath: string): void {
    this.transferBytes.delete(downloadId);
    for (const lease of this.progressiveLeases.get(downloadId) ?? []) lease.publishCompleted(finalPath);
  }

  private async invalidateLeases(downloadId: string, reason: ProgressiveLeaseInvalidationReason): Promise<void> {
    this.transferBytes.delete(downloadId);
    const leases = [...this.progressiveLeases.get(downloadId) ?? []];
    for (const lease of leases) lease.publishInvalidated(reason);
    await Promise.all(leases.map((lease) => lease.drainReads()));
  }

  private async invalidateAllLeases(reason: ProgressiveLeaseInvalidationReason): Promise<void> {
    await Promise.all([...this.progressiveLeases.keys()].map((downloadId) => this.invalidateLeases(downloadId, reason)));
  }

  private async listFor(identity: AuthenticatedContext): Promise<DownloadSummary[]> {
    const bundles = await this.persistence.listDownloadBundles(identity.serverId, identity.userId);
    const reconciled = await Promise.all(bundles.map((bundle) => this.reconcileLocalFile(bundle)));
    return Promise.all(reconciled
      .filter((bundle) => bundle.job.state !== "cancelled")
      .map(async (bundle) => this.toSummary(bundle, Boolean(await this.progressiveCandidate(bundle)))));
  }

  private async reconcileLocalFile(bundle: DownloadBundleRecord): Promise<DownloadBundleRecord> {
    const local = bundle.localVersion;
    if (bundle.job.state !== "completed" || local?.fileState !== "finalized") return bundle;
    let file: Awaited<ReturnType<typeof stat>> | null = null;
    let invalidPath = false;
    try {
      file = await stat(this.authorizedPath(local.storageRoot, local.localPath));
    } catch (error) {
      invalidPath = error instanceof AppError && error.code === "INVALID_LOCAL_PATH";
    }
    const expected = local.expectedSize;
    if (file?.isFile() && (expected === null || file.size === expected)) return bundle;
    const updated = await this.persistence.updateLocalVersion({
      localVersionId: local.localVersionId,
      fileState: invalidPath || file?.isFile() ? "invalid" : "missing",
      probeState: invalidPath || file?.isFile() ? "invalid" : "pending",
      actualSize: file?.isFile() ? file.size : null,
    });
    return { ...bundle, localVersion: updated };
  }

  private async notify(): Promise<void> {
    const identity = this.identity;
    if (!identity || !this.listeners.size) return;
    const downloads = await this.listFor(identity).catch(() => null);
    if (!downloads || this.identity !== identity) return;
    for (const listener of this.listeners) listener(downloads);
  }

  private toSummary(bundle: DownloadBundleRecord, confirmedProgressiveEligibility?: boolean): DownloadSummary {
    const job = bundle.job;
    const local = bundle.localVersion;
    const state: DownloadSummary["state"] = job.state === "completed"
      ? local?.fileState === "finalized" && local.probeState === "valid" ? "downloaded" : "missing"
      : job.state === "cancelled" ? "missing" : job.state;
    const progressPercent = job.expectedSize && job.expectedSize > 0
      ? Math.max(0, Math.min(100, Math.round((job.bytesDownloaded / job.expectedSize) * 1000) / 10))
      : null;
    const item = materializeCachedMediaItem(bundle.item ?? {
      serverId: job.serverId,
      userId: job.userId,
      itemId: job.itemId,
      itemType: bundle.itemType,
      name: bundle.itemName,
      seriesId: null,
      seasonId: null,
      runTimeTicks: 0,
      metadata: null,
      nextUp: null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    }, bundle.playbackHead);
    const localPlaybackAvailable = state === "downloaded";
    const canWatchWhileDownloading = confirmedProgressiveEligibility ?? ((job.state === "downloading" || job.state === "paused")
      && job.expectedSize !== null
      && job.expectedSize > 0
      && job.bytesDownloaded >= this.progressiveThreshold(bundle));
    return {
      downloadId: job.downloadId,
      itemId: job.itemId,
      name: bundle.itemName,
      itemType: bundle.itemType,
      item,
      resumePositionTicks: item.userData.playbackPositionTicks,
      localPlaybackAvailable,
      canWatchWhileDownloading,
      state,
      bytesDownloaded: job.bytesDownloaded,
      expectedSize: job.expectedSize,
      progressPercent,
      keepDownloaded: job.keepDownloaded,
      smartManaged: job.smartManaged,
      error: job.errorCode && job.errorMessage ? { code: job.errorCode, message: job.errorMessage } : null,
      canPause: job.state === "queued" || job.state === "downloading",
      canResume: job.state === "paused",
      canRetry: job.state === "failed",
      canCancel: job.state === "queued" || job.state === "downloading" || job.state === "paused" || job.state === "failed",
      canDelete: job.state === "completed" && local?.fileState === "finalized",
    };
  }
}
