import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../src/shared/contracts";
import { AppError } from "../src/main/services/errors";
import { LocalPlaybackResolver } from "../src/main/services/localPlaybackResolver";
import type { LocalVersionRecord, MediaItemRecord, PlaybackHeadRecord } from "../src/main/services/persistenceTypes";

const identity = {
  serverId: "server-1",
  serverAddress: "http://127.0.0.1:8096",
  serverName: "Server",
  userId: "user-1",
  userName: "Viewer",
};

function mediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "episode-1",
    name: "Episode 1",
    type: "Episode",
    overview: "",
    productionYear: null,
    premiereYear: null,
    officialRating: null,
    communityRating: null,
    runTimeTicks: 1_000,
    genres: [],
    primaryImageAspectRatio: null,
    imageTags: {},
    backdropImageTag: null,
    parentThumbItemId: null,
    parentThumbImageTag: null,
    seriesId: "series-1",
    seriesName: "Series",
    seasonId: "season-1",
    indexNumber: 1,
    parentIndexNumber: 1,
    userData: { played: false, playbackPositionTicks: 300, playedPercentage: 30 },
    hasTrailer: false,
    playable: true,
    ...overrides,
  };
}

function mediaRecord(): MediaItemRecord {
  return {
    serverId: identity.serverId,
    userId: identity.userId,
    itemId: "episode-1",
    itemType: "Episode",
    name: "Episode 1",
    seriesId: "series-1",
    seasonId: "season-1",
    runTimeTicks: 1_000,
    createdAt: 1,
    updatedAt: 1,
  };
}

