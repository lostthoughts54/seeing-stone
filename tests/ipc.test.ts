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
    clear: vi.fn(), start: vi.fn(), setPaused: vi.fn(), seek: vi.fn(), setRate: vi.fn(), setVolume: vi.fn(), selectAudio: vi.fn(),
    selectSubtitle: vi.fn(), setFullscreen: vi.fn(), stop: vi.fn(), getState: vi.fn(),
  };
  const downloads = {
    activate: vi.fn(), deactivate: vi.fn(), list: vi.fn(), listOfflinePlayable: vi.fn(), start: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    retry: vi.fn(), cancel: vi.fn(), delete: vi.fn(), setKeep: vi.fn(),
  };
  const synchronization = {
    activate: vi.fn(),
    deactivate: vi.fn(),
    setWatched: vi.fn(async (itemId: string, watched: boolean) => ({ itemId, watched, synchronization: "synchronized" })),
  };
  const downloadLocation = {
    getSummary: vi.fn(async () => ({ mode: "default" as const, label: "Windows Videos folder" })),
    choose: vi.fn(async () => ({ mode: "custom" as const, label: "Custom folder on D:" })),
    useDefault: vi.fn(async () => ({ mode: "default" as const, label: "Windows Videos folder" })),
    open: vi.fn(async () => ({ opened: true })),
  };
  const watchPartyState = {
    availability: "available" as const,
    connection: "connected" as const,
    groups: [],
    joinedGroup: null,
    sharedControls: true,
    sync: { serverLatencyMs: null, localDriftTicks: null, authoritativeTimelineReady: false, measuredAtUnixMs: null },
    telemetry: {
      protocolVersion: 1 as const,
      availability: "disabled" as const,
      transport: "none" as const,
      reason: "Enhanced status unavailable.",
      participants: [],
      incident: null,
      policy: { mode: "wait-for-all" as const, gracePeriodMs: 1500 as const },
    },
    error: null,
  };
  const syncPlay = {
    getState: vi.fn(() => structuredClone(watchPartyState)),
    list: vi.fn(async () => structuredClone(watchPartyState)),
    create: vi.fn(async () => structuredClone(watchPartyState)),
    join: vi.fn(async () => structuredClone(watchPartyState)),
    leave: vi.fn(async () => structuredClone(watchPartyState)),
    waitForAll: vi.fn(async () => structuredClone(watchPartyState)),
    continueAfterBuffering: vi.fn(async () => structuredClone(watchPartyState)),
    resyncGroup: vi.fn(async () => structuredClone(watchPartyState)),
    setBufferingPolicy: vi.fn(async () => structuredClone(watchPartyState)),
    setViewVisible: vi.fn(async () => structuredClone(watchPartyState)),
    isJoined: vi.fn(() => false),
  };
  registerIpcHandlers(
    ipcMain as never,
    window as never,
    api as never,
    artwork as never,
    playback as never,
    downloads as never,
    synchronization as never,
    syncPlay as never,
    downloadLocation,
  );
  const validEvent = { sender: webContents, senderFrame: frame };
  return { handlers, frame, webContents, window, api, artwork, playback, downloads, synchronization, downloadLocation, syncPlay, login, getSafeSession, validEvent };
}

