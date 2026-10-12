import { describe, expect, it, vi } from "vitest";
import { IptvStream } from "../src/main/services/iptvStream";
import { PlaybackProxy } from "../src/main/services/playbackProxy";
import { PlaybackSessionService } from "../src/main/services/playbackSession";
import { PlaybackReportingService } from "../src/main/services/playbackReporting";
import { IptvProviderClient } from "../src/main/services/iptvProviderClient";

const identity = { providerId: "11111111-1111-4111-8111-111111111111", contentType: "live" as const, itemId: "123" };
describe("IPTV live ownership and protected transport", () => {
  it("cancels a late resolution when playback is cleared", async () => {
    let finish!: (stream: IptvStream) => void;
    let signal!: AbortSignal;
    const pending = new Promise<IptvStream>(resolve => { finish = resolve; });
    const session = new PlaybackSessionService({} as never, undefined, undefined, undefined, undefined, {
      resolveLive: async (_identity, requestSignal) => { signal = requestSignal; return pending; },
    });
    const started = session.start("iptv:opaque", "start-over", { iptvIdentity: identity });
    await vi.waitFor(() => expect(signal).toBeDefined());
    session.clear(); expect(signal.aborted).toBe(true);
    const stream = new IptvStream("https://provider.test/private.ts"); finish(stream);
    await expect(started).rejects.toMatchObject({ code: "PLAYBACK_CANCELLED" });
    expect(stream.has("root")).toBe(false);
  });
  it("bypasses Jellyfin resolution/reporting and revokes the stream on stop", async () => {
    const api = { getDetails: vi.fn(), getMediaSourceCapabilities: vi.fn(), reportAuthoritativePlayback: vi.fn() };
    const stream = new IptvStream("https://provider.test/private.ts");
    const local = { resolve: vi.fn() };
    const session = new PlaybackSessionService(api as never, local, undefined, undefined, undefined, { resolveLive: vi.fn(async () => stream) });
    const source = await session.start("iptv:opaque", "start-over", { iptvIdentity: identity });
    expect(source.iptvIdentity).toEqual(identity);
    expect(local.resolve).not.toHaveBeenCalled(); expect(api.getDetails).not.toHaveBeenCalled();
    expect((await session.handle(new Request(source.mediaUrl))).status).toBe(404);
    const capture = vi.fn();
    const reporting = new PlaybackReportingService(api as never, { capture, setActive: vi.fn(), flushCapture: vi.fn() }, { warn: vi.fn() } as never);
    await reporting.acceptAuthoritativeEvent({ kind: "start", itemId: source.itemId, mediaSourceId: source.mediaSourceId, playMethod: "DirectPlay", playSessionId: source.playbackId, positionTicks: 0, paused: false, canSeek: false, audioStreamIndex: null, subtitleStreamIndex: null, actionKind: "progress", watched: false, iptvIdentity: identity, contentKind: "live-tv" });
    expect(capture).not.toHaveBeenCalled(); expect(api.reportAuthoritativePlayback).not.toHaveBeenCalled();
    session.stop(source.playbackId); expect(stream.has("root")).toBe(false);
  });
  it("rewrites nested HLS, keys and maps into opaque loopback capabilities", async () => {
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("master.m3u8")) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nvariant.m3u8?password=private\n', { headers: { "Content-Type": "application/vnd.apple.mpegurl" } });
      if (path.endsWith("variant.m3u8")) return new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key?password=private"\n#EXT-X-MAP:URI="init?password=private"\n#EXTINF:5,\nsegment.ts?password=private\n');
      return new Response(new Uint8Array([1, 2, 3]));
    });
    const stream = new IptvStream("https://provider.test/master.m3u8", fetcher as typeof fetch);
    const handle = vi.fn(); const proxy = new PlaybackProxy({ handle } as never);
    const target = await proxy.open({ source: "server", externalSubtitles: [], iptvStream: stream } as never);
    try {
      const master = await (await fetch(target.media)).text(); expect(master).not.toMatch(/private|provider\.test|password/);
      const variant = await (await fetch(new URL(master.trim().split("\n").at(-1)!, target.media))).text();
      expect(variant).not.toMatch(/private|provider\.test|password/);
      const paths = [...variant.matchAll(/URI="([^"]+)"/g)].map(m => m[1]); paths.push(variant.trim().split("\n").at(-1)!);
      for (const path of paths) expect(new Uint8Array(await (await fetch(new URL(path, target.media))).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
      expect(handle).not.toHaveBeenCalled();
    } finally { stream.close(); await proxy.close(); }
  });
  it("rejects unsupported HLS resources without leaking upstream errors", async () => {
    const stream = new IptvStream("https://provider.test/private.m3u8", vi.fn(async () => new Response('#EXTM3U\nfile:///private\n')) as typeof fetch);
    await expect(stream.fetch("root", new AbortController().signal)).rejects.toMatchObject({ code: "IPTV_STREAM_UNAVAILABLE" });
  });
  it("decodes multilingual EPG with UTC epochs and strips private provider data", async () => {
    const now = Math.floor(Date.now() / 1000);
    const client = new IptvProviderClient(vi.fn(async () => new Response(JSON.stringify({ epg_listings: [{ title: Buffer.from("日本語 private-pass").toString("base64"), description: Buffer.from("News").toString("base64"), start_timestamp: now, stop_timestamp: now + 3600 }, { title: "bad", start_timestamp: now, stop_timestamp: now - 1 }] }))) as typeof fetch);
    const result = await client.schedule({ kind: "xtream", name: "Test", address: "https://provider.test", username: "viewer", password: "private-pass" }, "123", new AbortController().signal);
    expect(result.programmes).toHaveLength(1); expect(result.programmes[0].title).toBe("日本語 [private]");
    expect(Date.parse(result.programmes[0].startUtc)).toBe(now * 1000);
  });
});
