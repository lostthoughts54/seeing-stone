import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { AppError } from "./errors";
import { redactText } from "./logger";
import type {
  CatalogIdentityInput,
  CreateDownloadInput,
  DownloadBundleRecord,
  DownloadJobRecord,
  LocalVersionRecord,
  MediaItemRecord,
  MediaItemRecordInput,
  MediaSourceRecordInput,
  PersistenceHealth,
  PersistenceOperation,
  PersistenceRequest,
  PersistenceResponse,
  PlaybackHeadRecord,
  PlaybackRevisionRecord,
  RecordPlaybackRevisionInput,
  RegisterLocalVersionInput,
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

function safeIdentity(input: { serverId: string; userId: string; itemId?: string }) {
  return {
    serverId: boundedText(input.serverId, "Server identity", 256),
    userId: boundedText(input.userId, "User identity", 256),
    ...(input.itemId === undefined ? {} : { itemId: boundedText(input.itemId, "Item identity", 256) }),
  };
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

  constructor(private readonly userDataPath: string) {
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
    await this.invoke({
      kind: "upsertMediaItem",
      input: {
        ...input,
        ...identity,
        name: boundedText(input.name, "Media name", 1024),
        seriesId: optionalText(input.seriesId, "Series identity", 256),
        seasonId: optionalText(input.seasonId, "Season identity", 256),
        runTimeTicks: nonnegativeInteger(input.runTimeTicks, "Runtime"),
      },
    });
  }

  async getMediaItem(serverId: string, userId: string, itemId: string): Promise<MediaItemRecord | null> {
    const identity = safeIdentity({ serverId, userId, itemId });
    return this.invoke({
      kind: "getMediaItem",
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: identity.itemId!,
    }) as Promise<MediaItemRecord | null>;
  }

  async upsertMediaSource(input: MediaSourceRecordInput): Promise<void> {
    const identity = safeIdentity(input);
    await this.invoke({
      kind: "upsertMediaSource",
      input: {
        ...input,
        ...identity,
        mediaSourceId: boundedText(input.mediaSourceId, "Media source identity", 256),
        container: optionalText(input.container, "Container", 64),
        expectedSize: optionalNonnegativeInteger(input.expectedSize, "Expected size"),
      },
    });
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
    return this.invoke({
      kind: "createDownloadBundle",
      download: normalizedDownload,
      localVersion: {
        ...normalizedLocalVersion,
        downloadId,
      },
    }) as Promise<DownloadBundleRecord>;
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
    return this.invoke({ kind: "getDownloadBundle", downloadId: boundedText(downloadId, "Download identity", 256) }) as Promise<DownloadBundleRecord | null>;
  }

  async listDownloadBundles(serverId: string, userId: string): Promise<DownloadBundleRecord[]> {
    const identity = safeIdentity({ serverId, userId });
    return this.invoke({ kind: "listDownloadBundles", serverId: identity.serverId, userId: identity.userId }) as Promise<DownloadBundleRecord[]>;
  }

  async setDownloadKeep(downloadId: string, keepDownloaded: boolean): Promise<DownloadBundleRecord> {
    return this.invoke({
      kind: "setDownloadKeep",
      downloadId: boundedText(downloadId, "Download identity", 256),
      keepDownloaded,
    }) as Promise<DownloadBundleRecord>;
  }

  async setDownloadExpectedSize(downloadId: string, expectedSize: number): Promise<DownloadBundleRecord> {
    return this.invoke({
      kind: "setDownloadExpectedSize",
      downloadId: boundedText(downloadId, "Download identity", 256),
      expectedSize: nonnegativeInteger(expectedSize, "Expected size"),
    }) as Promise<DownloadBundleRecord>;
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

  async recordPlaybackRevision(input: RecordPlaybackRevisionInput): Promise<PlaybackRevisionRecord> {
    const identity = safeIdentity(input);
    return this.invoke({
      kind: "recordPlaybackRevision",
      input: {
        ...input,
        ...identity,
        positionTicks: nonnegativeInteger(input.positionTicks, "Playback position"),
        occurredAt: nonnegativeInteger(input.occurredAt, "Playback timestamp"),
      },
    }) as Promise<PlaybackRevisionRecord>;
  }

  async getPlaybackHead(serverId: string, userId: string, itemId: string): Promise<PlaybackHeadRecord | null> {
    const identity = safeIdentity({ serverId, userId, itemId });
    return this.invoke({ kind: "getPlaybackHead", serverId: identity.serverId, userId: identity.userId, itemId: identity.itemId! }) as Promise<PlaybackHeadRecord | null>;
  }

  async listPendingProgress(limit = 100): Promise<PlaybackRevisionRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new AppError("INVALID_PERSISTENCE_INPUT", "Pending progress limit is invalid.", 400);
    return this.invoke({ kind: "listPendingProgress", limit }) as Promise<PlaybackRevisionRecord[]>;
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
    const worker = new Worker(join(__dirname, "persistenceWorker.js"), { workerData: { databasePath: this.databasePath } });
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
