import { describe, expect, it, vi } from "vitest";
import type { MediaItem, PlaybackStartResult } from "../src/shared/contracts";
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
  player: { loadItem: ReturnType<typeof vi.fn>; setFullscreen: ReturnType<typeof vi.fn> };
} {
  const player = {
    loadItem: vi.fn(async () => result),
    setFullscreen: vi.fn(async () => ({})),
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
});
