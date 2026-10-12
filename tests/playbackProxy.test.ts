import { describe, expect, it, vi } from "vitest";
import { PlaybackProxy } from "../src/main/services/playbackProxy";
import type { ResolvedPlaybackSource } from "../src/main/services/playbackSession";
import { readFile, stat } from "node:fs/promises";

const source: ResolvedPlaybackSource = {
  playbackId: "11111111-1111-4111-8111-111111111111",
  itemId: "private-item",
  mediaSourceId: "private-source",
  mediaUrl: "jellyfin-media://stream/11111111-1111-4111-8111-111111111111",
  resumePositionTicks: 0,
  durationTicks: 100000000,
  source: "server",
  delivery: "direct",
  externalSubtitles: [],
  initialAction: "progress",
};

describe("PlaybackProxy", () => {
  it("loads native subtitles before playback and removes the temporary files on close", async () => {
    const subtitle = { streamIndex: 4, format: "srt" as const, title: "English", language: "eng", isDefault: true, isForced: false };
    const fetchExternalSubtitle = vi.fn(async () => new Response("1\n00:00:00,000 --> 00:00:03,000\nHello\n"));
    const proxy = new PlaybackProxy({ fetchExternalSubtitle } as never);
    const targets = await proxy.open({ ...source, source: "local", mediaUrl: "D:\\movie.mp4", externalSubtitles: [subtitle] }, { materializeSubtitles: true });
    const file = targets.subtitles[0]!.url;
    try {
      expect(file).not.toMatch(/^https?:/);
      expect(await readFile(file, "utf8")).toContain("Hello");
      expect(targets.subtitles[0]).toMatchObject({ streamIndex: 4, isDefault: true, language: "eng" });
      expect(targets.media).toBe("D:\\movie.mp4");
      expect(fetchExternalSubtitle).toHaveBeenCalledOnce();
    } finally { await proxy.close(); }
    await expect(stat(file)).rejects.toThrow();
  });

  it("keeps video available when native subtitle fetching fails or exceeds the size limit", async () => {
    const subtitle = { streamIndex: 4, format: "srt" as const, title: null, language: null, isDefault: false, isForced: false };
    const fetchExternalSubtitle = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(new Uint8Array(16 * 1024 * 1024 + 1)));
    const proxy = new PlaybackProxy({ fetchExternalSubtitle } as never);
    try {
      const targets = await proxy.open({ ...source, source: "local", mediaUrl: "D:\\movie.mp4", externalSubtitles: [subtitle, { ...subtitle, streamIndex: 5 }] }, { materializeSubtitles: true });
      expect(targets.subtitles).toEqual([]);
      expect(targets.media).toBe("D:\\movie.mp4");
    } finally { await proxy.close(); }
  });

  it("cancels subtitle preparation when playback is closed", async () => {
    let fetching!: () => void;
    const started = new Promise<void>(resolve => { fetching = resolve; });
    const proxy = new PlaybackProxy({ fetchExternalSubtitle: async (_id: string, _track: unknown, signal: AbortSignal) => {
      fetching();
      return new Response(new ReadableStream({ start(controller) { signal.addEventListener("abort", () => controller.error(new Error("cancelled")), { once: true }); } }));
    } } as never);
    const opening = proxy.open({ ...source, externalSubtitles: [{ streamIndex: 4, format: "srt", title: null, language: null, isDefault: false, isForced: false }] }, { materializeSubtitles: true });
    const rejected = expect(opening).rejects.toThrow();
    await started;
    await proxy.close();
    await rejected;
  });

  it("provides one loopback-only capability and forwards range requests without identity", async () => {
    const handle = vi.fn(async (request: Request) => new Response(Uint8Array.from([1, 2, 3]), {
      status: 206,
      headers: {
        "Content-Type": "video/x-matroska",
        "Content-Length": "3",
        "Content-Range": "bytes 10-12/100",
        "Accept-Ranges": "bytes",
        "X-Observed-Range": request.headers.get("range") || "",
      },
    }));
    const proxy = new PlaybackProxy({ handle } as never);
    const targets = await proxy.open(source);
    const url = targets.media;
    try {
      expect(targets.subtitles).toEqual([]);
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]{36}$/);
      expect(url).not.toContain(source.itemId);
      expect(url).not.toContain(source.mediaSourceId);
      expect(url).not.toContain(source.playbackId);
      const response = await fetch(url, { headers: { Range: "bytes=10-12" } });
      expect(response.status).toBe(206);
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
      expect(handle).toHaveBeenCalledOnce();
      expect((handle.mock.calls[0]?.[0] as Request).url).toBe(source.mediaUrl);
      expect((handle.mock.calls[0]?.[0] as Request).headers.get("range")).toBe("bytes=10-12");
      const head = await fetch(url, { method: "HEAD" });
      expect(head.status).toBe(206);
      expect(head.headers.get("content-length")).toBe("3");
      expect(await head.text()).toBe("");
      expect((await fetch(`${new URL(url).origin}/wrong`)).status).toBe(404);
    } finally {
      await proxy.close();
    }
    await expect(fetch(url)).rejects.toThrow();
  });

  it("serves authenticated external subtitles through separate opaque capabilities for local video", async () => {
    const subtitle = { streamIndex: 4, format: "srt" as const, title: "English", language: "eng", isDefault: false, isForced: false };
    const localSource: ResolvedPlaybackSource = {
      ...source,
      source: "local",
      delivery: "local",
      mediaUrl: "D:\\Authorized Downloads\\movie\\media.mkv",
      externalSubtitles: [subtitle],
    };
    const fetchExternalSubtitle = vi.fn(async () => new Response("subtitle", {
      headers: { "Content-Type": "application/x-subrip", "Content-Length": "8" },
    }));
    const handle = vi.fn();
    const proxy = new PlaybackProxy({ handle, fetchExternalSubtitle } as never);
    const targets = await proxy.open(localSource);
    try {
      expect(targets.media).toBe(localSource.mediaUrl);
      expect(targets.subtitles).toHaveLength(1);
      expect(targets.subtitles[0]!.streamIndex).toBe(4);
      const subtitleUrl = targets.subtitles[0]!.url;
      expect(subtitleUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]{36}\.srt$/);
      expect(subtitleUrl).not.toContain(localSource.itemId);
      expect(subtitleUrl).not.toContain(localSource.mediaSourceId);
      expect(await (await fetch(subtitleUrl)).text()).toBe("subtitle");
      expect(fetchExternalSubtitle).toHaveBeenCalledWith(localSource.playbackId, subtitle, expect.any(AbortSignal));
      expect(handle).not.toHaveBeenCalled();
    } finally {
      await proxy.close();
    }
  });
});
