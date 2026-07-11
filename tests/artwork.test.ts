import { describe, expect, it, vi } from "vitest";
import { ArtworkService } from "../src/main/services/artwork";

describe("ArtworkService", () => {
  it("uses opaque references and rejects unknown or malformed requests before networking", async () => {
    const fetchArtwork = vi.fn(async () => new Response("image-bytes", { headers: { "Content-Type": "image/jpeg" } }));
    const service = new ArtworkService({ fetchArtwork });
    const safeUrl = service.getUrl({ itemId: "movie-1", kind: "Primary", tag: "tag", width: 500 });
    expect(safeUrl).not.toContain("movie-1");
    expect(safeUrl).not.toContain("tag");

    const response = await service.handle(new Request(safeUrl));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(fetchArtwork).toHaveBeenCalledWith(
      "movie-1",
      "Primary",
      { quality: "90", tag: "tag", maxWidth: "500" },
      expect.any(AbortSignal),
    );

    const calls = fetchArtwork.mock.calls.length;
    service.clear();
    expect((await service.handle(new Request(safeUrl))).status).toBe(404);
    expect((await service.handle(new Request("jellyfin-artwork://asset/not-a-reference"))).status).toBe(404);
    expect((await service.handle(new Request(`${safeUrl}?url=https://evil.example`))).status).toBe(400);
    expect(fetchArtwork).toHaveBeenCalledTimes(calls);
  });

  it("does not release artwork that finishes after the session is cleared", async () => {
    let release: ((response: Response) => void) | undefined;
    let signal: AbortSignal | undefined;
    const fetchArtwork = vi.fn((_itemId: string, _kind: string, _options: Record<string, string>, requestSignal?: AbortSignal) => {
      signal = requestSignal;
      return new Promise<Response>((resolve) => { release = resolve; });
    });
    const service = new ArtworkService({ fetchArtwork });
    const safeUrl = service.getUrl({ itemId: "movie-1", kind: "Primary" });
    const pending = service.handle(new Request(safeUrl));
    await vi.waitFor(() => expect(fetchArtwork).toHaveBeenCalledOnce());
    expect(signal?.aborted).toBe(false);
    service.clear();
    expect(signal?.aborted).toBe(true);
    release?.(new Response("image-bytes", { headers: { "Content-Type": "image/jpeg" } }));
    expect((await pending).status).toBe(404);
  });

  it("revokes an already-returned artwork body before any later bytes are released", async () => {
    let signal: AbortSignal | undefined;
    let bodyCancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("old-account-image"));
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    const service = new ArtworkService({
      async fetchArtwork(_itemId, _kind, _options, requestSignal) {
        signal = requestSignal;
        return new Response(upstream, { headers: { "Content-Type": "image/jpeg" } });
      },
    });
    const safeUrl = service.getUrl({ itemId: "movie-1", kind: "Primary" });
    const response = await service.handle(new Request(safeUrl));
    expect(response.status).toBe(200);
    expect(signal?.aborted).toBe(false);

    service.clear();

    expect(signal?.aborted).toBe(true);
    expect(bodyCancelled).toBe(true);
    await expect(response.text()).rejects.toMatchObject({ name: "AbortError" });
  });
});
