import { describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../src/shared/contracts";
import {
  coalescePlaybackRevisions,
  OfflineSynchronizationService,
} from "../src/main/services/offlineSynchronization";
import type {
  PlaybackHeadRecord,
  PlaybackRevisionRecord,
  RecordPlaybackRevisionInput,
} from "../src/main/services/persistenceTypes";

const context = {
  serverId: "server-1",
  serverAddress: "https://server.invalid",
  serverName: "Server",
  userId: "user-1",
  userName: "Viewer",
};

function revision(localRevision: number, overrides: Partial<PlaybackRevisionRecord> = {}): PlaybackRevisionRecord {
  return {
    serverId: context.serverId,
    userId: context.userId,
    itemId: "episode-1",
    localRevision,
    actionKind: "progress",
    positionTicks: localRevision * 100,
    watched: false,
    completionEvent: false,
    occurredAt: localRevision,
    syncState: "pending",
    attemptCount: 0,
    lastError: null,
    syncedAt: null,
    ...overrides,
  };
}

class MemoryPlaybackPersistence {
  revisions: PlaybackRevisionRecord[] = [];
  heads = new Map<string, PlaybackHeadRecord>();

  async recordPlaybackRevision(input: RecordPlaybackRevisionInput): Promise<PlaybackRevisionRecord> {
    const existing = this.revisions.filter((entry) => entry.itemId === input.itemId);
    const value = revision(existing.length + 1, {
      ...input,
      completionEvent: input.actionKind === "completed",
    });
    this.revisions.push(value);
    const previous = this.heads.get(input.itemId);
    this.heads.set(input.itemId, {
      ...input,
      latestRevision: value.localRevision,
      lastSucceededRevision: previous?.lastSucceededRevision ?? 0,
      lastSucceededPositionTicks: previous?.lastSucceededPositionTicks ?? 0,
      lastSucceededWatched: previous?.lastSucceededWatched ?? false,
      updatedAt: input.occurredAt,
    });
    return structuredClone(value);
  }

  async getPlaybackHead(_serverId: string, _userId: string, itemId: string): Promise<PlaybackHeadRecord | null> {
    return structuredClone(this.heads.get(itemId) ?? null);
  }

  async listPendingProgress(): Promise<PlaybackRevisionRecord[]> {
    return structuredClone(this.revisions.filter((entry) => entry.syncState === "pending" || entry.syncState === "failed"));
  }

  async markProgressSucceeded(_serverId: string, _userId: string, itemId: string, localRevision: number): Promise<void> {
    const entry = this.find(itemId, localRevision);
    entry.syncState = "succeeded";
    entry.attemptCount += 1;
    entry.syncedAt = Date.now();
    entry.lastError = null;
    const head = this.heads.get(itemId)!;
    if (localRevision > head.lastSucceededRevision) {
      head.lastSucceededRevision = localRevision;
      head.lastSucceededPositionTicks = entry.positionTicks;
      head.lastSucceededWatched = entry.watched;
    }
  }

  async markProgressFailed(_serverId: string, _userId: string, itemId: string, localRevision: number, error: string): Promise<PlaybackRevisionRecord> {
    const entry = this.find(itemId, localRevision);
    entry.syncState = "failed";
    entry.attemptCount += 1;
    entry.lastError = error;
    return structuredClone(entry);
  }

  async markPlaybackSuperseded(_serverId: string, _userId: string, itemId: string, localRevision: number): Promise<PlaybackRevisionRecord> {
    const entry = this.find(itemId, localRevision);
    entry.syncState = "superseded";
    entry.lastError = null;
    return structuredClone(entry);
  }

  seed(entries: PlaybackRevisionRecord[], head: PlaybackHeadRecord): void {
    this.revisions = structuredClone(entries);
    this.heads.set(head.itemId, structuredClone(head));
  }

  private find(itemId: string, localRevision: number): PlaybackRevisionRecord {
    const entry = this.revisions.find((candidate) => candidate.itemId === itemId && candidate.localRevision === localRevision);
    if (!entry) throw new Error("revision missing");
    return entry;
  }
}

function remoteItem(positionTicks: number, played: boolean): MediaItem {
  return {
    id: "episode-1",
    name: "Episode",
    type: "Episode",
    overview: "",
    productionYear: null,
    premiereYear: null,
    officialRating: null,
    communityRating: null,
    runTimeTicks: 1000,
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
    userData: { played, playbackPositionTicks: positionTicks, playedPercentage: 0 },
    hasTrailer: false,
    playable: true,
  };
}

describe("OfflineSynchronizationService", () => {
  it("coalesces automatic progress while preserving completion and explicit revisions", () => {
    const values = [
      revision(1),
      revision(2),
      revision(3, { actionKind: "completed", watched: true, completionEvent: true }),
      revision(4, { actionKind: "replay", positionTicks: 0 }),
      revision(5, { positionTicks: 100 }),
      revision(6, { positionTicks: 200 }),
    ];
    const plan = coalescePlaybackRevisions(values);
    expect(plan.selected.map((entry) => entry.localRevision)).toEqual([3, 4, 6]);
    expect(plan.superseded.map((entry) => entry.localRevision)).toEqual([1, 2, 5]);
  });

  it("synchronizes completion, replay, and newest progress in revision order", async () => {
    const persistence = new MemoryPlaybackPersistence();
    const entries = [
      revision(1, { positionTicks: 100 }),
      revision(2, { positionTicks: 200 }),
      revision(3, { actionKind: "completed", positionTicks: 1000, watched: true, completionEvent: true }),
      revision(4, { actionKind: "replay", positionTicks: 0 }),
      revision(5, { positionTicks: 100 }),
      revision(6, { positionTicks: 250 }),
    ];
    persistence.seed(entries, {
      serverId: context.serverId,
      userId: context.userId,
      itemId: "episode-1",
      latestRevision: 6,
      actionKind: "progress",
      positionTicks: 250,
      watched: false,
      occurredAt: 6,
      lastSucceededRevision: 0,
      lastSucceededPositionTicks: 0,
      lastSucceededWatched: false,
      updatedAt: 6,
    });
    let remote = remoteItem(0, false);
    const sent: string[] = [];
    const api = {
      getAuthenticatedContext: () => context,
      getDetails: vi.fn(async () => remote),
      synchronizeOfflinePlayback: vi.fn(async (input: { actionKind: string; positionTicks: number; watched: boolean }) => {
        sent.push(input.actionKind);
        remote = remoteItem(input.positionTicks, input.watched);
      }),
    };
    const service = new OfflineSynchronizationService(api, persistence as never, { info() {}, warn() {}, error() {} }, 1_000_000);
    service.activate();
    await service.syncNow();
    await service.shutdown();

    expect(sent).toEqual(["completed", "replay", "progress"]);
    expect(persistence.revisions.filter((entry) => entry.syncState === "superseded").map((entry) => entry.localRevision)).toEqual([1, 2, 5]);
    expect(persistence.heads.get("episode-1")?.lastSucceededRevision).toBe(6);
    expect(persistence.heads.get("episode-1")?.lastSucceededPositionTicks).toBe(250);
    expect(persistence.heads.get("episode-1")?.lastSucceededWatched).toBe(false);
  });

  it("never sends stale automatic progress but permits a newer explicit lower revision", async () => {
    const persistence = new MemoryPlaybackPersistence();
    const entries = [
      revision(2, { positionTicks: 600 }),
      revision(3, { actionKind: "start_over", positionTicks: 0 }),
    ];
    persistence.seed(entries, {
      serverId: context.serverId,
      userId: context.userId,
      itemId: "episode-1",
      latestRevision: 3,
      actionKind: "start_over",
      positionTicks: 0,
      watched: false,
      occurredAt: 3,
      lastSucceededRevision: 1,
      lastSucceededPositionTicks: 700,
      lastSucceededWatched: true,
      updatedAt: 3,
    });
    const sent: string[] = [];
    const api = {
      getAuthenticatedContext: () => context,
      getDetails: vi.fn(async () => remoteItem(800, true)),
      synchronizeOfflinePlayback: vi.fn(async (input: { actionKind: string }) => { sent.push(input.actionKind); }),
    };
    const service = new OfflineSynchronizationService(api, persistence as never, { info() {}, warn() {}, error() {} }, 1_000_000);
    service.activate();
    await service.syncNow();
    await service.shutdown();

    expect(sent).toEqual(["start_over"]);
    expect(persistence.revisions.find((entry) => entry.localRevision === 2)?.syncState).toBe("superseded");
    expect(persistence.revisions.find((entry) => entry.localRevision === 3)?.syncState).toBe("succeeded");
    expect(persistence.heads.get("episode-1")?.lastSucceededPositionTicks).toBe(0);
    expect(persistence.heads.get("episode-1")?.lastSucceededWatched).toBe(false);
  });

  it("does not move Jellyfin behind newer remote automatic progress", async () => {
    const persistence = new MemoryPlaybackPersistence();
    persistence.seed([revision(2, { positionTicks: 600 })], {
      serverId: context.serverId,
      userId: context.userId,
      itemId: "episode-1",
      latestRevision: 2,
      actionKind: "progress",
      positionTicks: 600,
      watched: false,
      occurredAt: 2,
      lastSucceededRevision: 1,
      lastSucceededPositionTicks: 500,
      lastSucceededWatched: false,
      updatedAt: 2,
    });
    const synchronizeOfflinePlayback = vi.fn(async () => undefined);
    const service = new OfflineSynchronizationService({
      getAuthenticatedContext: () => context,
      getDetails: vi.fn(async () => remoteItem(800, false)),
      synchronizeOfflinePlayback,
    }, persistence as never, { info() {}, warn() {}, error() {} }, 1_000_000);
    service.activate();
    await service.syncNow();
    await service.shutdown();

    expect(synchronizeOfflinePlayback).not.toHaveBeenCalled();
    expect(persistence.revisions[0].syncState).toBe("superseded");
    expect(persistence.heads.get("episode-1")?.lastSucceededPositionTicks).toBe(500);
  });

  it("skips active playback, then retries a failed synchronization after playback stops", async () => {
    const persistence = new MemoryPlaybackPersistence();
    const pending = revision(1, { positionTicks: 400 });
    persistence.seed([pending], {
      serverId: context.serverId,
      userId: context.userId,
      itemId: "episode-1",
      latestRevision: 1,
      actionKind: "progress",
      positionTicks: 400,
      watched: false,
      occurredAt: 1,
      lastSucceededRevision: 0,
      lastSucceededPositionTicks: 0,
      lastSucceededWatched: false,
      updatedAt: 1,
    });
    const synchronizeOfflinePlayback = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("offline"), { code: "NETWORK_ERROR" }))
      .mockResolvedValueOnce(undefined);
    const service = new OfflineSynchronizationService({
      getAuthenticatedContext: () => context,
      getDetails: vi.fn(async () => remoteItem(0, false)),
      synchronizeOfflinePlayback,
    }, persistence as never, { info() {}, warn() {}, error() {} }, 1_000_000);
    service.setActive(pending, true);
    service.activate();
    await service.syncNow();
    expect(synchronizeOfflinePlayback).not.toHaveBeenCalled();

    service.setActive(pending, false);
    await service.syncNow();
    expect(persistence.revisions[0]).toMatchObject({ syncState: "failed", attemptCount: 1, lastError: "NETWORK_ERROR" });
    await service.syncNow();
    await service.shutdown();

    expect(synchronizeOfflinePlayback).toHaveBeenCalledTimes(2);
    expect(persistence.revisions[0]).toMatchObject({ syncState: "succeeded", attemptCount: 2, lastError: null });
  });

  it("does not commit an in-flight success after the authenticated session is deactivated", async () => {
    const persistence = new MemoryPlaybackPersistence();
    const pending = revision(1, { positionTicks: 400 });
    persistence.seed([pending], {
      serverId: context.serverId,
      userId: context.userId,
      itemId: "episode-1",
      latestRevision: 1,
      actionKind: "progress",
      positionTicks: 400,
      watched: false,
      occurredAt: 1,
      lastSucceededRevision: 0,
      lastSucceededPositionTicks: 0,
      lastSucceededWatched: false,
      updatedAt: 1,
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const synchronizeOfflinePlayback = vi.fn(async () => blocked);
    const service = new OfflineSynchronizationService({
      getAuthenticatedContext: () => context,
      getDetails: vi.fn(async () => remoteItem(0, false)),
      synchronizeOfflinePlayback,
    }, persistence as never, { info() {}, warn() {}, error() {} }, 1_000_000);
    service.activate();
    const run = service.syncNow();
    await vi.waitFor(() => expect(synchronizeOfflinePlayback).toHaveBeenCalledTimes(1));
    service.deactivate();
    release();
    await run;
    await service.shutdown();

    expect(persistence.revisions[0]).toMatchObject({ syncState: "pending", attemptCount: 0, syncedAt: null });
    expect(persistence.heads.get("episode-1")?.lastSucceededRevision).toBe(0);
  });
});