describe("IPC authorization and allowlist", () => {
  it("registers exactly the declared narrow channels and no reporting transport", () => {
    const { handlers } = createHarness();
    const invokeChannels = Object.values(IPC).filter((channel) => ![
      IPC.playbackStateChanged,
      IPC.downloadsChanged,
      IPC.sessionPanelSoloChanged,
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

  it("keeps offline playable discovery identity-owned and rejects renderer filters", async () => {
    const { handlers, validEvent, downloads } = createHarness();
    downloads.listOfflinePlayable.mockResolvedValue([]);
    await expect(handlers.get(IPC.downloadsListOfflinePlayable)?.(validEvent)).resolves.toEqual({ ok: true, data: [] });
    const rejected = await handlers.get(IPC.downloadsListOfflinePlayable)?.(validEvent, {
      serverId: "other-server",
      userId: "other-user",
      localPath: "D:\\Sensitive\\media.mkv",
    }) as { ok: boolean; error?: { message: string } };
    expect(rejected.ok).toBe(false);
    expect(JSON.stringify(rejected)).not.toContain("Sensitive");
    expect(downloads.listOfflinePlayable).toHaveBeenCalledTimes(1);
  });

  it("changes download location only through the main-owned picker action", async () => {
    const { handlers, validEvent, downloadLocation } = createHarness();
    await expect(handlers.get(IPC.downloadsGetLocation)?.(validEvent)).resolves.toEqual({
      ok: true,
      data: { mode: "default", label: "Windows Videos folder" },
    });
    await expect(handlers.get(IPC.downloadsChooseLocation)?.(validEvent)).resolves.toEqual({
      ok: true,
      data: { mode: "custom", label: "Custom folder on D:" },
    });
    const rejected = await handlers.get(IPC.downloadsChooseLocation)?.(validEvent, {
      path: "D:\\Sensitive Folder",
      command: "explorer.exe",
    }) as { ok: boolean; error?: { message: string } };
    expect(rejected.ok).toBe(false);
    expect(JSON.stringify(rejected)).not.toContain("Sensitive Folder");
    expect(downloadLocation.choose).toHaveBeenCalledTimes(1);
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

  it("validates bounded rate and volume controls before invoking the adapter", async () => {
    const { handlers, validEvent, playback } = createHarness();
    const playbackId = "55555555-5555-4555-8555-555555555555";
    playback.setRate.mockResolvedValue({ playbackId });
    playback.setVolume.mockResolvedValue({ playbackId });

    await expect(handlers.get(IPC.playbackSetRate)?.(validEvent, { playbackId, rate: 1.5 })).resolves.toMatchObject({ ok: true });
    await expect(handlers.get(IPC.playbackSetVolume)?.(validEvent, { playbackId, volume: 42 })).resolves.toMatchObject({ ok: true });
    expect(playback.setRate).toHaveBeenCalledWith(playbackId, 1.5, { origin: "local-user" });
    expect(playback.setVolume).toHaveBeenCalledWith(playbackId, 42, { origin: "local-user" });

    await expect(handlers.get(IPC.playbackSetRate)?.(validEvent, { playbackId, rate: 4.01 })).resolves.toMatchObject({ ok: false });
    await expect(handlers.get(IPC.playbackSetVolume)?.(validEvent, { playbackId, volume: 101 })).resolves.toMatchObject({ ok: false });
    expect(playback.setRate).toHaveBeenCalledTimes(1);
    expect(playback.setVolume).toHaveBeenCalledTimes(1);
  });

  it("exposes only narrow Watchparty intents and rejects renderer-authored telemetry", async () => {
    const { handlers, validEvent, syncPlay } = createHarness();
    await expect(handlers.get(IPC.watchPartiesWait)?.(validEvent)).resolves.toMatchObject({ ok: true });
    await expect(handlers.get(IPC.watchPartiesContinue)?.(validEvent)).resolves.toMatchObject({ ok: true });
    await expect(handlers.get(IPC.watchPartiesResync)?.(validEvent)).resolves.toMatchObject({ ok: true });
    await expect(handlers.get(IPC.watchPartiesSetBufferingPolicy)?.(validEvent, { mode: "continue" })).resolves.toMatchObject({ ok: true });
    expect(syncPlay.waitForAll).toHaveBeenCalledOnce();
    expect(syncPlay.continueAfterBuffering).toHaveBeenCalledOnce();
    expect(syncPlay.resyncGroup).toHaveBeenCalledOnce();
    expect(syncPlay.setBufferingPolicy).toHaveBeenCalledWith("continue");

    const rejected = await handlers.get(IPC.watchPartiesWait)?.(validEvent, {
      participantId: "33333333333343338333333333333333",
      state: "buffering",
      mediaUrl: "https://invalid.example/media",
      token: "secret",
    }) as { ok: boolean };
    expect(rejected.ok).toBe(false);
    expect(syncPlay.waitForAll).toHaveBeenCalledTimes(1);
    await expect(handlers.get(IPC.watchPartiesSetBufferingPolicy)?.(validEvent, {
      mode: "wait-for-all",
      gracePeriodMs: 0,
    })).resolves.toMatchObject({ ok: false });
  });
});
