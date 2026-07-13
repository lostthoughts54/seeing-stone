import { describe, expect, it, vi } from "vitest";
import { registerIpcHandlers } from "../src/main/ipc";
import { IPC } from "../src/shared/contracts";

type RegisteredHandler = (event: unknown, input?: unknown) => Promise<unknown>;

function createHarness() {
  const handlers = new Map<string, RegisteredHandler>();
  const frame = { url: "app://bundle/index.html" };
  const webContents = {
    mainFrame: frame,
    isDestroyed: () => false,
  };
  const window = {
    webContents,
    isDestroyed: () => false,
  };
  const ipcMain = {
    handle(channel: string, handler: RegisteredHandler) { handlers.set(channel, handler); },
  };
  const login = vi.fn(async () => ({ authenticated: true, persistence: "memory-only", server: null, user: null }));
  const getSafeSession = vi.fn(() => ({ authenticated: false, persistence: "none", server: null, user: null }));
  const api = {
    connect: vi.fn(),
    login,
    restore: vi.fn(),
    getSafeSession,
    logout: vi.fn(),
    getHome: vi.fn(),
    getLibraries: vi.fn(),
    getLibraryItems: vi.fn(),
    search: vi.fn(),
    getDetails: vi.fn(),
    openTrailer: vi.fn(),
    getSeasons: vi.fn(),
    getEpisodes: vi.fn(),
    getMediaSourceCapabilities: vi.fn(),
  };
  const artwork = { clear: vi.fn(), getUrl: vi.fn() };
  const playback = {
    clear: vi.fn(), start: vi.fn(), setPaused: vi.fn(), seek: vi.fn(), selectAudio: vi.fn(),
    selectSubtitle: vi.fn(), setFullscreen: vi.fn(), stop: vi.fn(), getState: vi.fn(),
  };
  const downloads = {
    activate: vi.fn(), deactivate: vi.fn(), list: vi.fn(), start: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    retry: vi.fn(), cancel: vi.fn(), delete: vi.fn(), setKeep: vi.fn(),
  };
  const synchronization = {
    activate: vi.fn(),
    deactivate: vi.fn(),
    setWatched: vi.fn(async (itemId: string, watched: boolean) => ({ itemId, watched, synchronization: "synchronized" })),
  };
  registerIpcHandlers(
    ipcMain as never,
    window as never,
    api as never,
    artwork as never,
    playback as never,
    downloads as never,
    synchronization as never,
  );
  const validEvent = { sender: webContents, senderFrame: frame };
  return { handlers, frame, webContents, window, api, artwork, playback, downloads, synchronization, login, getSafeSession, validEvent };
}

describe("IPC authorization and allowlist", () => {
  it("registers exactly the declared narrow channels and no reporting transport", () => {
    const { handlers } = createHarness();
    const invokeChannels = Object.values(IPC).filter((channel) => ![
      IPC.playbackStateChanged,
      IPC.downloadsChanged,
      IPC.watchPartiesChanged,
    ].includes(channel));
    expect([...handlers.keys()].sort()).toEqual(invokeChannels.sort());
    expect([...handlers.keys()].join(" ")).not.toMatch(/report|sessions\/playing|request|fetch|filesystem|shell|command/i);
  });

  it("allows the production main frame and rejects extra privileged fields before service invocation", async () => {
    const { handlers, validEvent, login, getSafeSession } = createHarness();
    await expect(handlers.get(IPC.sessionGetState)?.(validEvent)).resolves.toEqual({
      ok: true,
      data: { authenticated: false, persistence: "none", server: null, user: null },
    });
    expect(getSafeSession).toHaveBeenCalledOnce();

    const result = await handlers.get(IPC.sessionLogin)?.(validEvent, {
      connectionId: "11111111-1111-4111-8111-111111111111",
      username: "Viewer",
      password: "password",
      remember: true,
      serverUrl: "http://127.0.0.1:8096",
      headers: { Authorization: "SECRET_TOKEN_SENTINEL" },
      command: "mpv.exe",
      args: ["--script=unsafe"],
      path: "D:\\Sensitive Folder\\movie.mkv",
    }) as { ok: boolean; error?: { message: string } };
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN_SENTINEL");
    expect(JSON.stringify(result)).not.toContain("Sensitive Folder");
    expect(login).not.toHaveBeenCalled();
  });

  it("rejects foreign windows, subframes, wrong origins, and destroyed windows", async () => {
    const { handlers, frame, webContents, window, getSafeSession } = createHarness();
    const invoke = handlers.get(IPC.sessionGetState)!;
    const foreign = await invoke({ sender: { mainFrame: frame }, senderFrame: frame });
    const subframe = await invoke({ sender: webContents, senderFrame: { url: "app://bundle/frame.html" } });
    frame.url = "https://attacker.invalid/";
    const wrongOrigin = await invoke({ sender: webContents, senderFrame: frame });
    frame.url = "app://bundle/index.html";
    window.isDestroyed = () => true;
    const destroyed = await invoke({ sender: webContents, senderFrame: frame });
    for (const result of [foreign, subframe, wrongOrigin, destroyed]) {
      expect(result).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED_IPC", retryable: false } });
    }
    expect(getSafeSession).not.toHaveBeenCalled();
  });

  it("rejects renderer-supplied download URLs, paths, source IDs, and transfer arguments", async () => {
    const { handlers, validEvent, downloads } = createHarness();
    const result = await handlers.get(IPC.downloadsStart)?.(validEvent, {
      itemId: "episode-1",
      mediaSourceId: "server-source",
      url: "http://127.0.0.1:8096/Videos/episode-1/stream?api_key=SECRET_TOKEN_SENTINEL",
      path: "D:\\Sensitive Folder\\episode.mkv",
      headers: { Authorization: "SECRET_TOKEN_SENTINEL" },
    }) as { ok: boolean; error?: { message: string } };
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN_SENTINEL");
    expect(JSON.stringify(result)).not.toContain("Sensitive Folder");
    expect(downloads.start).not.toHaveBeenCalled();
  });

  it("allows only a boolean explicit watched action without renderer-authored playback data", async () => {
    const { handlers, validEvent, synchronization } = createHarness();
    await expect(handlers.get(IPC.itemsSetWatched)?.(validEvent, {
      itemId: "episode-1",
      watched: true,
    })).resolves.toEqual({
      ok: true,
      data: { itemId: "episode-1", watched: true, synchronization: "synchronized" },
    });
    expect(synchronization.setWatched).toHaveBeenCalledWith("episode-1", true);

    const rejected = await handlers.get(IPC.itemsSetWatched)?.(validEvent, {
      itemId: "episode-1",
      watched: false,
      positionTicks: 999,
      playedPercentage: 50,
      url: "https://server.invalid/secret",
    }) as { ok: boolean };
    expect(rejected.ok).toBe(false);
    expect(synchronization.setWatched).toHaveBeenCalledTimes(1);
  });
});
