import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalSubtitleTrack } from "../src/shared/contracts";
import { cacheDownloadSubtitles, getLocalSubtitles, readLocalSubtitle } from "../src/main/services/downloadSubtitles";
import { PlaybackSessionService } from "../src/main/services/playbackSession";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const child = relative(resolve(tmpdir()), resolve(root));
    if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("Unsafe test cleanup path");
    await rm(root, { recursive: true, force: true });
  }
});

const tracks: ExternalSubtitleTrack[] = ["srt", "ass", "ssa", "vtt"].map((format, index) => ({
  streamIndex: index + 2, format: format as ExternalSubtitleTrack["format"],
  title: `Track ${index}`, language: index ? "spa" : "eng", isDefault: index === 0, isForced: index === 1,
}));
const text = "1\n00:00:01,000 --> 00:00:02,000\nHello\n";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "seeing-stone-subtitles-"));
  roots.push(root);
  const local = { storageRoot: root, localPath: join(root, "download", "media.mkv"), serverId: "server", userId: "user", itemId: "episode", mediaSourceId: "source", localVersionId: "local" };
  await mkdir(dirname(local.localPath));
  await writeFile(local.localPath, "video");
  const api = {
    getMediaSourceCapabilities: vi.fn(async () => ({ itemId: "episode", sources: [{ id: "source", container: "mkv", size: 5, supportsDirectPlay: true, supportsDirectStream: true, supportsTranscoding: true, externalSubtitles: tracks }] })),
    fetchExternalSubtitle: vi.fn(async () => new Response(text)),
  };
  return { root, local, api };
}

