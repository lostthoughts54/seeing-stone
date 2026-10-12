import { describe, expect, it, vi } from "vitest";
import { IptvProviderClient } from "../src/main/services/iptvProviderClient";
import { IptvService } from "../src/main/services/iptvService";
import { iptvPosterSchema } from "../src/shared/iptv";

const setup = { kind: "xtream" as const, name: "Test", address: "https://provider.test", username: "viewer", password: "private-password" };
const identity = { providerId: "11111111-1111-4111-8111-111111111111", contentType: "movie" as const, itemId: "123" };
describe("IPTV posters", () => {
  it.each(["movie", "series"] as const)("returns only image bytes for %s, keeping token URLs main-owned", async contentType => {
    const requests: URL[] = [];
    const client = new IptvProviderClient(async input => {
      const url = new URL(String(input)); requests.push(url);
      if (url.pathname.endsWith("player_api.php")) return Response.json({ info: { cover: "https://images.test/private-password/poster.png" } });
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    });
    expect(await client.poster(setup, contentType, "123", new AbortController().signal)).toBe("data:image/png;base64,AQID");
    expect(requests[0].searchParams.get(contentType === "movie" ? "vod_id" : "series_id")).toBe("123");
  });
  it("rejects active content and overlarge images", async () => {
    for (const [mime, size] of [["image/svg+xml", 10], ["image/png", 2 * 1024 * 1024 + 1]] as const) {
      const client = new IptvProviderClient(async input => String(input).includes("player_api.php")
        ? Response.json({ info: { movie_image: "https://images.test/poster" } })
        : new Response(new Uint8Array(size), { headers: { "content-type": mime } }));
      expect(await client.poster(setup, "movie", "123", new AbortController().signal)).toBeNull();
    }
  });
  it("requires a catalogue item and caches repeated requests without exposing provider errors", async () => {
    const poster = vi.fn(async () => "data:image/png;base64,AQID");
    const persistence = { iptvCatalogue: vi.fn(async () => null as unknown) };
    const store = { readConfiguration: vi.fn(async () => setup) };
    const service = new IptvService(store as never, persistence, { poster } as never);
    expect(await service.poster(identity)).toBeNull(); expect(poster).not.toHaveBeenCalled();
    persistence.iptvCatalogue.mockResolvedValue({ name: "Film" });
    const known = { ...identity, itemId: "124" };
    await Promise.all([service.poster(known), service.poster(known)]);
    await service.poster(known); expect(poster).toHaveBeenCalledTimes(1);
    poster.mockRejectedValueOnce(new Error("https://provider.test/private-password"));
    expect(await service.poster({ ...identity, itemId: "125" })).toBeNull();
    await service.shutdown(); expect(await service.poster(known)).toBeNull();
  });
  it("rejects renderer-supplied addresses and live channel identities", () => {
    expect(iptvPosterSchema.safeParse({ ...identity, url: "https://other.test" }).success).toBe(false);
    expect(iptvPosterSchema.safeParse({ ...identity, contentType: "live" }).success).toBe(false);
  });
});
