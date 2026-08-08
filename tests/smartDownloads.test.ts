import { describe, expect, it, vi } from "vitest";
import type { JellyfinConnectionDiagnostics, MediaItem } from "../src/shared/contracts";
import { CHECK_INTERVAL_MS, EPISODE_PAGE_SIZE, SmartDownloadService } from "../src/main/services/smartDownloads";
import type { DownloadBundleRecord, SmartSeriesRecord } from "../src/main/services/persistenceTypes";

const identity = {
  serverId: "server-1",
  serverAddress: "http://127.0.0.1:8096",
  serverName: "Server",
  userId: "user-1",
  userName: "Viewer",
};

function episode(number: number, overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: `episode-${number}`,
    name: `Episode ${number}`,
    type: "Episode",
    overview: "",
    productionYear: 2026,
    premiereYear: 2026,
    officialRating: null,
    communityRating: null,
    runTimeTicks: 1_800_000_000,
    genres: [],
    primaryImageAspectRatio: null,
    imageTags: {},
    backdropImageTag: null,
    parentThumbItemId: "series-1",
    parentThumbImageTag: null,
    seriesId: "series-1",
    seriesName: "Bridgerton",
    seasonId: "season-3",
    indexNumber: number,
    parentIndexNumber: 3,
    userData: { played: false, playbackPositionTicks: 0, playedPercentage: 0 },
    hasTrailer: false,
    playable: true,
    ...overrides,
  };
}

