import { describe, expect, it, vi } from "vitest";
import type { MediaItem, PlaybackStartResult, PlaybackState } from "../src/shared/contracts";
import type { PlayerController } from "../src/main/services/playerController";
import { PlaybackCommandService } from "../src/main/services/playbackCommandService";
import type { PlaybackQueueStore } from "../src/main/services/playbackQueue";

const item = { id: "movie-1" } as MediaItem;
const result: PlaybackStartResult = {
  playbackId: "03291b62-bf85-4f21-9fb3-1a97dd551a01",
  resumePositionTicks: 0,
  durationTicks: 10_000_000,
  source: "server",
  sourceKind: "direct-play",
};

function harness(): {
  service: PlaybackCommandService;
  player: { loadItem: ReturnType<typeof vi.fn>; setFullscreen: ReturnType<typeof vi.fn>; seek: ReturnType<typeof vi.fn>; getState: ReturnType<typeof vi.fn> };
} {
  const state: PlaybackState = {
    playbackId: result.playbackId, itemId: item.id, phase: "playing", source: "server", positionTicks: 0, durationTicks: result.durationTicks,
    paused: false, buffering: false, seekable: true, seekableUntilTicks: null, volume: 100, fullscreen: false, audioTracks: [], subtitleTracks: [], error: null,
    contentKind: "on-demand",
  };
  const player = {
    loadItem: vi.fn(async () => result),
    setFullscreen: vi.fn(async () => ({})),
    getState: vi.fn(() => state),
    seek: vi.fn(async () => state),
  };
  const queue = { reset: vi.fn() };
  const service = new PlaybackCommandService(
    player as unknown as PlayerController,
    {
      getDetails: vi.fn(async () => item),
      getEpisodes: vi.fn(async () => []),
      getNextUpForSeries: vi.fn(async () => null),
    },
    queue as unknown as PlaybackQueueStore,
  );
  return { service, player };
}

describe("PlaybackCommandService Companion presentation", () => {
  it("enters fullscreen after Companion playback starts", async () => {
    const { service, player } = harness();
    await service.start(item.id, "start-over");
    expect(player.setFullscreen).toHaveBeenCalledWith(result.playbackId, true, { origin: "companion" });
  });

  it("preserves desktop fullscreen behavior for local starts", async () => {
    const { service, player } = harness();
    await service.start(item.id, "start-over", false, "local-user");
    expect(player.setFullscreen).not.toHaveBeenCalled();
  });

  it("carries an explicit Watch now requirement only for that local start", async () => {
    const { service, player } = harness();
    await service.start(item.id, "resume", false, "local-user", true);
    expect(player.loadItem).toHaveBeenCalledWith(item.id, "resume", {
      origin: "local-user",
      requireProgressive: true,
    });
  });

  it("forwards an explicit movie version only for that local start", async () => {
    const { service, player } = harness();
    await service.start(item.id, "resume", false, "local-user", false, "source-4k");
    expect(player.loadItem).toHaveBeenCalledWith(item.id, "resume", {
      origin: "local-user",
      preferredMediaSourceId: "source-4k",
    });
  });

  it("rejects explicit version starts while joined to a watch party", async () => {
    const { service, player } = harness();
    const selectItem = vi.fn();
    service.setSyncPlay({ isJoined: () => true, selectItem } as never);
    await expect(service.start(item.id, "start-over", false, "local-user", false, "source-4k"))
      .rejects.toMatchObject({ code: "MOVIE_VERSION_WATCH_PARTY_UNAVAILABLE" });
    expect(selectItem).not.toHaveBeenCalled();
    expect(player.loadItem).not.toHaveBeenCalled();
  });
});

describe("PlaybackCommandService seek identity", () => {
  it("seeks the current ordinary playback and rejects a stale one", async () => {
    const { service, player } = harness();
    await service.seek(result.playbackId, 5_000_000, "local-user");
    expect(player.seek).toHaveBeenCalledWith(result.playbackId, 5_000_000, { origin: "local-user" });
    await expect(service.seek("11111111-1111-4111-8111-111111111111", 5_000_000, "local-user"))
      .rejects.toMatchObject({ code: "INVALID_PLAYBACK" });
  });

  it("uses only the shared SyncPlay seek for the current playback", async () => {
    const { service, player } = harness();
    const requestSeek = vi.fn(async () => player.getState());
    service.setSyncPlay({ isJoined: () => true, requestSeek } as never);
    await service.seek(result.playbackId, 5_000_000, "local-user");
    expect(requestSeek).toHaveBeenCalledWith(5_000_000);
    expect(player.seek).not.toHaveBeenCalled();
    await expect(service.seek("11111111-1111-4111-8111-111111111111", 5_000_000, "local-user"))
      .rejects.toMatchObject({ code: "INVALID_PLAYBACK" });
    expect(requestSeek).toHaveBeenCalledTimes(1);
  });
});
