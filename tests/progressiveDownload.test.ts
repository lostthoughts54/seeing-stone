import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveProgressiveDownloadLease, type ProgressiveLeaseEvent } from "../src/main/services/progressiveDownload";
import { progressiveStartupThreshold } from "../src/main/services/downloadManager";
import type { MediaItem, PlaybackDiagnostics } from "../src/shared/contracts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const item: MediaItem = {
  id: "movie-1",
  name: "Movie",
  type: "Movie",
  overview: "",
  productionYear: null,
  premiereYear: null,
  officialRating: null,
  communityRating: null,
  runTimeTicks: 80_000_000,
  genres: [],
  primaryImageAspectRatio: null,
  imageTags: {},
  backdropImageTag: null,
  parentThumbItemId: null,
  parentThumbImageTag: null,
  seriesId: null,
  seriesName: null,
  seasonId: null,
  indexNumber: null,
  parentIndexNumber: null,
  userData: { played: false, playbackPositionTicks: 0, playedPercentage: 0 },
  hasTrailer: false,
  playable: true,
};

const diagnostics: PlaybackDiagnostics = {
  sourceKind: "downloading",
  playbackRate: 1,
  bufferAheadTicks: null,
  container: "mkv",
  videoCodec: "h264",
  audioCodec: "aac",
  audioChannels: 2,
  resolution: "1920×1080",
  bitrate: 8_000_000,
  videoRange: "SDR",
  transcodeReason: null,
};

async function fixture(initial = Uint8Array.from([0, 1, 2, 3]), expectedSize = 8) {
  const root = await mkdtemp(join(tmpdir(), "seeing-stone-progressive-"));
  roots.push(root);
  const path = join(root, "media.part");
  await writeFile(path, initial);
  const fetchMetadataRange = vi.fn(async (range: string) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
    const length = Number(match[2]) - Number(match[1]) + 1;
    return new Response(new Uint8Array(length).fill(9), {
      status: 206,
      headers: {
        "Content-Length": String(length),
        "Content-Range": `${range.replace("=", " ")}/${expectedSize}`,
        "Accept-Ranges": "bytes",
      },
    });
  });
  const lease = new ActiveProgressiveDownloadLease({
    descriptor: {
      item,
      itemId: item.id,
      itemType: "Movie",
      seriesId: null,
      mediaSourceId: "source-1",
      durationTicks: item.runTimeTicks,
      expectedSize,
      container: "mkv",
      diagnostics,
    },
    initialPath: path,
    initialBytes: initial.byteLength,
    fetchMetadataRange,
    onRelease: vi.fn(),
  });
  return { lease, path, fetchMetadataRange };
}

describe("ActiveProgressiveDownloadLease", () => {
  it("uses 30 seconds of bitrate with the fixed minimum and unknown-bitrate fallback", () => {
    const mib = 1024 * 1024;
    expect(progressiveStartupThreshold(100 * mib, 8_000_000)).toBe(30_000_000);
    expect(progressiveStartupThreshold(100 * mib, 1_000_000)).toBe(8 * mib);
    expect(progressiveStartupThreshold(100 * mib, null)).toBe(32 * mib);
    expect(progressiveStartupThreshold(4 * mib, null)).toBe(4 * mib);
  });

  it("advertises the stable total and waits at the downloaded frontier until a write is published", async () => {
    const { lease, path } = await fixture();
    const response = await lease.handle(new Request("http://progressive/media", { headers: { Range: "bytes=0-7" } }));
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-7/8");
    expect(response.headers.get("content-length")).toBe("8");

    const reader = response.body!.getReader();
    expect([...((await reader.read()).value ?? [])]).toEqual([0, 1, 2, 3]);
    let frontierResolved = false;
    const frontierRead = reader.read().then((value) => {
      frontierResolved = true;
      return value;
    });
    await Promise.resolve();
    expect(frontierResolved).toBe(false);

    await writeFile(path, Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]));
    lease.publishBytes(8);
    expect([...((await frontierRead).value ?? [])]).toEqual([4, 5, 6, 7]);
    expect((await reader.read()).done).toBe(true);
  });

  it("rejects malformed or unavailable ranges and aborts a frontier waiter when invalidated", async () => {
    const { lease } = await fixture();
    expect((await lease.handle(new Request("http://progressive/media", { headers: { Range: "bytes=0-1,4-5" } }))).status).toBe(416);
    lease.endMetadataAllowance();
    expect((await lease.handle(new Request("http://progressive/media", { headers: { Range: "bytes=5-6" } }))).status).toBe(416);

    const response = await lease.handle(new Request("http://progressive/media", { headers: { Range: "bytes=4-5" } }));
    const reading = response.body!.getReader().read();
    lease.publishInvalidated("cancelled");
    await expect(reading).rejects.toThrow("lease ended");
  });

  it("bounds startup metadata assistance without changing progress or the seekable prefix", async () => {
    const { lease, fetchMetadataRange } = await fixture();
    const events: ProgressiveLeaseEvent[] = [];
    lease.onEvent((event) => events.push(event));

    const assisted = await lease.handle(new Request("http://progressive/media", { headers: { Range: "bytes=6-7" } }));
    expect(assisted.status).toBe(206);
    expect([...new Uint8Array(await assisted.arrayBuffer())]).toEqual([9, 9]);
    expect(fetchMetadataRange).toHaveBeenCalledWith("bytes=6-7", expect.any(AbortSignal));
    expect(events).toEqual([]);

    lease.endMetadataAllowance();
    expect((await lease.handle(new Request("http://progressive/media", { headers: { Range: "bytes=5-6" } }))).status).toBe(416);

    const large = await fixture(new Uint8Array(1), 20 * 1024 * 1024);
    expect((await large.lease.handle(new Request("http://progressive/media", {
      headers: { Range: `bytes=2-${16 * 1024 * 1024 + 2}` },
    }))).status).toBe(416);
    expect(large.fetchMetadataRange).not.toHaveBeenCalled();
  });

  it("rejects a server response that does not honor the exact bounded metadata range", async () => {
    const { lease, fetchMetadataRange } = await fixture();
    fetchMetadataRange.mockResolvedValueOnce(new Response(new Uint8Array(8), {
      status: 200,
      headers: { "Content-Length": "8" },
    }));
    expect((await lease.handle(new Request("http://progressive/media", {
      headers: { Range: "bytes=6-7" },
    }))).status).toBe(502);
  });

  it("hands an active lease to the finalized path and still permits later lifecycle invalidation", async () => {
    const { lease, path } = await fixture(Uint8Array.from([0, 1, 2, 3]), 4);
    const events: ProgressiveLeaseEvent[] = [];
    lease.onEvent((event) => events.push(event));
    await lease.beginFinalization();
    lease.publishRenamed(path);
    lease.publishCompleted(path);
    lease.publishInvalidated("deleted");
    expect(events).toEqual([{ type: "completed" }, { type: "invalidated", reason: "deleted" }]);
  });
});
