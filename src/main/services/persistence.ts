import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { AppError } from "./errors";
import { redactText } from "./logger";
import { cachedMediaItemSchema, cachedPlaybackDiagnosticsSchema } from "../../shared/schemas";
import type { MediaItem, PlaybackDiagnostics } from "../../shared/contracts";
import type {
  ApplicationPreferenceKey,
  ApplicationPreferenceRecord,
  CatalogIdentityInput,
  CreateDownloadInput,
  DownloadBundleRecord,
  DownloadJobRecord,
  LocalVersionRecord,
  MediaItemRecord,
  MediaItemRecordInput,
  MediaSourceRecord,
  MediaSourceRecordInput,
  OfflinePlayableRecord,
  PersistenceHealth,
  PersistenceOperation,
  PersistenceRequest,
  PersistenceResponse,
  PlaybackHeadRecord,
  PlaybackRevisionRecord,
  RecordPlaybackRevisionInput,
  RegisterLocalVersionInput,
  SmartSeriesCheckResult,
  SmartSeriesRecord,
  SmartSeriesRecordInput,
  TransitionDownloadInput,
  UpdateLocalVersionInput,
} from "./persistenceTypes";

function boundedText(value: string, name: string, maximum = 1024): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || normalized.includes("\0")) {
    throw new AppError("INVALID_PERSISTENCE_INPUT", `${name} is invalid.`, 400);
  }
  return normalized;
}

function optionalText(value: string | null, name: string, maximum = 1024): string | null {
  return value === null ? null : boundedText(value, name, maximum);
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new AppError("INVALID_PERSISTENCE_INPUT", `${name} is invalid.`, 400);
  return value;
}

function optionalNonnegativeInteger(value: number | null, name: string): number | null {
  return value === null ? null : nonnegativeInteger(value, name);
}

