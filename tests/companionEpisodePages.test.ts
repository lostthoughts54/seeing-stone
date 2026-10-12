import { afterEach, describe, expect, it, vi } from "vitest";
import { JellyfinApi, sanitizeMediaItem } from "../src/main/services/jellyfinApi";
import { CompanionStateService } from "../src/main/services/companionState";
import type { SecureSessionStore } from "../src/main/services/secureSession";

const episode = (index: number, season = 1) => ({
  Id: `episode-${index}`, Name: `Episode ${index}`, Type: "Episode", SeriesName: "A Long Series",
  ParentIndexNumber: season, IndexNumber: index, RunTimeTicks: 10_000_000,
  ImageTags: { Primary: "image-tag" }, Path: "D:\\private\\episode.mkv", AccessToken: "SECRET_SENTINEL",
});

async function fixture(handle: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const requests: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(value));
    if (url.pathname === "/System/Info/Public") return Response.json({ Id: "server", ServerName: "Server", Version: "10.11.11" });
    if (url.pathname === "/Users/AuthenticateByName") return Response.json({ AccessToken: "SECRET_SENTINEL", User: { Id: "user-1", Name: "User" } });
    requests.push(url);
    return handle(url, init);
  }));
  const store = { save: vi.fn(), clear: vi.fn(), getPersistence: () => "memory" } as unknown as SecureSessionStore;
  const api = new JellyfinApi({ deviceId: "device", deviceName: "Test", clientName: "Seeing Stone", clientVersion: "test" }, store, async () => undefined);
  const login = async () => {
    const connection = await api.connect("http://127.0.0.1:8096");
    await api.login(connection.connectionId, "user", "password", false);
  };
  await login();
  return { api, requests, login };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Companion episode pages", () => {
  it("requests one lightweight server page while retaining special and season labels and server ordering", async () => {
    const ordered = [episode(3, 0), episode(1), episode(2), episode(3)];
    const { api, requests } = await fixture((url) => {
      expect(url.pathname).toBe("/Shows/series%2Fid/Episodes");
      const start = Number(url.searchParams.get("StartIndex"));
      return Response.json({ Items: ordered.slice(start, start + 3) });
    });
    const first = await api.getCompanionEpisodesPage("series/id", 0, 2);
    expect(first.items.map(item => [item.parentIndexNumber, item.indexNumber])).toEqual([[0, 3], [1, 1]]);
    expect(first.nextOffset).toBe(2);
    const second = await api.getCompanionEpisodesPage("series/id", 2, 2);
    expect(second.items.map(item => item.indexNumber)).toEqual([2, 3]);
    expect(second.nextOffset).toBeNull();
    expect(requests).toHaveLength(2);
    expect(Object.fromEntries(requests[0].searchParams)).toEqual({
      UserId: "user-1", StartIndex: "0", Limit: "3", Fields: "PrimaryImageAspectRatio",
      EnableUserData: "false", EnableImageTypes: "Primary", ImageTypeLimit: "1",
    });
    expect(JSON.stringify(first)).not.toMatch(/SECRET_SENTINEL|private|AccessToken/);
  });

  it("rejects invalid or unbounded pages and retains strict smart-download enumeration limits", async () => {
    const { api, requests } = await fixture(() => Response.json({ Items: [] }));
    for (const [start, limit] of [[-1, 30], [0.5, 30], [0, 0], [0, 51], [0, Infinity]]) {
      await expect(api.getCompanionEpisodesPage("series", start, limit)).rejects.toMatchObject({ code: "INVALID_EPISODE_PAGE" });
    }
    await expect(api.getSeriesEpisodesPage("series", 0, 30)).rejects.toMatchObject({ code: "INVALID_EPISODE_PAGE" });
    expect(requests).toHaveLength(0);
  });

  it.each([{}, { Items: [episode(1), episode(2), episode(3)] }, { Items: [{ ...episode(1), Type: "Movie" }] }])(
    "rejects malformed episode responses without showing truncated or unrelated results: %j", async (response) => {
      const { api } = await fixture(() => Response.json(response));
      await expect(api.getCompanionEpisodesPage("series", 0, 1)).rejects.toMatchObject({ code: "EPISODE_PAGE_INVALID" });
    },
  );

  it("keeps a transient episode failure local and allows retry without declaring the whole server offline", async () => {
    let fails = false;
    const { api } = await fixture(() => {
      if (fails) throw new TypeError("fetch failed");
      return Response.json({ Items: [episode(1)] });
    });
    await api.getCompanionEpisodesPage("series", 0, 30);
    fails = true;
    await expect(api.getCompanionEpisodesPage("series", 0, 30)).rejects.toMatchObject({ code: "EPISODE_PAGE_UNAVAILABLE", status: 503 });
    expect(api.getConnectionDiagnostics().state).toBe("connected");
    fails = false;
    expect((await api.getCompanionEpisodesPage("series", 0, 30)).items).toHaveLength(1);
  });

  it("returns an actionable upstream timeout before the phone deadline", async () => {
    const deadline = new AbortController();
    const { api } = await fixture((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason));
    }));
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const request = api.getCompanionEpisodesPage("series", 0, 30);
    const result = expect(request).rejects.toMatchObject({ code: "EPISODE_PAGE_UNAVAILABLE", status: 503 });
    deadline.abort(new DOMException("Timed out", "TimeoutError"));
    await result;
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(api.getConnectionDiagnostics().state).not.toBe("offline");
  });

  it("does not return a late episode page from a replaced session", async () => {
    let release!: (response: Response) => void;
    const { api, login } = await fixture(() => new Promise(resolve => { release = resolve; }));
    const pending = expect(api.getCompanionEpisodesPage("series", 0, 30)).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    await login();
    release(Response.json({ Items: [episode(1)] }));
    await pending;
  });

  it("maps only the requested page to phone capabilities without fetching every season", async () => {
    const api = {
      search: vi.fn(async () => [sanitizeMediaItem({ Id: "private-series", Name: "Series", Type: "Series" })]),
      getSeasons: vi.fn(() => { throw new Error("Whole-series fan-out must not run"); }),
      getEpisodes: vi.fn(() => { throw new Error("Whole-season fetch must not run"); }),
      getCompanionEpisodesPage: vi.fn(async (_series: string, offset: number) => ({
        items: [sanitizeMediaItem(episode(offset + 1, offset ? 1 : 0))], nextOffset: offset ? null : 30,
      })),
    };
    const service = new CompanionStateService({ onState: vi.fn() } as never, { onChanged: vi.fn() } as never, {} as never, api as never, () => false);
    const series = (await service.searchPage("Series")).items[0];
    const first = await service.getSeriesPage(series.itemRef);
    const second = await service.getSeriesPage(series.itemRef, first.nextOffset!);
    expect(api.getCompanionEpisodesPage.mock.calls).toEqual([["private-series", 0, 30], ["private-series", 30, 30]]);
    expect(api.getSeasons).not.toHaveBeenCalled();
    expect(api.getEpisodes).not.toHaveBeenCalled();
    expect(first.items[0]).toMatchObject({ type: "episode", seasonNumber: 0, episodeNumber: 1 });
    expect(second.nextOffset).toBeNull();
    expect(JSON.stringify(first)).not.toMatch(/private-series|episode-1|SECRET_SENTINEL|private/);
    expect(service.resolveItemRef(first.items[0].itemRef)).toBe("episode-1");
    expect(Object.isFrozen(first.items)).toBe(true);
  });
});