function rule(overrides: Partial<SmartSeriesRecord> = {}): SmartSeriesRecord {
  return {
    ...identity,
    seriesId: "series-1",
    seriesName: "Bridgerton",
    episodeLimit: 2,
    lastSuccessfulCheck: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastErrorAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function bundle(itemId: string, overrides: Partial<DownloadBundleRecord["job"]> = {}): DownloadBundleRecord {
  return {
    job: {
      downloadId: `download-${itemId}`,
      serverId: identity.serverId,
      userId: identity.userId,
      itemId,
      mediaSourceId: "source-1",
      origin: "manual",
      state: "failed",
      smartManaged: false,
      keepDownloaded: false,
      qualityProfile: null,
      bytesDownloaded: 10,
      expectedSize: 100,
      retryCount: 1,
      errorCode: "TRANSFER_FAILED",
      errorMessage: "Transfer failed.",
      createdAt: 1,
      updatedAt: 1,
      completedAt: null,
      ...overrides,
    },
    localVersion: null,
    itemName: itemId,
    itemType: "Episode",
    item: { seriesId: "series-1" } as DownloadBundleRecord["item"],
    playbackHead: null,
  };
}

function harness(options: {
  episodes?: MediaItem[];
  page?: (startIndex: number, limit: number) => Promise<unknown> | unknown;
  bundles?: DownloadBundleRecord[];
  rules?: SmartSeriesRecord[];
  offline?: boolean;
  playing?: (itemId: string) => boolean;
  playbackHeads?: unknown[];
} = {}) {
  const episodes = options.episodes ?? [episode(1), episode(2), episode(3)];
  const rules = options.rules ?? [rule()];
  const skips = new Set<string>();
  let connectionListener: ((diagnostics: JellyfinConnectionDiagnostics) => void) | null = null;
  const getSeriesEpisodesPage = vi.fn(async (_seriesId: string, startIndex: number, limit: number) => {
    if (options.page) return options.page(startIndex, limit);
    return {
      items: episodes.slice(startIndex, startIndex + limit),
      startIndex,
      totalRecordCount: episodes.length,
      sessionRevision: 7,
    };
  });
  const api = {
    getAuthenticatedContext: vi.fn(() => identity),
    getAuthenticatedSocketContext: vi.fn(() => ({ ...identity, sessionRevision: 7 })),
    getConnectionDiagnostics: vi.fn(() => ({
      state: options.offline ? "offline" : "connected",
      serverName: "Server",
      serverVersion: "10.11",
      requestLatencyMs: 10,
      measuredAt: new Date().toISOString(),
    })),
    onConnectionDiagnostics: vi.fn((listener: (diagnostics: JellyfinConnectionDiagnostics) => void) => {
      connectionListener = listener;
      return () => { connectionListener = null; };
    }),
    getDetails: vi.fn(async () => ({ ...episode(1), id: "series-1", type: "Series", name: "Bridgerton" })),
    getSeriesEpisodesPage,
  };
  const persistence = {
    listSmartSeries: vi.fn(async () => rules),
    recordSmartSeriesCheck: vi.fn(async () => undefined),
    listSmartEpisodeSkips: vi.fn(async () => [...skips]),
    addSmartEpisodeSkip: vi.fn(async (_serverId: string, _userId: string, _seriesId: string, itemId: string) => {
      skips.add(itemId);
    }),
    listDownloadBundles: vi.fn(async () => options.bundles ?? []),
    listPlaybackHeadsForSeries: vi.fn(async () => options.playbackHeads ?? []),
    getDownloadBundle: vi.fn(async (downloadId: string) => (options.bundles ?? []).find((entry) => entry.job.downloadId === downloadId) ?? null),
    getMediaItem: vi.fn(async () => null),
    upsertSmartSeries: vi.fn(async () => rule()),
    unfollowSmartSeriesKeep: vi.fn(async () => undefined),
    deleteSmartSeries: vi.fn(async () => undefined),
  };
  const downloads = {
    startSmart: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    setSmartManaged: vi.fn(async () => undefined),
    refreshSummaries: vi.fn(async () => undefined),
  };
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const service = new SmartDownloadService(
    api as never,
    persistence as never,
    downloads,
    options.playing ?? (() => false),
    logger as never,
  );
  Object.assign(service as object, { active: true, identity, serviceRevision: 1 });
  return {
    service,
    api,
    persistence,
    downloads,
    skips,
    emitConnection(state: "unknown" | "connected" | "offline" | "reconnecting") {
      connectionListener?.({ state, serverName: "Server", serverVersion: "10.11", requestLatencyMs: 10, measuredAt: new Date().toISOString() });
    },
  };
}

describe("SmartDownloadService", () => {
  it("uses a three-hour background interval", () => {
    expect(CHECK_INTERVAL_MS).toBe(3 * 60 * 60 * 1000);
  });

  it("ignores repeated healthy diagnostics and checks once after a real reconnect", async () => {
    const { api, emitConnection } = harness();

    emitConnection("connected");
    emitConnection("connected");
    expect(api.getSeriesEpisodesPage).not.toHaveBeenCalled();

    emitConnection("offline");
    emitConnection("reconnecting");
    emitConnection("connected");
    await vi.waitFor(() => expect(api.getSeriesEpisodesPage).toHaveBeenCalledOnce());
  });

  it("uses exact 200-item pages and lets a failed matching job occupy the first-N target", async () => {
    const episodes = Array.from({ length: 201 }, (_, index) => episode(index + 1));
    const existing = bundle("episode-1", { state: "failed", smartManaged: false, origin: "manual" });
    const { service, api, downloads } = harness({ episodes, bundles: [existing] });

    await service.checkNow();

    expect(EPISODE_PAGE_SIZE).toBe(200);
    expect(api.getSeriesEpisodesPage).toHaveBeenNthCalledWith(1, "series-1", 0, 200);
    expect(api.getSeriesEpisodesPage).toHaveBeenNthCalledWith(2, "series-1", 200, 200);
    expect(downloads.startSmart).toHaveBeenCalledTimes(1);
    expect(downloads.startSmart).toHaveBeenCalledWith("episode-2");
  });

  it("queues a newly added next episode after every earlier regular episode is watched", async () => {
    const episodes = Array.from({ length: 7 }, (_, index) => episode(index + 1, {
      userData: { played: index < 6, playbackPositionTicks: 0, playedPercentage: index < 6 ? 100 : 0 },
    }));
    const { service, downloads } = harness({ episodes, rules: [rule({ episodeLimit: 1 })] });

    await service.checkNow();

    expect(downloads.startSmart).toHaveBeenCalledOnce();
    expect(downloads.startSmart).toHaveBeenCalledWith("episode-7");
  });

  it("excludes specials, missing episodes, and malformed episode numbering from targets", async () => {
    const episodes = [
      episode(1, { id: "special", parentIndexNumber: 0 }),
      episode(2, { id: "missing", playable: false }),
      episode(3, { id: "malformed", indexNumber: null }),
      episode(4, { id: "regular", parentIndexNumber: 1, indexNumber: 4 }),
    ];
    const { service, downloads } = harness({ episodes, rules: [rule({ episodeLimit: 3 })] });

    await service.checkNow();

    expect(downloads.startSmart).toHaveBeenCalledTimes(1);
    expect(downloads.startSmart).toHaveBeenCalledWith("regular");
  });

  it("combines durable local completion with Jellyfin watched state", async () => {
    const { service, downloads } = harness({
      rules: [rule({ episodeLimit: 1 })],
      playbackHeads: [{ itemId: "episode-1", watched: true }],
    });

    await service.checkNow();

    expect(downloads.startSmart).toHaveBeenCalledOnce();
    expect(downloads.startSmart).toHaveBeenCalledWith("episode-2");
  });

  it("queues and removes nothing when pagination is incomplete", async () => {
    const old = bundle("episode-9", { state: "completed", smartManaged: true, origin: "smart" });
    const { service, persistence, downloads } = harness({
      bundles: [old],
      page: (startIndex) => ({
        items: startIndex === 0 ? Array.from({ length: 200 }, (_, index) => episode(index + 1)) : [],
        startIndex,
        totalRecordCount: 201,
        sessionRevision: 7,
      }),
    });

    await service.checkNow();

    expect(downloads.startSmart).not.toHaveBeenCalled();
    expect(downloads.cancel).not.toHaveBeenCalled();
    expect(downloads.delete).not.toHaveBeenCalled();
    expect(persistence.recordSmartSeriesCheck).toHaveBeenCalledWith(
      identity.serverId,
      identity.userId,
      "series-1",
      expect.objectContaining({ success: false, errorCode: "EPISODE_ENUMERATION_INCOMPLETE" }),
    );
  });

  it.each([
    ["changing totals", (startIndex: number) => ({
      items: startIndex === 0 ? Array.from({ length: 200 }, (_, index) => episode(index + 1)) : [episode(201)],
      startIndex,
      totalRecordCount: startIndex === 0 ? 201 : 202,
      sessionRevision: 7,
    })],
    ["a repeated identity", (startIndex: number) => ({
      items: startIndex === 0 ? Array.from({ length: 200 }, (_, index) => episode(index + 1)) : [episode(1)],
      startIndex,
      totalRecordCount: 201,
      sessionRevision: 7,
    })],
    ["a stale session page", (startIndex: number) => ({
      items: startIndex === 0 ? Array.from({ length: 200 }, (_, index) => episode(index + 1)) : [episode(201)],
      startIndex,
      totalRecordCount: 201,
      sessionRevision: startIndex === 0 ? 7 : 8,
    })],
  ])("makes no download changes for %s", async (_label, page) => {
    const old = bundle("episode-9", { state: "downloading", smartManaged: true, origin: "smart" });
    const { service, downloads } = harness({ bundles: [old], page });

    await service.checkNow();

    expect(downloads.startSmart).not.toHaveBeenCalled();
    expect(downloads.cancel).not.toHaveBeenCalled();
    expect(downloads.delete).not.toHaveBeenCalled();
  });

  it("persists a skip before removal and does not retarget the skipped unwatched episode", async () => {
    const managed = bundle("episode-1", { state: "downloading", smartManaged: true, origin: "smart" });
    const { service, persistence, downloads, skips } = harness({ bundles: [managed], rules: [rule({ episodeLimit: 1 })] });

    await service.skip(managed.job.downloadId);

    expect(persistence.addSmartEpisodeSkip).toHaveBeenCalledBefore(downloads.cancel);
    expect(skips.has("episode-1")).toBe(true);
    expect(downloads.startSmart).toHaveBeenCalledWith("episode-2");
  });

  it("derives offline state at runtime without persisting it", async () => {
    const { service, persistence } = harness({ offline: true });
    const state = await service.getState();
    expect(state.series[0]?.status).toBe("offline");
    expect(persistence.recordSmartSeriesCheck).not.toHaveBeenCalled();
  });

  it("rotates only enumerated unkept managed copies and clears management after deletion", async () => {
    const rotated = bundle("episode-3", { state: "completed", smartManaged: true, origin: "smart" });
    rotated.localVersion = { fileState: "finalized", probeState: "valid" } as DownloadBundleRecord["localVersion"];
    const manual = bundle("episode-4", { state: "completed", smartManaged: false, origin: "manual" });
    manual.localVersion = { fileState: "finalized", probeState: "valid" } as DownloadBundleRecord["localVersion"];
    const kept = bundle("episode-5", { state: "completed", smartManaged: true, origin: "smart", keepDownloaded: true });
    kept.localVersion = { fileState: "finalized", probeState: "valid" } as DownloadBundleRecord["localVersion"];
    const disappeared = bundle("episode-999", { state: "completed", smartManaged: true, origin: "smart" });
    disappeared.localVersion = { fileState: "finalized", probeState: "valid" } as DownloadBundleRecord["localVersion"];
    const { service, downloads } = harness({
      episodes: [episode(1), episode(2), episode(3), episode(4), episode(5)],
      bundles: [rotated, manual, kept, disappeared],
    });

    await service.checkNow();

    expect(downloads.delete).toHaveBeenCalledTimes(1);
    expect(downloads.delete).toHaveBeenCalledWith(rotated.job.downloadId);
    expect(downloads.setSmartManaged).toHaveBeenCalledWith(rotated.job.downloadId, false);
    expect(downloads.delete).not.toHaveBeenCalledWith(manual.job.downloadId);
    expect(downloads.delete).not.toHaveBeenCalledWith(kept.job.downloadId);
    expect(downloads.delete).not.toHaveBeenCalledWith(disappeared.job.downloadId);
  });

  it("defers active-copy cleanup until playback stops and a second complete enumeration succeeds", async () => {
    let playing = true;
    const old = bundle("episode-3", { state: "downloading", smartManaged: true, origin: "smart" });
    const { service, api, downloads } = harness({ bundles: [old], playing: () => playing });

    await service.checkNow();
    expect(downloads.cancel).not.toHaveBeenCalled();
    playing = false;
    service.notifyPlaybackStopped();

    await vi.waitFor(() => expect(downloads.cancel).toHaveBeenCalledWith(old.job.downloadId));
    expect(api.getSeriesEpisodesPage).toHaveBeenCalledTimes(2);
  });

  it("unfollows locally while offline and keeps copies through one persistence transaction", async () => {
    const { service, api, persistence, downloads } = harness({ offline: true });

    await service.unfollow("series-1", "keep");

    expect(api.getSeriesEpisodesPage).not.toHaveBeenCalled();
    expect(persistence.unfollowSmartSeriesKeep).toHaveBeenCalledWith("server-1", "user-1", "series-1");
    expect(downloads.cancel).not.toHaveBeenCalled();
  });

  it("retains playing copies as unmanaged when removing Smart copies during offline unfollow", async () => {
    const playing = bundle("episode-1", { state: "downloading", smartManaged: true, origin: "smart" });
    const removable = bundle("episode-2", { state: "downloading", smartManaged: true, origin: "smart" });
    const { service, api, persistence, downloads } = harness({
      offline: true,
      bundles: [playing, removable],
      playing: (itemId) => itemId === "episode-1",
    });

    await service.unfollow("series-1", "remove");

    expect(api.getSeriesEpisodesPage).not.toHaveBeenCalled();
    expect(downloads.cancel).toHaveBeenCalledWith(removable.job.downloadId);
    expect(downloads.cancel).not.toHaveBeenCalledWith(playing.job.downloadId);
    expect(downloads.setSmartManaged).toHaveBeenCalledWith(playing.job.downloadId, false);
    expect(persistence.deleteSmartSeries).toHaveBeenCalledWith("server-1", "user-1", "series-1");
  });

  it("completes offline unfollow with a warning when local cleanup fails", async () => {
    const removable = bundle("episode-1", { state: "downloading", smartManaged: true, origin: "smart" });
    const { service, persistence, downloads } = harness({ offline: true, bundles: [removable] });
    downloads.cancel.mockRejectedValueOnce(new Error("locked file"));

    const result = await service.unfollow("series-1", "remove");

    expect(result.warning).toBe("Some copies could not be removed and were kept as ordinary downloads.");
    expect(downloads.setSmartManaged).toHaveBeenCalledWith(removable.job.downloadId, false);
    expect(persistence.deleteSmartSeries).toHaveBeenCalledWith("server-1", "user-1", "series-1");
  });
});
