import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { JellyfinConnectionDiagnostics, MediaItem, PlaybackDiagnostics } from "../../shared/contracts";
import { AppError } from "./errors";
import { materializeCachedDiagnostics, materializeCachedMediaItem } from "./cachedMedia";
import type { AuthenticatedContext } from "./jellyfinApi";
import type { MediaProbeService } from "./mediaProbe";
import type { SqlitePersistenceService } from "./persistence";
import type { LocalVersionRecord } from "./persistenceTypes";
import { selectAuthoritativeResume, type ResolvedPlaybackSource } from "./playbackSession";

interface LocalPlaybackApi {
  getAuthenticatedContext(): AuthenticatedContext;
  getConnectionDiagnostics?(): JellyfinConnectionDiagnostics;
  getDetails(itemId: string): Promise<MediaItem>;
}

type LocalPersistence = Pick<SqlitePersistenceService,
  "getMediaItem" | "getPlaybackHead" | "listLocalVersions" | "updateLocalVersion"
> & Partial<Pick<SqlitePersistenceService, "getMediaSource" | "upsertMediaItem" | "upsertMediaSource">>;

type LocalProbe = Pick<MediaProbeService, "probe">;

function pathKey(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

export class LocalPlaybackResolver {
  private readonly authorizedRoots: Map<string, string>;

  constructor(
    private readonly api: LocalPlaybackApi,
    private readonly persistence: LocalPersistence,
    private readonly probe: LocalProbe,
    authorizedRoots: string[],
    private readonly detailsTimeoutMilliseconds = 1500,
  ) {
    this.authorizedRoots = new Map();
    for (const root of authorizedRoots) this.addAuthorizedRoot(root);
    if (!this.authorizedRoots.size) throw new AppError("INVALID_LOCAL_PLAYBACK_ROOT", "At least one local playback storage root is required.", 500);
  }

  addAuthorizedRoot(root: string): void {
    if (!isAbsolute(root)) throw new AppError("INVALID_LOCAL_PLAYBACK_ROOT", "Local playback storage must use an absolute path.", 500);
    const normalized = resolve(root);
    this.authorizedRoots.set(pathKey(normalized), normalized);
  }

  async resolve(
    itemId: string,
    resumeMode: "resume" | "start-over",
    excludedLocalVersionIds: ReadonlySet<string> = new Set(),
  ): Promise<ResolvedPlaybackSource | null> {
    const identity = this.api.getAuthenticatedContext();
    const connectionState = this.api.getConnectionDiagnostics?.().state ?? "unknown";
    const allowLiveMetadata = connectionState !== "offline" && connectionState !== "reconnecting";
    const [media, versions, head] = await Promise.all([
      this.persistence.getMediaItem(identity.serverId, identity.userId, itemId),
      this.persistence.listLocalVersions(identity.serverId, identity.userId, itemId),
      this.persistence.getPlaybackHead(identity.serverId, identity.userId, itemId),
    ]);
    if (!media) return null;
    const cachedItem = materializeCachedMediaItem(media, head);

    const candidates = versions
      .filter((version) => version.fileState === "finalized"
        && version.probeState === "valid"
        && version.mediaSourceId
        && !excludedLocalVersionIds.has(version.localVersionId))
      .sort((left, right) => Number(Boolean(left.downloadId)) - Number(Boolean(right.downloadId))
        || Number(right.keepDownloaded) - Number(left.keepDownloaded)
        || right.updatedAt - left.updatedAt);

    for (const candidate of candidates) {
      const authorized = this.authorize(candidate);
      if (!authorized) {
        await this.markUnusable(candidate, "invalid", "invalid", candidate.actualSize);
        continue;
      }
      const [realRoot, localPath] = await Promise.all([
        realpath(authorized.root).catch(() => null),
        realpath(authorized.target).catch(() => null),
      ]);
      if (!realRoot || !localPath) {
        await this.markUnusable(candidate, "missing", "pending", null);
        continue;
      }
      const realChild = relative(realRoot, localPath);
      if (!realChild || realChild.startsWith("..") || isAbsolute(realChild)) {
        await this.markUnusable(candidate, "invalid", "invalid", candidate.actualSize);
        continue;
      }
      const file = await stat(localPath).catch(() => null);
      if (!file?.isFile()) {
        await this.markUnusable(candidate, "missing", "pending", null);
        continue;
      }
      if (file.size <= 0
        || candidate.actualSize === null
        || file.size !== candidate.actualSize
        || (candidate.expectedSize !== null && file.size !== candidate.expectedSize)) {
        await this.markUnusable(candidate, "invalid", "invalid", file.size);
        continue;
      }

      const detailsPromise = allowLiveMetadata
        ? this.api.getDetails(itemId).then((details) => details).catch(() => null)
        : Promise.resolve(null);
      let probeResult: Awaited<ReturnType<LocalProbe["probe"]>>;
      try {
        probeResult = await this.probe.probe(realRoot, localPath);
      } catch (error) {
        if (error instanceof AppError && error.code === "MEDIA_PROBE_FAILED") {
          await this.markUnusable(candidate, "invalid", "invalid", file.size);
        }
        continue;
      }
      if (probeResult.actualSize !== file.size) {
        await this.markUnusable(candidate, "invalid", "invalid", probeResult.actualSize);
        continue;
      }

      const fetchedDetails = allowLiveMetadata ? await this.withinDetailsTimeout(detailsPromise) : null;
      // A live response is advisory for local playback. Never attach metadata
      // or resume state from a response for a different Jellyfin item.
      const details = fetchedDetails?.id === itemId ? fetchedDetails : null;
      if (details && this.persistence.upsertMediaItem) {
        await this.persistence.upsertMediaItem({
          serverId: identity.serverId,
          userId: identity.userId,
          itemId,
          itemType: details.type === "Episode" ? "Episode" : details.type === "Movie" ? "Movie" : "Video",
          name: details.name,
          seriesId: details.seriesId,
          seasonId: details.seasonId,
          runTimeTicks: Math.max(0, Math.floor(details.runTimeTicks)),
          metadata: details,
        }).catch(() => undefined);
      }
      const itemType = details?.type === "Episode" || details?.type === "Movie"
        ? details.type
        : media.itemType;
      const durationTicks = Math.max(0, Math.floor(details?.runTimeTicks || cachedItem.runTimeTicks || media.runTimeTicks));
      const previous = details
        ? selectAuthoritativeResume(details.userData.playbackPositionTicks, details.userData.played, head)
        : { positionTicks: cachedItem.userData.playbackPositionTicks, played: cachedItem.userData.played };
      const previousPositionTicks = Math.max(0, Math.floor(previous.positionTicks));
      const resumePositionTicks = resumeMode === "start-over"
        ? 0
        : Math.max(0, Math.min(durationTicks || Number.MAX_SAFE_INTEGER,
          previousPositionTicks));
      const previouslyWatched = previous.played;
      const playbackId = randomUUID();
      const cachedSource = this.persistence.getMediaSource
        ? await this.persistence.getMediaSource(
          identity.serverId,
          identity.userId,
          itemId,
          candidate.mediaSourceId!,
        ).catch(() => null)
        : null;
      const sourceKind = details ? (candidate.downloadId ? "downloaded" : "matched-local") : "offline-local";
      const cachedSourceDiagnostics = materializeCachedDiagnostics(cachedSource);
      const diagnostics: PlaybackDiagnostics = {
        sourceKind,
        playbackRate: 1,
        bufferAheadTicks: null,
        container: probeResult.container ?? candidate.container ?? cachedSourceDiagnostics?.container ?? null,
        videoCodec: cachedSourceDiagnostics?.videoCodec ?? null,
        audioCodec: cachedSourceDiagnostics?.audioCodec ?? null,
        audioChannels: cachedSourceDiagnostics?.audioChannels ?? null,
        resolution: cachedSourceDiagnostics?.resolution ?? null,
        bitrate: cachedSourceDiagnostics?.bitrate ?? null,
        videoRange: cachedSourceDiagnostics?.videoRange ?? null,
        transcodeReason: null,
      };
      if (this.persistence.upsertMediaSource) {
        await this.persistence.upsertMediaSource({
          serverId: identity.serverId,
          userId: identity.userId,
          itemId,
          mediaSourceId: candidate.mediaSourceId!,
          container: diagnostics.container,
          expectedSize: candidate.expectedSize,
          diagnostics,
        }).catch(() => undefined);
      }
      return {
        playbackId,
        serverPlaySessionId: playbackId,
        itemId,
        itemType,
        seriesId: details?.seriesId ?? cachedItem.seriesId ?? media.seriesId,
        mediaSourceId: candidate.mediaSourceId!,
        mediaUrl: localPath,
        resumePositionTicks,
        durationTicks,
        source: "local",
        sourceKind,
        delivery: "local",
        usesServerTimelineOffset: false,
        localVersionId: candidate.localVersionId,
        diagnostics,
        externalSubtitles: [],
        initialAction: resumeMode !== "start-over"
          ? "progress"
          : previouslyWatched ? "replay" : previousPositionTicks > 0 ? "start_over" : "progress",
      };
    }
    return null;
  }

  private authorize(candidate: LocalVersionRecord): { root: string; target: string } | null {
    if (!isAbsolute(candidate.storageRoot) || !isAbsolute(candidate.localPath)) return null;
    const storedRoot = resolve(candidate.storageRoot);
    const authorizedRoot = this.authorizedRoots.get(pathKey(storedRoot));
    if (!authorizedRoot) return null;
    const localPath = resolve(candidate.localPath);
    const child = relative(authorizedRoot, localPath);
    if (!child || child.startsWith("..") || isAbsolute(child)) return null;
    return { root: authorizedRoot, target: localPath };
  }

  private withinDetailsTimeout(details: Promise<MediaItem | null>): Promise<MediaItem | null> {
    return new Promise((resolveDetails) => {
      let settled = false;
      const finish = (value: MediaItem | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveDetails(value);
      };
      const timer = setTimeout(() => finish(null), this.detailsTimeoutMilliseconds);
      void details.then(finish, () => finish(null));
    });
  }

  private async markUnusable(
    candidate: LocalVersionRecord,
    fileState: "missing" | "invalid",
    probeState: "pending" | "invalid",
    actualSize: number | null,
  ): Promise<void> {
    await this.persistence.updateLocalVersion({
      localVersionId: candidate.localVersionId,
      fileState,
      probeState,
      actualSize,
    }).catch(() => undefined);
  }
}
