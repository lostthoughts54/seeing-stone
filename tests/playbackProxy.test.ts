import { describe, expect, it, vi } from "vitest";
import { PlaybackProxy } from "../src/main/services/playbackProxy";
import type { ResolvedPlaybackSource } from "../src/main/services/playbackSession";

const source: ResolvedPlaybackSource = {
  playbackId: "11111111-1111-4111-8111-111111111111",
  itemId: "private-item",
  mediaSourceId: "private-source",
  mediaUrl: "jellyfin-media://stream/11111111-1111-4111-8111-111111111111",
  resumePositionTicks: 0,
  durationTicks: 100000000,
  source: "server",
  delivery: "direct",
  initialAction: "progress",
};

describe("PlaybackProxy", () => {
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
    const url = await proxy.open(source);
    try {
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
});
