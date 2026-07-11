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
    expect(fetchArtwork).toHaveBeenCalledWith("movie-1", "Primary", { quality: "90", tag: "tag", maxWidth: "500" });

    const calls = fetchArtwork.mock.calls.length;
    expect((await service.handle(new Request("jellyfin-artwork://asset/not-a-reference"))).status).toBe(404);
    expect((await service.handle(new Request(`${safeUrl}?url=https://evil.example`))).status).toBe(400);
    expect(fetchArtwork).toHaveBeenCalledTimes(calls);
  });
});