describe("downloaded subtitle files", () => {
  it("persists every supported sidecar with language/default/forced metadata and reuses it without a network request", async () => {
    const { local, api } = await fixture();
    await cacheDownloadSubtitles(api, local, new AbortController().signal);
    const saved = await getLocalSubtitles(local);
    expect(saved.map(({ file, ...track }) => track)).toEqual(tracks);
    for (const track of saved) expect(await (await readLocalSubtitle(track)).text()).toBe(text);
    expect(api.fetchExternalSubtitle).toHaveBeenCalledTimes(4);
    await cacheDownloadSubtitles(api, local, new AbortController().signal);
    expect(api.fetchExternalSubtitle).toHaveBeenCalledTimes(4);
    expect(await readFile(local.localPath, "utf8")).toBe("video");
  });

  it("rejects another user's, server's, item's, local version's, or media source's manifest", async () => {
    const { local, api } = await fixture();
    await cacheDownloadSubtitles(api, local, new AbortController().signal);
    for (const key of ["userId", "serverId", "itemId", "mediaSourceId", "localVersionId"] as const) {
      expect(await getLocalSubtitles({ ...local, [key]: "different" })).toEqual([]);
    }
  });

  it("ignores damaged files and downloads only the missing or damaged track on repair", async () => {
    const { local, api } = await fixture();
    await cacheDownloadSubtitles(api, local, new AbortController().signal);
    const files = await readdir(dirname(local.localPath));
    const target = files.find((name) => name.startsWith("subtitle-2-"))!;
    await writeFile(join(dirname(local.localPath), target), "corrupted");
    expect(await getLocalSubtitles(local)).toHaveLength(3);
    await cacheDownloadSubtitles(api, local, new AbortController().signal);
    expect(api.fetchExternalSubtitle).toHaveBeenCalledTimes(5);
    expect(await getLocalSubtitles(local)).toHaveLength(4);
  });

  it("keeps successful subtitles after one request fails and retries the failed track", async () => {
    const { local, api } = await fixture();
    api.fetchExternalSubtitle.mockRejectedValueOnce(new Error("offline"));
    await expect(cacheDownloadSubtitles(api, local, new AbortController().signal)).rejects.toThrow("SUBTITLE_DOWNLOAD_INCOMPLETE");
    expect(await getLocalSubtitles(local)).toHaveLength(3);
    await cacheDownloadSubtitles(api, local, new AbortController().signal);
    expect(api.fetchExternalSubtitle).toHaveBeenCalledTimes(5);
    expect(await getLocalSubtitles(local)).toHaveLength(4);
  });

  it("cancels a stalled subtitle body without publishing a partial file", async () => {
    const { local, api } = await fixture();
    const controller = new AbortController();
    const cancelled = vi.fn();
    api.fetchExternalSubtitle.mockImplementationOnce(async () => {
      setTimeout(() => controller.abort(), 10);
      return new Response(new ReadableStream({ cancel: cancelled }));
    });
    await expect(cacheDownloadSubtitles(api, local, controller.signal)).rejects.toThrow();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(await readdir(dirname(local.localPath))).toEqual(["media.mkv"]);
  });

  it("bounds response bytes while allowing the other subtitle tracks to finish", async () => {
    const { local, api } = await fixture();
    api.fetchExternalSubtitle.mockResolvedValueOnce(new Response(new Uint8Array(16 * 1024 * 1024 + 1)));
    await expect(cacheDownloadSubtitles(api, local, new AbortController().signal)).rejects.toThrow("SUBTITLE_DOWNLOAD_INCOMPLETE");
    expect(await getLocalSubtitles(local)).toHaveLength(3);
  });

  it("rejects a download directory junction escaping the authorized storage root", async () => {
    const { local, api, root } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "seeing-stone-subtitles-outside-"));
    roots.push(outside);
    const linked = join(root, "linked");
    await symlink(outside, linked, "junction");
    const escaped = { ...local, localPath: join(linked, "media.mkv") };
    await expect(cacheDownloadSubtitles(api, escaped, new AbortController().signal)).rejects.toThrow("SUBTITLE_PATH_INVALID");
    expect(api.getMediaSourceCapabilities).not.toHaveBeenCalled();
    expect(await readdir(outside)).toEqual([]);
  });

  it.each(["offline", "connected"])("serves the saved subtitle through playback while %s, without fetching its remote body", async (connection) => {
    const { local, api } = await fixture();
    await cacheDownloadSubtitles(api, local, new AbortController().signal);
    const saved = await getLocalSubtitles(local);
    const fetchRemote = vi.fn(async () => new Response("remote"));
    const playbackApi = {
      ...api, fetchExternalSubtitle: fetchRemote, getDetails: vi.fn(), fetchStaticStream: vi.fn(), fetchTranscodedStream: vi.fn(),
      getConnectionDiagnostics: () => ({ state: connection }),
    };
    const resolver = { resolve: vi.fn(async () => ({
      playbackId: "playback", itemId: local.itemId, mediaSourceId: local.mediaSourceId, source: "local", mediaUrl: local.localPath,
      localVersionId: local.localVersionId, externalSubtitles: saved.map(({ file, ...track }) => track), localSubtitles: saved,
      durationTicks: 100, resumePositionTicks: 0, initialAction: "progress", delivery: "local",
    })) };
    const service = new PlaybackSessionService(playbackApi as never, resolver as never);
    const started = await service.start(local.itemId, "resume");
    expect(started.externalSubtitles).toHaveLength(4);
    expect(JSON.stringify(started.externalSubtitles)).not.toContain("storageRoot");
    expect(await (await service.fetchExternalSubtitle(started.playbackId, tracks[0])).text()).toBe(text);
    expect(fetchRemote).not.toHaveBeenCalled();
    expect((await service.fetchExternalSubtitle("stale", tracks[0])).status).toBe(404);
    const target = (await readdir(dirname(local.localPath))).find((name) => name.startsWith("subtitle-2-"))!;
    await rm(join(dirname(local.localPath), target));
    const fallback = await service.fetchExternalSubtitle(started.playbackId, tracks[0]);
    if (connection === "offline") {
      expect(fallback.status).toBe(404);
      expect(fetchRemote).not.toHaveBeenCalled();
    } else {
      expect(await fallback.text()).toBe("remote");
      expect(fetchRemote).toHaveBeenCalledOnce();
    }
  });
});