function localVersion(storageRoot: string, localPath: string, overrides: Partial<LocalVersionRecord> = {}): LocalVersionRecord {
  return {
    localVersionId: "local-1",
    serverId: identity.serverId,
    userId: identity.userId,
    itemId: "episode-1",
    mediaSourceId: "source-1",
    downloadId: "download-1",
    storageRoot,
    localPath,
    pathKey: localPath.toLocaleLowerCase("en-US"),
    origin: "manual",
    smartManaged: false,
    keepDownloaded: false,
    fileState: "finalized",
    probeState: "valid",
    expectedSize: 100,
    actualSize: 100,
    container: "mkv",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function harness(options: {
  root: string;
  versions: LocalVersionRecord[];
  details?: () => Promise<MediaItem>;
  head?: PlaybackHeadRecord | null;
  probe?: (root: string, target: string) => Promise<{ actualSize: number; container: string | null }>;
  detailsTimeout?: number;
}) {
  const updates: unknown[] = [];
  const api = {
    getAuthenticatedContext: () => identity,
    getDetails: options.details ?? (async () => mediaItem()),
  };
  const persistence = {
    getMediaItem: vi.fn(async () => mediaRecord()),
    listLocalVersions: vi.fn(async () => options.versions),
    getPlaybackHead: vi.fn(async () => options.head ?? null),
    updateLocalVersion: vi.fn(async (input: unknown) => {
      updates.push(input);
      return options.versions[0];
    }),
  };
  const probe = {
    probe: vi.fn(options.probe ?? (async (_root: string, target: string) => ({ actualSize: options.versions.find((entry) => entry.localPath === target)?.actualSize ?? 100, container: "mkv" }))),
  };
  const resolver = new LocalPlaybackResolver(api, persistence as never, probe as never, [options.root], options.detailsTimeout ?? 20);
  return { resolver, persistence, probe, updates };
}

describe("LocalPlaybackResolver", () => {
  it("selects an exact finalized local version and preserves authoritative server resume metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "lf-local-resolver-"));
    const target = join(root, "download-1", "media.mkv");
    await mkdir(join(root, "download-1"));
    await writeFile(target, Buffer.alloc(100, 1));
    const value = harness({ root, versions: [localVersion(root, target)] });
    const resolved = await value.resolver.resolve("episode-1", "resume");
    expect(resolved).toMatchObject({
      itemId: "episode-1",
      itemType: "Episode",
      seriesId: "series-1",
      mediaSourceId: "source-1",
      mediaUrl: target,
      source: "local",
      sourceKind: "downloaded",
      delivery: "local",
      resumePositionTicks: 300,
      durationTicks: 1_000,
    });
    expect(resolved?.playbackId).toMatch(/^[0-9a-f-]{36}$/);
    expect(value.probe.probe).toHaveBeenCalledWith(root, target);
    expect(value.updates).toEqual([]);
  });

  it("uses the newest local progress when Jellyfin is unavailable without waiting for its full network timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "lf-local-resolver-offline-"));
    const target = join(root, "download-1", "media.mkv");
    await mkdir(join(root, "download-1"));
    await writeFile(target, Buffer.alloc(100, 2));
    const head = {
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: "episode-1",
      latestRevision: 2,
      conflictPolicy: "automatic" as const,
      actionKind: "progress" as const,
      positionTicks: 450,
      watched: false,
      occurredAt: 2,
      lastSucceededRevision: 1,
      lastSucceededPositionTicks: 300,
      lastSucceededWatched: false,
      updatedAt: 2,
    };
    const value = harness({
      root,
      versions: [localVersion(root, target)],
      head,
      details: () => new Promise<MediaItem>(() => undefined),
      detailsTimeout: 5,
    });
    const resolved = await value.resolver.resolve("episode-1", "resume");
    expect(resolved?.resumePositionTicks).toBe(450);
    expect(resolved?.source).toBe("local");
    expect(resolved?.sourceKind).toBe("offline-local");
  });

  it("prefers newer pending local progress over stale online server progress", async () => {
    const root = await mkdtemp(join(tmpdir(), "lf-local-resolver-stale-server-"));
    const target = join(root, "download-1", "media.mkv");
    await mkdir(join(root, "download-1"));
    await writeFile(target, Buffer.alloc(100, 7));
    const head: PlaybackHeadRecord = {
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: "episode-1",
      latestRevision: 2,
      conflictPolicy: "automatic",
      actionKind: "progress",
      positionTicks: 450,
      watched: false,
      occurredAt: 2,
      lastSucceededRevision: 1,
      lastSucceededPositionTicks: 200,
      lastSucceededWatched: false,
      updatedAt: 2,
    };
    const value = harness({ root, versions: [localVersion(root, target)], head });

    const resolved = await value.resolver.resolve("episode-1", "resume");

    expect(resolved?.resumePositionTicks).toBe(450);
    expect(resolved?.sourceKind).toBe("downloaded");
  });

  it("ignores live metadata returned for a different item", async () => {
    const root = await mkdtemp(join(tmpdir(), "lf-local-resolver-mismatch-"));
    const target = join(root, "download-1", "media.mkv");
    await mkdir(join(root, "download-1"));
    await writeFile(target, Buffer.alloc(100, 10));
    const value = harness({
      root,
      versions: [localVersion(root, target)],
      details: async () => mediaItem({
        id: "different-episode",
        seriesId: "different-series",
        runTimeTicks: 9_999,
        userData: { played: false, playbackPositionTicks: 8_000, playedPercentage: 80 },
      }),
    });

    const resolved = await value.resolver.resolve("episode-1", "resume");

    expect(resolved).toMatchObject({
      itemId: "episode-1",
      seriesId: "series-1",
      durationTicks: 1_000,
      resumePositionTicks: 0,
      sourceKind: "offline-local",
    });
  });

  it("selects matched local before downloaded and honors per-attempt exclusions", async () => {
    const root = await mkdtemp(join(tmpdir(), "lf-local-resolver-order-"));
    const matchedPath = join(root, "matched", "media.mkv");
    const downloadedPath = join(root, "downloaded", "media.mkv");
    await mkdir(join(root, "matched"));
    await mkdir(join(root, "downloaded"));
    await writeFile(matchedPath, Buffer.alloc(100, 8));
    await writeFile(downloadedPath, Buffer.alloc(100, 9));
    const versions = [
      localVersion(root, downloadedPath, { localVersionId: "downloaded", downloadId: "download-1", updatedAt: 20 }),
      localVersion(root, matchedPath, { localVersionId: "matched", downloadId: null, updatedAt: 10 }),
    ];
    const value = harness({ root, versions });

    const matched = await value.resolver.resolve("episode-1", "resume");
    const downloaded = await value.resolver.resolve("episode-1", "resume", new Set(["matched"]));

    expect(matched).toMatchObject({ localVersionId: "matched", sourceKind: "matched-local", mediaUrl: matchedPath });
    expect(downloaded).toMatchObject({ localVersionId: "downloaded", sourceKind: "downloaded", mediaUrl: downloadedPath });
  });

  it("marks missing, size-tampered, path-escaped, and probe-invalid copies unusable", async () => {
    const root = await mkdtemp(join(tmpdir(), "lf-local-resolver-invalid-"));
    const missing = join(root, "missing", "media.mkv");
    const wrongSize = join(root, "wrong", "media.mkv");
    const probeFailed = join(root, "probe", "media.mkv");
    await mkdir(join(root, "wrong"));
    await mkdir(join(root, "probe"));
    await writeFile(wrongSize, Buffer.alloc(99, 3));
    await writeFile(probeFailed, Buffer.alloc(100, 4));
    const outside = join(root, "..", "outside.mkv");
    const versions = [
      localVersion(root, missing, { localVersionId: "missing", updatedAt: 4 }),
      localVersion(root, wrongSize, { localVersionId: "wrong", updatedAt: 3 }),
      localVersion(root, outside, { localVersionId: "outside", updatedAt: 2 }),
      localVersion(root, probeFailed, { localVersionId: "probe", updatedAt: 1 }),
    ];
    const value = harness({
      root,
      versions,
      probe: async () => { throw new AppError("MEDIA_PROBE_FAILED", "Invalid media.", 422); },
    });
    await expect(value.resolver.resolve("episode-1", "resume")).resolves.toBeNull();
    expect(value.updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ localVersionId: "missing", fileState: "missing", probeState: "pending", actualSize: null }),
      expect.objectContaining({ localVersionId: "wrong", fileState: "invalid", probeState: "invalid", actualSize: 99 }),
      expect.objectContaining({ localVersionId: "outside", fileState: "invalid", probeState: "invalid" }),
      expect.objectContaining({ localVersionId: "probe", fileState: "invalid", probeState: "invalid", actualSize: 100 }),
    ]));
    expect(value.probe.probe).toHaveBeenCalledTimes(1);
  });

  it("falls back without invalidating a good copy when the probing service itself is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "lf-local-resolver-probe-unavailable-"));
    const target = join(root, "download-1", "media.mkv");
    await mkdir(join(root, "download-1"));
    await writeFile(target, Buffer.alloc(100, 5));
    const value = harness({
      root,
      versions: [localVersion(root, target)],
      probe: async () => { throw new AppError("MEDIA_PROBE_UNAVAILABLE", "Probe unavailable.", 503); },
    });
    await expect(value.resolver.resolve("episode-1", "resume")).resolves.toBeNull();
    expect(value.updates).toEqual([]);
  });

  it("rejects a junction that lexically appears contained but resolves outside the authorized root", async () => {
    const base = await mkdtemp(join(tmpdir(), "lf-local-resolver-junction-"));
    const root = join(base, "downloads");
    const outside = join(base, "outside");
    const junction = join(root, "escaped-download");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "media.mkv"), Buffer.alloc(100, 6));
    await symlink(outside, junction, "junction");
    const candidate = localVersion(root, join(junction, "media.mkv"));
    const value = harness({ root, versions: [candidate] });

    await expect(value.resolver.resolve("episode-1", "resume")).resolves.toBeNull();
    expect(value.updates).toContainEqual(expect.objectContaining({
      localVersionId: "local-1",
      fileState: "invalid",
      probeState: "invalid",
    }));
    expect(value.probe.probe).not.toHaveBeenCalled();
  });
});
