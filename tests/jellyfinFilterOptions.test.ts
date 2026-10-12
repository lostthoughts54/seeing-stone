import { afterEach, describe, expect, it, vi } from "vitest";
import { JellyfinApi } from "../src/main/services/jellyfinApi";
import type { SecureSessionStore } from "../src/main/services/secureSession";
import type { LibraryFilterOptionsInput } from "../src/shared/contracts";
import { libraryFilterOptionsSchema } from "../src/shared/schemas";

const input: LibraryFilterOptionsInput = { libraryId: "library-1", type: "Movie", kind: "people", startIndex: 0, limit: 2 };
const person = (id: string, name: string) => ({ Id: id, Name: name, Path: "D:\\private", AccessToken: "SECRET_SENTINEL" });
const movie = (id: number, people = [person("person-a", "Alice")]) => ({ Id: `movie-${id}`, People: people });

async function fixture(handle: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const requests: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(value));
    if (url.pathname === "/System/Info/Public") return Response.json({ Id: "server-1", ServerName: "Server", Version: "10.11.11" });
    if (url.pathname === "/Users/AuthenticateByName") {
      const userId = JSON.parse(String(init?.body)).Username;
      return Response.json({ AccessToken: "SECRET_SENTINEL", User: { Id: userId, Name: userId } });
    }
    requests.push(url);
    return handle(url, init);
  }));
  const store = { save: vi.fn(), clear: vi.fn(), getPersistence: () => "memory" } as unknown as SecureSessionStore;
  const api = new JellyfinApi({ deviceId: "device", deviceName: "Test", clientName: "Seeing Stone", clientVersion: "test" }, store, async () => undefined);
  const login = async (user = "user-1", address = "http://127.0.0.1:8096") => {
    const connection = await api.connect(address);
    await api.login(connection.connectionId, user, "password", false);
  };
  await login();
  return { api, requests, login };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("library-wide filter options", () => {
  it("validates bounded scope and pagination without accepting a user or arbitrary server parameters", () => {
    expect(libraryFilterOptionsSchema.parse({ ...input, query: "  Alice  " }).query).toBe("Alice");
    for (const change of [{ userId: "other" }, { libraryId: "" }, { kind: "actors" }, { type: "Episode" }, { startIndex: -1 }, { limit: 101 }, { query: "a".repeat(101) }]) {
      expect(() => libraryFilterOptionsSchema.parse({ ...input, ...change })).toThrow();
    }
  });

  it("pages library-scoped genre metadata, with an extra row instead of inaccurate item counts", async () => {
    const { api, requests } = await fixture((url) => {
      expect(url.pathname).toBe("/Genres");
      const offset = Number(url.searchParams.get("StartIndex"));
      return Response.json({ Items: ["Comedy", "Crime", "Documentary"].slice(offset, offset + 3).map((Name) => ({ Name, ChildCount: 999, Path: "D:\\private" })) });
    });
    expect(await api.getLibraryFilterOptions({ ...input, kind: "genres", query: "co" })).toEqual({
      items: [{ value: "Comedy", label: "Comedy" }, { value: "Crime", label: "Crime" }], hasMore: true, nextStartIndex: 2,
    });
    expect(await api.getLibraryFilterOptions({ ...input, kind: "genres", startIndex: 2 })).toEqual({
      items: [{ value: "Documentary", label: "Documentary" }], hasMore: false, nextStartIndex: null,
    });
    expect(Object.fromEntries(requests[0].searchParams)).toEqual({
      UserId: "user-1", ParentId: "library-1", IncludeItemTypes: "Movie", SearchTerm: "co",
      SortBy: "SortName", SortOrder: "Ascending", StartIndex: "0", Limit: "3", EnableImages: "false", EnableTotalRecordCount: "false",
    });
  });

  it("coalesces the first people index, searches beyond the first media page, and serves later pages from sanitized cache", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const { api, requests } = await fixture(async (url) => {
      if (url.searchParams.get("StartIndex") === "0") {
        await ready;
        return Response.json({ Items: Array.from({ length: 250 }, (_, index) => movie(index)) });
      }
      return Response.json({ Items: [movie(250, [person("person-b", "Bob"), person("person-z", "Zelda"), person("../unsafe", "Invalid"), person("person-empty", "")])] });
    });
    const first = api.getLibraryFilterOptions(input);
    const search = api.getLibraryFilterOptions({ ...input, query: "ZEL" });
    expect(requests).toHaveLength(1);
    release();
    const firstPage = await first;
    expect(firstPage).toEqual({ items: [{ value: "person-a", label: "Alice" }, { value: "person-b", label: "Bob" }], hasMore: true, nextStartIndex: 2 });
    expect(await search).toEqual({ items: [{ value: "person-z", label: "Zelda" }], hasMore: false, nextStartIndex: null });
    expect(await api.getLibraryFilterOptions({ ...input, startIndex: 2 })).toEqual({ items: [{ value: "person-z", label: "Zelda" }], hasMore: false, nextStartIndex: null });
    firstPage.items[0].label = "Mutated caller copy";
    expect((await api.getLibraryFilterOptions(input)).items[0].label).toBe("Alice");
    expect(JSON.stringify(firstPage)).not.toMatch(/SECRET_SENTINEL|private|ChildCount/);
    expect(requests).toHaveLength(2);
    for (const url of requests) {
      expect(url.pathname).toBe("/Users/user-1/Items");
      expect(url.searchParams.get("ParentId")).toBe("library-1");
      expect(url.searchParams.get("IncludeItemTypes")).toBe("Movie");
      expect(url.searchParams.get("Fields")).toBe("People");
      for (const field of ["EnableImages", "EnableUserData", "EnableTotalRecordCount"]) expect(url.searchParams.get(field)).toBe("false");
      expect(url.searchParams.has("SearchTerm")).toBe(false);
    }
  });

  it("separates people caches by library, type, server and user, and expires them after five minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { api, requests, login } = await fixture((url) => Response.json({ Items: [movie(1, [person("person", `${url.host}/${url.pathname}/${url.searchParams.get("ParentId")}/${url.searchParams.get("IncludeItemTypes")}`)])] }));
    await api.getLibraryFilterOptions(input);
    await api.getLibraryFilterOptions({ ...input, libraryId: "library-2" });
    await api.getLibraryFilterOptions({ ...input, type: "Series" });
    await api.getLibraryFilterOptions({ ...input, type: "Mixed" });
    expect(requests).toHaveLength(4);
    expect(requests[3].searchParams.get("IncludeItemTypes")).toBe("Movie,Series,Episode,Video");
    await api.getLibraryFilterOptions(input);
    expect(requests).toHaveLength(4);
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    await api.getLibraryFilterOptions(input);
    expect(requests).toHaveLength(5);
    await login("user-2");
    expect((await api.getLibraryFilterOptions(input)).items[0].label).toContain("/Users/user-2/Items");
    await login("user-2", "http://127.0.0.2:8096");
    expect((await api.getLibraryFilterOptions(input)).items[0].label).toContain("127.0.0.2");
    expect(requests).toHaveLength(7);
  });

  it("discards failed indexes and permits retry without marking the entire server offline", async () => {
    let fail = true;
    const { api, requests } = await fixture((url) => {
      if (!fail) return Response.json({ Items: [movie(0)] });
      if (url.searchParams.get("StartIndex") === "0") return Response.json({ Items: Array.from({ length: 250 }, (_, index) => movie(index)) });
      throw new Error("temporary transport failure");
    });
    await expect(api.getLibraryFilterOptions(input)).rejects.toMatchObject({ code: "BROWSE_REQUEST_FAILED" });
    expect(api.getConnectionDiagnostics().state).toBe("connected");
    fail = false;
    expect((await api.getLibraryFilterOptions(input)).items).toEqual([{ value: "person-a", label: "Alice" }]);
    expect(requests).toHaveLength(3);
    expect(requests[2].searchParams.get("StartIndex")).toBe("0");
  });

  it("rejects stale session results, aborts their network work, and preserves the new session cache", async () => {
    let release!: (response: Response) => void;
    let oldSignal: AbortSignal | undefined;
    const { api, requests, login } = await fixture((url, init) => {
      if (url.pathname === "/Users/user-1/Items") {
        oldSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => { release = resolve; });
      }
      return Response.json({ Items: [movie(1, [person("new-person", "New user only")])] });
    });
    const pending = expect(api.getLibraryFilterOptions(input)).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    await login("user-2");
    expect(oldSignal?.aborted).toBe(true);
    const current = await api.getLibraryFilterOptions(input);
    release(Response.json({ Items: Array.from({ length: 250 }, (_, index) => movie(index)) }));
    await pending;
    expect(await api.getLibraryFilterOptions(input)).toEqual(current);
    expect(current.items[0].value).toBe("new-person");
    expect(requests).toHaveLength(2);
  });

  it("rejects a server ignoring StartIndex instead of looping or caching incomplete choices", async () => {
    const { api, requests } = await fixture(() => Response.json({ Items: Array.from({ length: 250 }, (_, index) => movie(index)) }));
    await expect(api.getLibraryFilterOptions(input)).rejects.toMatchObject({ code: "FILTER_OPTIONS_INVALID" });
    expect(requests).toHaveLength(2);
  });

  it("fails visibly at the metadata bound instead of presenting a truncated people index", async () => {
    let small = false;
    const { api, requests } = await fixture((url) => {
      const offset = Number(url.searchParams.get("StartIndex"));
      const length = small ? 1 : Number(url.searchParams.get("Limit"));
      return Response.json({ Items: Array.from({ length }, (_, index) => movie(offset + index)) });
    });
    await expect(api.getLibraryFilterOptions(input)).rejects.toMatchObject({ code: "FILTER_OPTIONS_LIMIT" });
    expect(requests).toHaveLength(201);
    small = true;
    expect((await api.getLibraryFilterOptions(input)).items).toHaveLength(1);
    expect(requests).toHaveLength(202);
  });

  it("bounds concurrent library indexing without evicting and duplicating active requests", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const { api, requests } = await fixture(async () => { await ready; return Response.json({ Items: [movie(0)] }); });
    const pending = Array.from({ length: 4 }, (_, index) => api.getLibraryFilterOptions({ ...input, libraryId: `library-${index}` }));
    await expect(api.getLibraryFilterOptions({ ...input, libraryId: "library-5" })).rejects.toMatchObject({ code: "FILTER_OPTIONS_BUSY" });
    pending.push(api.getLibraryFilterOptions({ ...input, libraryId: "library-0" }));
    expect(requests).toHaveLength(4);
    release();
    await Promise.all(pending);
    await api.getLibraryFilterOptions({ ...input, libraryId: "library-5" });
    expect(requests).toHaveLength(5);
  });
});
