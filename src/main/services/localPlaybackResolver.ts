import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { MediaItem } from "../../shared/contracts";
import { AppError } from "./errors";
import type { AuthenticatedContext } from "./jellyfinApi";
import type { MediaProbeService } from "./mediaProbe";
import type { SqlitePersistenceService } from "./persistence";
import type { LocalVersionRecord } from "./persistenceTypes";
import type { ResolvedPlaybackSource } from "./playbackSession";

interface LocalPlaybackApi {
  getAuthenticatedContext(): AuthenticatedContext;
  getDetails(itemId: string): Promise<MediaItem>;
}

type LocalPersistence = Pick<SqlitePersistenceService,
  "getMediaItem" | "getPlaybackHead" | "listLocalVersions" | "updateLocalVersion"
>;

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

  async resolve(itemId: string, resumeMode: "resume" | "start-over"): Promise<ResolvedPlaybackSource | null> {
    const identity = this.api.getAuthenticatedContext();
    const [media, versions, head] = await Promise.all([
      this.persistence.getMediaItem(identity.serverId, identity.userId, itemId),
      this.persistence.listLocalVersions(identity.serverId, identity.userId, itemId),
      this.persistence.getPlaybackHead(identity.serverId, identity.userId, itemId),
    ]);
    if (!media) return null;

    const candidates = versions
      .filter((version) => version.fileState === "finalized" && version.probeState === "valid" && version.mediaSourceId)
      .sort((left, right) => Number(right.keepDownloaded) - Number(left.keepDownloaded) || right.updatedAt - left.updatedAt);

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

      const detailsPromise = this.api.getDetails(itemId).then((details) => details).catch(() => null);
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

      const details = await this.withinDetailsTimeout(detailsPromise);
      const itemType = details?.type === "Episode" || details?.type === "Movie"
        ? details.type
        : media.itemType;
      const durationTicks = Math.max(0, Math.floor(details?.runTimeTicks || media.runTimeTicks));
      const previousPositionTicks = Math.max(0, Math.floor(details?.userData.playbackPositionTicks ?? head?.positionTicks ?? 0));
      const resumePositionTicks = resumeMode === "start-over"
        ? 0
        : Math.max(0, Math.min(durationTicks || Number.MAX_SAFE_INTEGER,
          previousPositionTicks));
      const previouslyWatched = details?.userData.played ?? head?.watched ?? false;
      return {
        playbackId: randomUUID(),
        itemId,
        itemType,
        seriesId: details?.seriesId ?? media.seriesId,
        mediaSourceId: candidate.mediaSourceId!,
        mediaUrl: localPath,
        resumePositionTicks,
        durationTicks,
        source: "local",
        sourceKind: details ? (candidate.downloadId ? "downloaded" : "matched-local") : "offline-local",
        delivery: "local",
        diagnostics: {
          sourceKind: details ? (candidate.downloadId ? "downloaded" : "matched-local") : "offline-local",
          playbackRate: 1,
          bufferAheadTicks: null,
          container: probeResult.container ?? candidate.container,
          videoCodec: null,
          audioCodec: null,
          audioChannels: null,
          resolution: null,
          bitrate: null,
          videoRange: null,
          transcodeReason: null,
        },
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