function sanitizedSmartErrorMessage(value: string): string {
  return redactText(value).replace(/https?:\/\/[^\s"'<>]+/giu, "[REDACTED_URL]");
}

function safeIdentity(input: { serverId: string; userId: string; itemId?: string }) {
  return {
    serverId: boundedText(input.serverId, "Server identity", 256),
    userId: boundedText(input.userId, "User identity", 256),
    ...(input.itemId === undefined ? {} : { itemId: boundedText(input.itemId, "Item identity", 256) }),
  };
}

function cacheValue<T>(
  value: unknown,
  parser: { safeParse(input: unknown): { success: true; data: T } | { success: false } },
  name: string,
  maximum: number,
): T {
  const parsed = parser.safeParse(value);
  if (!parsed.success) throw new AppError("INVALID_PERSISTENCE_INPUT", `${name} is invalid.`, 400);
  const valueJson = JSON.stringify(parsed.data);
  if (!valueJson || valueJson.length > maximum || Buffer.byteLength(valueJson, "utf8") > maximum || valueJson.includes("\0")) {
    throw new AppError("INVALID_PERSISTENCE_INPUT", `${name} is invalid.`, 400);
  }
  return parsed.data;
}

function cachedMediaItem(value: unknown, expectedItemId: string, name = "Cached media metadata"): MediaItem {
  const item = cacheValue(value, cachedMediaItemSchema, name, 65_536);
  if (item.id !== expectedItemId) {
    throw new AppError("INVALID_PERSISTENCE_INPUT", `${name} has the wrong item identity.`, 400);
  }
  return item;
}

function cachedDiagnostics(value: unknown): PlaybackDiagnostics {
  return cacheValue(value, cachedPlaybackDiagnosticsSchema, "Cached playback diagnostics", 16_384);
}

function normalizeMediaRecord(record: MediaItemRecord): MediaItemRecord {
  const metadataResult = cachedMediaItemSchema.safeParse(record.metadata);
  const metadata = metadataResult.success
    && metadataResult.data.id === record.itemId
    && metadataResult.data.playable
    && (metadataResult.data.type === "Episode" ? "Episode" : metadataResult.data.type === "Movie" ? "Movie" : "Video") === record.itemType
    && metadataResult.data.name === record.name
    && metadataResult.data.seriesId === record.seriesId
    && metadataResult.data.seasonId === record.seasonId
    && metadataResult.data.runTimeTicks === record.runTimeTicks
    ? metadataResult.data
    : null;
  const nextUpResult = cachedMediaItemSchema.safeParse(record.nextUp);
  const nextUp = nextUpResult.success && nextUpResult.data.playable && nextUpResult.data.id !== record.itemId
    ? nextUpResult.data
    : null;
  return { ...record, metadata, nextUp };
}

function normalizeMediaSourceRecord(record: MediaSourceRecord): MediaSourceRecord {
  const diagnostics = cachedPlaybackDiagnosticsSchema.safeParse(record.diagnostics);
  return { ...record, diagnostics: diagnostics.success ? diagnostics.data : null };
}

function normalizeDownloadBundle(bundle: DownloadBundleRecord): DownloadBundleRecord {
  return { ...bundle, item: normalizeMediaRecord(bundle.item) };
}

function normalizeLocalVersion(
  input: RegisterLocalVersionInput,
  overrides: { localVersionId?: string; downloadId?: string | null } = {},
): RegisterLocalVersionInput & { localVersionId: string; pathKey: string } {
  const identity = safeIdentity(input);
  const storageRoot = resolve(boundedText(input.storageRoot, "Storage root", 32767));
  const localPath = resolve(boundedText(input.localPath, "Local path", 32767));
  if (!isAbsolute(input.storageRoot) || !isAbsolute(input.localPath)) {
    throw new AppError("INVALID_LOCAL_PATH", "The local media path must be absolute.", 400);
  }
  const child = relative(storageRoot, localPath);
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    throw new AppError("INVALID_LOCAL_PATH", "The local media path is outside the authorized storage root.", 400);
  }
  const expectedSize = optionalNonnegativeInteger(input.expectedSize, "Expected size");
  const actualSize = optionalNonnegativeInteger(input.actualSize, "Actual size");
  if (input.fileState === "finalized" && (input.probeState !== "valid" || actualSize === null || (expectedSize !== null && actualSize !== expectedSize))) {
    throw new AppError("LOCAL_VERSION_NOT_VERIFIED", "A local version cannot be finalized until size and media probing succeed.", 422);
  }
  return {
    ...input,
    ...identity,
    localVersionId: boundedText(overrides.localVersionId ?? input.localVersionId ?? randomUUID(), "Local version identity", 256),
    mediaSourceId: optionalText(input.mediaSourceId, "Media source identity", 256),
    downloadId: optionalText(overrides.downloadId === undefined ? input.downloadId : overrides.downloadId, "Download identity", 256),
    storageRoot,
    localPath,
    pathKey: localPath.toLocaleLowerCase("en-US"),
    expectedSize,
    actualSize,
    container: optionalText(input.container, "Container", 64),
  };
}

export class SqlitePersistenceService {
  private readonly databasePath: string;
  private worker: Worker | null = null;
  private opening: Promise<PersistenceHealth> | null = null;
  private requestId = 0;
  private pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private closed = false;

  constructor(
    private readonly userDataPath: string,
    private readonly workerPath = join(__dirname, "persistenceWorker.js"),
  ) {
    this.databasePath = join(userDataPath, "localfirst.sqlite3");
  }

  async open(): Promise<PersistenceHealth> {
    if (this.closed) throw new AppError("PERSISTENCE_CLOSED", "Local data storage is closed.", 409);
    if (this.opening) return this.opening;
    this.opening = this.startWorker();
    try {
      return await this.opening;
    } catch (error) {
      const worker = this.worker;
      this.worker = null;
      await worker?.terminate().catch(() => undefined);
      this.opening = null;
      throw error;
    }
  }

  async health(): Promise<PersistenceHealth> {
    return this.invoke({ kind: "health" }) as Promise<PersistenceHealth>;
  }

  async getApplicationPreference(key: ApplicationPreferenceKey): Promise<ApplicationPreferenceRecord | null> {
    return this.invoke({ kind: "getApplicationPreference", key }) as Promise<ApplicationPreferenceRecord | null>;
  }

  async setApplicationPreference(key: ApplicationPreferenceKey, value: unknown): Promise<ApplicationPreferenceRecord> {
    const valueJson = JSON.stringify(value);
    if (!valueJson || valueJson.length > 16_384 || valueJson.includes("\0")) {
      throw new AppError("INVALID_PERSISTENCE_INPUT", "Application preference data is invalid.", 400);
    }
    return this.invoke({
      kind: "setApplicationPreference",
      key,
      valueJson,
      updatedAt: Date.now(),
    }) as Promise<ApplicationPreferenceRecord>;
  }

  async upsertCatalogIdentity(input: CatalogIdentityInput): Promise<void> {
    const identity = safeIdentity(input);
    await this.invoke({
      kind: "upsertCatalogIdentity",
      input: {
        ...identity,
        serverAddress: boundedText(input.serverAddress, "Server address", 2048),
        serverName: optionalText(input.serverName, "Server name", 256),
        userName: optionalText(input.userName, "User name", 256),
      },
    });
  }

  async upsertMediaItem(input: MediaItemRecordInput): Promise<void> {
    const identity = safeIdentity(input);
    const name = boundedText(input.name, "Media name", 1024);
    const seriesId = optionalText(input.seriesId, "Series identity", 256);
    const seasonId = optionalText(input.seasonId, "Season identity", 256);
    const runTimeTicks = nonnegativeInteger(input.runTimeTicks, "Runtime");
    const metadata = input.metadata === undefined
      ? undefined
      : input.metadata === null ? null : cachedMediaItem(input.metadata, identity.itemId!);
    if (metadata) {
      const itemType = metadata.type === "Episode" ? "Episode" : metadata.type === "Movie" ? "Movie" : "Video";
      if (!metadata.playable || itemType !== input.itemType || metadata.name !== name
        || metadata.seriesId !== seriesId || metadata.seasonId !== seasonId || metadata.runTimeTicks !== runTimeTicks) {
        throw new AppError("INVALID_PERSISTENCE_INPUT", "Cached media metadata does not match its catalog record.", 400);
      }
    }
    await this.invoke({
      kind: "upsertMediaItem",
      input: {
        ...input,
        ...identity,
        name,
        seriesId,
        seasonId,
        runTimeTicks,
        metadata,
      },
    });
  }

  async getMediaItem(serverId: string, userId: string, itemId: string): Promise<MediaItemRecord | null> {
    const identity = safeIdentity({ serverId, userId, itemId });
    const record = await this.invoke({
      kind: "getMediaItem",
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: identity.itemId!,
    }) as MediaItemRecord | null;
    return record ? normalizeMediaRecord(record) : null;
  }

  async setMediaItemNextUp(serverId: string, userId: string, itemId: string, nextUp: MediaItem | null): Promise<void> {
    const identity = safeIdentity({ serverId, userId, itemId });
    const normalizedNextUp = nextUp === null ? null : cachedMediaItem(nextUp, nextUp.id, "Cached Next Up metadata");
    if (normalizedNextUp && (!normalizedNextUp.playable || normalizedNextUp.id === identity.itemId)) {
      throw new AppError("INVALID_PERSISTENCE_INPUT", "Cached Next Up metadata is invalid.", 400);
    }
    await this.invoke({
      kind: "setMediaItemNextUp",
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: identity.itemId!,
      nextUp: normalizedNextUp,
    });
  }

  async upsertMediaSource(input: MediaSourceRecordInput): Promise<void> {
    const identity = safeIdentity(input);
    const diagnostics = input.diagnostics === undefined
      ? undefined
      : input.diagnostics === null ? null : cachedDiagnostics(input.diagnostics);
    await this.invoke({
      kind: "upsertMediaSource",
      input: {
        ...input,
        ...identity,
        mediaSourceId: boundedText(input.mediaSourceId, "Media source identity", 256),
        container: optionalText(input.container, "Container", 64),
        expectedSize: optionalNonnegativeInteger(input.expectedSize, "Expected size"),
        diagnostics,
      },
    });
  }

  async getMediaSource(serverId: string, userId: string, itemId: string, mediaSourceId: string): Promise<MediaSourceRecord | null> {
    const identity = safeIdentity({ serverId, userId, itemId });
    const record = await this.invoke({
      kind: "getMediaSource",
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: identity.itemId!,
      mediaSourceId: boundedText(mediaSourceId, "Media source identity", 256),
    }) as MediaSourceRecord | null;
    return record ? normalizeMediaSourceRecord(record) : null;
  }

  async createDownload(input: CreateDownloadInput): Promise<DownloadJobRecord> {
    const identity = safeIdentity(input);
    return this.invoke({
      kind: "createDownload",
      input: {
        ...input,
        ...identity,
        downloadId: input.downloadId ? boundedText(input.downloadId, "Download identity", 256) : randomUUID(),
        mediaSourceId: optionalText(input.mediaSourceId, "Media source identity", 256),
        qualityProfile: optionalText(input.qualityProfile, "Quality profile", 128),
        expectedSize: optionalNonnegativeInteger(input.expectedSize, "Expected size"),
      },
    }) as Promise<DownloadJobRecord>;
  }

  async createDownloadBundle(
    download: CreateDownloadInput,
    localVersion: RegisterLocalVersionInput,
  ): Promise<DownloadBundleRecord> {
    const identity = safeIdentity(download);
    const downloadId = download.downloadId
      ? boundedText(download.downloadId, "Download identity", 256)
      : randomUUID();
    const normalizedDownload: CreateDownloadInput & { downloadId: string } = {
      ...download,
      ...identity,
      downloadId,
      mediaSourceId: optionalText(download.mediaSourceId, "Media source identity", 256),
      qualityProfile: optionalText(download.qualityProfile, "Quality profile", 128),
      expectedSize: optionalNonnegativeInteger(download.expectedSize, "Expected size"),
    };
    const normalizedLocalVersion = normalizeLocalVersion(localVersion, { downloadId });
    if (normalizedLocalVersion.serverId !== normalizedDownload.serverId
      || normalizedLocalVersion.userId !== normalizedDownload.userId
      || normalizedLocalVersion.itemId !== normalizedDownload.itemId
      || normalizedLocalVersion.mediaSourceId !== normalizedDownload.mediaSourceId) {
      throw new AppError("INVALID_PERSISTENCE_INPUT", "Download and local-version identities do not match.", 400);
    }
    const bundle = await this.invoke({
      kind: "createDownloadBundle",
      download: normalizedDownload,
      localVersion: {
        ...normalizedLocalVersion,
        downloadId,
      },
    }) as DownloadBundleRecord;
    return normalizeDownloadBundle(bundle);
  }

  async transitionDownload(input: TransitionDownloadInput): Promise<DownloadJobRecord> {
    return this.invoke({
      kind: "transitionDownload",
      input: {
        ...input,
        downloadId: boundedText(input.downloadId, "Download identity", 256),
        bytesDownloaded: input.bytesDownloaded === undefined ? undefined : nonnegativeInteger(input.bytesDownloaded, "Downloaded bytes"),
        errorCode: input.errorCode === undefined ? undefined : optionalText(input.errorCode, "Error code", 128),
        errorMessage: input.errorMessage === undefined || input.errorMessage === null
          ? input.errorMessage
          : redactText(input.errorMessage).slice(0, 2048),
      },
    }) as Promise<DownloadJobRecord>;
  }

  async getDownload(downloadId: string): Promise<DownloadJobRecord | null> {
    return this.invoke({ kind: "getDownload", downloadId: boundedText(downloadId, "Download identity", 256) }) as Promise<DownloadJobRecord | null>;
  }

  async getDownloadBundle(downloadId: string): Promise<DownloadBundleRecord | null> {
    const bundle = await this.invoke({ kind: "getDownloadBundle", downloadId: boundedText(downloadId, "Download identity", 256) }) as DownloadBundleRecord | null;
    return bundle ? normalizeDownloadBundle(bundle) : null;
  }

  async listDownloadBundles(serverId: string, userId: string): Promise<DownloadBundleRecord[]> {
    const identity = safeIdentity({ serverId, userId });
    const bundles = await this.invoke({ kind: "listDownloadBundles", serverId: identity.serverId, userId: identity.userId }) as DownloadBundleRecord[];
    return bundles.map(normalizeDownloadBundle);
  }

  async setDownloadKeep(downloadId: string, keepDownloaded: boolean): Promise<DownloadBundleRecord> {
    const bundle = await this.invoke({
      kind: "setDownloadKeep",
      downloadId: boundedText(downloadId, "Download identity", 256),
      keepDownloaded,
    }) as DownloadBundleRecord;
    return normalizeDownloadBundle(bundle);
  }

  async setDownloadSmartManaged(downloadId: string, smartManaged: boolean): Promise<DownloadBundleRecord> {
    const bundle = await this.invoke({
      kind: "setDownloadSmartManaged",
      downloadId: boundedText(downloadId, "Download identity", 256),
      smartManaged,
    }) as DownloadBundleRecord;
    return normalizeDownloadBundle(bundle);
  }

  async setDownloadExpectedSize(downloadId: string, expectedSize: number): Promise<DownloadBundleRecord> {
    const bundle = await this.invoke({
      kind: "setDownloadExpectedSize",
      downloadId: boundedText(downloadId, "Download identity", 256),
      expectedSize: nonnegativeInteger(expectedSize, "Expected size"),
    }) as DownloadBundleRecord;
    return normalizeDownloadBundle(bundle);
  }

  async registerLocalVersion(input: RegisterLocalVersionInput): Promise<LocalVersionRecord> {
    return this.invoke({
      kind: "registerLocalVersion",
      input: normalizeLocalVersion(input),
    }) as Promise<LocalVersionRecord>;
  }

  async updateLocalVersion(input: UpdateLocalVersionInput): Promise<LocalVersionRecord> {
    const actualSize = optionalNonnegativeInteger(input.actualSize, "Actual size");
    return this.invoke({
      kind: "updateLocalVersion",
      input: {
        ...input,
        localVersionId: boundedText(input.localVersionId, "Local version identity", 256),
        actualSize,
      },
    }) as Promise<LocalVersionRecord>;
  }

  async listLocalVersions(serverId: string, userId: string, itemId: string): Promise<LocalVersionRecord[]> {
    const identity = safeIdentity({ serverId, userId, itemId });
    return this.invoke({ kind: "listLocalVersions", serverId: identity.serverId, userId: identity.userId, itemId: identity.itemId! }) as Promise<LocalVersionRecord[]>;
  }

  async listOfflinePlayableItems(serverId: string, userId: string): Promise<OfflinePlayableRecord[]> {
    const identity = safeIdentity({ serverId, userId });
    const records = await this.invoke({
      kind: "listOfflinePlayableItems",
      serverId: identity.serverId,
      userId: identity.userId,
    }) as OfflinePlayableRecord[];
    return records.map((record) => ({
      ...record,
      item: normalizeMediaRecord(record.item),
      mediaSource: record.mediaSource ? normalizeMediaSourceRecord(record.mediaSource) : null,
    }));
  }

  async upsertSmartSeries(input: SmartSeriesRecordInput): Promise<SmartSeriesRecord> {
    const identity = safeIdentity({ serverId: input.serverId, userId: input.userId, itemId: input.seriesId });
    if (!Number.isSafeInteger(input.episodeLimit) || input.episodeLimit < 1 || input.episodeLimit > 5) {
      throw new AppError("INVALID_PERSISTENCE_INPUT", "Smart Download episode limit is invalid.", 400);
    }
    return this.invoke({
      kind: "upsertSmartSeries",
      input: {
        serverId: identity.serverId,
        userId: identity.userId,
        seriesId: identity.itemId!,
        seriesName: boundedText(input.seriesName, "Series name", 1024),
        episodeLimit: input.episodeLimit,
      },
    }) as Promise<SmartSeriesRecord>;
  }

  async listSmartSeries(serverId: string, userId: string): Promise<SmartSeriesRecord[]> {
    const identity = safeIdentity({ serverId, userId });
    return this.invoke({ kind: "listSmartSeries", serverId: identity.serverId, userId: identity.userId }) as Promise<SmartSeriesRecord[]>;
  }

  async recordSmartSeriesCheck(
    serverId: string,
    userId: string,
    seriesId: string,
    result: SmartSeriesCheckResult,
  ): Promise<SmartSeriesRecord> {
    const identity = safeIdentity({ serverId, userId, itemId: seriesId });
    const normalized: SmartSeriesCheckResult = result.success
      ? { success: true, checkedAt: nonnegativeInteger(result.checkedAt, "Smart Download check timestamp") }
      : {
          success: false,
          errorCode: boundedText(result.errorCode, "Smart Download error code", 128),
          errorMessage: boundedText(sanitizedSmartErrorMessage(result.errorMessage), "Smart Download error message", 2048),
          errorAt: nonnegativeInteger(result.errorAt, "Smart Download error timestamp"),
        };
    return this.invoke({
      kind: "recordSmartSeriesCheck",
      serverId: identity.serverId,
      userId: identity.userId,
      seriesId: identity.itemId!,
      result: normalized,
    }) as Promise<SmartSeriesRecord>;
  }

  async addSmartEpisodeSkip(serverId: string, userId: string, seriesId: string, itemId: string): Promise<void> {
    const identity = safeIdentity({ serverId, userId, itemId: seriesId });
    await this.invoke({
      kind: "addSmartEpisodeSkip",
      serverId: identity.serverId,
      userId: identity.userId,
      seriesId: identity.itemId!,
      itemId: boundedText(itemId, "Episode identity", 256),
    });
  }

  async listSmartEpisodeSkips(serverId: string, userId: string, seriesId: string): Promise<string[]> {
    const identity = safeIdentity({ serverId, userId, itemId: seriesId });
    return this.invoke({
      kind: "listSmartEpisodeSkips",
      serverId: identity.serverId,
      userId: identity.userId,
      seriesId: identity.itemId!,
    }) as Promise<string[]>;
  }

  async deleteSmartSeries(serverId: string, userId: string, seriesId: string): Promise<void> {
    const identity = safeIdentity({ serverId, userId, itemId: seriesId });
    await this.invoke({
      kind: "deleteSmartSeries",
      serverId: identity.serverId,
      userId: identity.userId,
      seriesId: identity.itemId!,
    });
  }

  async unfollowSmartSeriesKeep(serverId: string, userId: string, seriesId: string): Promise<void> {
    const identity = safeIdentity({ serverId, userId, itemId: seriesId });
    await this.invoke({
      kind: "unfollowSmartSeriesKeep",
      serverId: identity.serverId,
      userId: identity.userId,
      seriesId: identity.itemId!,
    });
  }

  async recordPlaybackRevision(input: RecordPlaybackRevisionInput): Promise<PlaybackRevisionRecord> {
    const identity = safeIdentity(input);
    const report = input.report ? {
      kind: input.report.kind,
      mediaSourceId: boundedText(input.report.mediaSourceId, "Playback media source identity", 256),
      playMethod: input.report.playMethod,
      playSessionId: boundedText(input.report.playSessionId, "Playback session identity", 256),
      paused: input.report.paused === true,
      canSeek: input.report.canSeek === true,
      audioStreamIndex: optionalNonnegativeInteger(input.report.audioStreamIndex, "Audio stream index"),
      subtitleStreamIndex: optionalNonnegativeInteger(input.report.subtitleStreamIndex, "Subtitle stream index"),
      conflictPolicy: input.report.conflictPolicy,
    } : null;
    if (report && !["start", "progress", "stop"].includes(report.kind)) {
      throw new AppError("INVALID_PERSISTENCE_INPUT", "Playback report kind is invalid.", 400);
    }
    if (report && !["DirectPlay", "DirectStream", "Transcode"].includes(report.playMethod)) {
      throw new AppError("INVALID_PERSISTENCE_INPUT", "Playback report method is invalid.", 400);
    }
    if (report && !["automatic", "explicit"].includes(report.conflictPolicy)) {
      throw new AppError("INVALID_PERSISTENCE_INPUT", "Playback report conflict policy is invalid.", 400);
    }
    return this.invoke({
      kind: "recordPlaybackRevision",
      input: {
        ...input,
        ...identity,
        report,
        positionTicks: nonnegativeInteger(input.positionTicks, "Playback position"),
        occurredAt: nonnegativeInteger(input.occurredAt, "Playback timestamp"),
      },
    }) as Promise<PlaybackRevisionRecord>;
  }

  async getPlaybackHead(serverId: string, userId: string, itemId: string): Promise<PlaybackHeadRecord | null> {
    const identity = safeIdentity({ serverId, userId, itemId });
    return this.invoke({ kind: "getPlaybackHead", serverId: identity.serverId, userId: identity.userId, itemId: identity.itemId! }) as Promise<PlaybackHeadRecord | null>;
  }

  async listPlaybackHeadsForSeries(serverId: string, userId: string, seriesId: string): Promise<PlaybackHeadRecord[]> {
    const identity = safeIdentity({ serverId, userId, itemId: seriesId });
    return this.invoke({
      kind: "listPlaybackHeadsForSeries",
      serverId: identity.serverId,
      userId: identity.userId,
      seriesId: identity.itemId!,
    }) as Promise<PlaybackHeadRecord[]>;
  }

  async listPendingProgress(limit = 100): Promise<PlaybackRevisionRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new AppError("INVALID_PERSISTENCE_INPUT", "Pending progress limit is invalid.", 400);
    return this.invoke({ kind: "listPendingProgress", limit }) as Promise<PlaybackRevisionRecord[]>;
  }

  async listPendingProgressForIdentity(
    serverId: string,
    userId: string,
    limit = 100,
  ): Promise<PlaybackRevisionRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new AppError("INVALID_PERSISTENCE_INPUT", "Pending progress limit is invalid.", 400);
    const identity = safeIdentity({ serverId, userId });
    return this.invoke({
      kind: "listPendingProgressForIdentity",
      serverId: identity.serverId,
      userId: identity.userId,
      limit,
    }) as Promise<PlaybackRevisionRecord[]>;
  }

  async markProgressSucceeded(serverId: string, userId: string, itemId: string, localRevision: number, syncedAt = Date.now()): Promise<void> {
    const identity = safeIdentity({ serverId, userId, itemId });
    await this.invoke({
      kind: "markProgressSucceeded",
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: identity.itemId!,
      localRevision: nonnegativeInteger(localRevision, "Local revision"),
      syncedAt: nonnegativeInteger(syncedAt, "Synchronization timestamp"),
    });
  }

  async markProgressFailed(serverId: string, userId: string, itemId: string, localRevision: number, error: string): Promise<PlaybackRevisionRecord> {
    const identity = safeIdentity({ serverId, userId, itemId });
    return this.invoke({
      kind: "markProgressFailed",
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: identity.itemId!,
      localRevision: nonnegativeInteger(localRevision, "Local revision"),
      error: boundedText(error, "Progress synchronization error", 512),
    }) as Promise<PlaybackRevisionRecord>;
  }

  async markPlaybackSuperseded(serverId: string, userId: string, itemId: string, localRevision: number): Promise<PlaybackRevisionRecord> {
    const identity = safeIdentity({ serverId, userId, itemId });
    return this.invoke({
      kind: "markPlaybackSuperseded",
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: identity.itemId!,
      localRevision: nonnegativeInteger(localRevision, "Local revision"),
    }) as Promise<PlaybackRevisionRecord>;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const worker = this.worker;
    if (!worker) return;
    try { await this.send({ kind: "close" }); } catch { /* Worker may already be gone. */ }
    await worker.terminate().catch(() => undefined);
    this.worker = null;
    this.rejectPending(new AppError("PERSISTENCE_CLOSED", "Local data storage is closed.", 409));
  }

  private async startWorker(): Promise<PersistenceHealth> {
    await mkdir(this.userDataPath, { recursive: true });
    const worker = new Worker(this.workerPath, { workerData: { databasePath: this.databasePath } });
    this.worker = worker;
    worker.on("message", (message: PersistenceResponse) => this.receive(message));
    worker.on("error", () => this.failWorker());
    worker.on("exit", (code) => { if (!this.closed && code !== 0) this.failWorker(); });
    return this.send({ kind: "initialize" }) as Promise<PersistenceHealth>;
  }

  private async invoke(operation: PersistenceOperation): Promise<unknown> {
    await this.open();
    return this.send(operation);
  }

  private send(operation: PersistenceOperation): Promise<unknown> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new AppError("PERSISTENCE_UNAVAILABLE", "Local data storage is unavailable.", 503));
    const id = ++this.requestId;
    const request: PersistenceRequest = { id, operation };
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => this.timeoutWorker(id), 15000);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      worker.postMessage(request);
    } catch {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new AppError("PERSISTENCE_UNAVAILABLE", "Local data storage is unavailable.", 503));
      }
      this.pending.delete(id);
    }
    return result;
  }

  private receive(response: PersistenceResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new AppError(response.error.code, response.error.message, 503));
  }

  private failWorker(): void {
    this.worker = null;
    this.opening = null;
    this.rejectPending(new AppError("PERSISTENCE_UNAVAILABLE", "Local data storage is unavailable.", 503));
  }

  private timeoutWorker(id: number): void {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    clearTimeout(request.timer);
    request.reject(new AppError("PERSISTENCE_TIMEOUT", "Local data storage did not respond.", 503));
    const worker = this.worker;
    this.worker = null;
    this.opening = null;
    void worker?.terminate();
    this.rejectPending(new AppError("PERSISTENCE_UNAVAILABLE", "Local data storage is unavailable.", 503));
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
