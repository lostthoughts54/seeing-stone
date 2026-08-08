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
    close: vi.fn(),
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
    getTrailerUrl: vi.fn(async () => "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    getSeasons: vi.fn(),
    getEpisodes: vi.fn(),
    getMediaSourceCapabilities: vi.fn(),
    getLiveTvStatus: vi.fn(),
    getLiveTvGuide: vi.fn(),
    getLiveTvRecordings: vi.fn(),
    getLiveTvTimers: vi.fn(),
    getLiveTvSeriesTimers: vi.fn(),
    createLiveTvRecording: vi.fn(),
    updateLiveTvSchedule: vi.fn(),
    cancelLiveTvSchedule: vi.fn(),
    deleteLiveTvRecording: vi.fn(),
  };
  const artwork = { clear: vi.fn(), getUrl: vi.fn() };
  const playback = {
    clear: vi.fn(), start: vi.fn(), loadItem: vi.fn(), setPaused: vi.fn(), seek: vi.fn(), setRate: vi.fn(), setVolume: vi.fn(), selectAudio: vi.fn(),
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
    preparation: { phase: "idle" as const, minimumParticipants: 2 as const, localSyncOffsetMilliseconds: 0, scheduledStartAtUnixMs: null },
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
    activate: vi.fn(),
    deactivate: vi.fn(),
    getState: vi.fn(() => structuredClone(watchPartyState)),
    list: vi.fn(async () => structuredClone(watchPartyState)),
    create: vi.fn(async () => structuredClone(watchPartyState)),
    join: vi.fn(async () => structuredClone(watchPartyState)),
    leave: vi.fn(async () => structuredClone(watchPartyState)),
    waitForAll: vi.fn(async () => structuredClone(watchPartyState)),
    continueAfterBuffering: vi.fn(async () => structuredClone(watchPartyState)),
    resyncGroup: vi.fn(async () => structuredClone(watchPartyState)),
    setBufferingPolicy: vi.fn(async () => structuredClone(watchPartyState)),
    setLocalSyncOffset: vi.fn(async () => structuredClone(watchPartyState)),
    setViewVisible: vi.fn(async () => structuredClone(watchPartyState)),
    isJoined: vi.fn(() => false),
  };
  const cleanMachineDiagnostics = {
    getSnapshot: vi.fn(async () => ({
      schemaVersion: 1,
      generatedAtUtc: "2026-07-28T04:00:00.000Z",
      overall: "ready",
      applicationVersion: "0.4.3",
      build: "internal-libmpv-test",
      platform: "windows",
      architecture: "x64",
      electronVersion: "43.1.0",
      selectedEngine: "libmpv",
      activeEngine: "libmpv",
      fallbackReason: null,
      checks: [],
    })),
    copyReport: vi.fn(async () => ({ completed: true })),
    saveReport: vi.fn(async () => ({ completed: false })),
  };
  const trailerWindow = {
    open: vi.fn(async (_url: string, openExternally?: boolean) => openExternally
      ? { mode: "external" as const, embedUrl: null }
      : { mode: "embedded" as const, embedUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ" }),
  };
  const smartState = { series: [], notice: null };
  const smartDownloads = {
    activate: vi.fn(),
    deactivate: vi.fn(),
    getState: vi.fn(async () => smartState),
    follow: vi.fn(async () => smartState),
    setLimit: vi.fn(async () => smartState),
    checkNow: vi.fn(async () => smartState),
    unfollow: vi.fn(async () => ({ state: smartState, warning: null })),
    skip: vi.fn(async () => smartState),
    notifyWatchedItem: vi.fn(),
  };
  const playbackMetadata = { clear: vi.fn(), getMediaSegments: vi.fn() };
  const trickplay = { clear: vi.fn(), getManifest: vi.fn(), getSpriteUrl: vi.fn() };
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
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    cleanMachineDiagnostics as never,
    undefined,
    undefined,
    trailerWindow,
    smartDownloads as never,
    playbackMetadata as never,
    trickplay as never,
  );
  const validEvent = { sender: webContents, senderFrame: frame };
  return { handlers, frame, webContents, window, api, artwork, playback, downloads, synchronization, downloadLocation, syncPlay, cleanMachineDiagnostics, trailerWindow, smartDownloads, playbackMetadata, trickplay, login, getSafeSession, validEvent };
}

describe("IPC authorization and allowlist", () => {
  it("revokes prior-session capabilities before awaiting session restore", async () => {
    const { handlers, validEvent, api, artwork, playbackMetadata, trickplay, playback } = createHarness();
    let resolveRestore!: (session: unknown) => void;
    api.restore.mockReturnValueOnce(new Promise((resolve) => { resolveRestore = resolve; }));

    const pending = handlers.get(IPC.sessionRestore)?.(validEvent);
    await vi.waitFor(() => expect(api.restore).toHaveBeenCalledOnce());
    expect(artwork.clear).toHaveBeenCalledOnce();
    expect(playbackMetadata.clear).toHaveBeenCalledOnce();
    expect(trickplay.clear).toHaveBeenCalledOnce();
    expect(playback.clear).toHaveBeenCalledOnce();

    resolveRestore({ authenticated: false, persistence: "none", server: null, user: null });
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it("closes the application window only through the authorized main frame", async () => {
    const { handlers, frame, validEvent, window } = createHarness();
    await expect(handlers.get(IPC.applicationClose)?.(validEvent)).resolves.toEqual({
      ok: true,
      data: undefined,
    });
    expect(window.close).toHaveBeenCalledOnce();

    await expect(handlers.get(IPC.applicationClose)?.({
      sender: { mainFrame: frame },
      senderFrame: frame,
    })).resolves.toMatchObject({ ok: false });
    expect(window.close).toHaveBeenCalledOnce();
  });

  it("exposes only controlled clean-machine report actions", async () => {
    const { handlers, validEvent, cleanMachineDiagnostics } = createHarness();
    await expect(handlers.get(IPC.diagnosticsGetCleanMachine)?.(validEvent)).resolves.toMatchObject({
      ok: true,
      data: { overall: "ready", activeEngine: "libmpv" },
    });
    await expect(handlers.get(IPC.diagnosticsCopyCleanMachine)?.(validEvent)).resolves.toEqual({
      ok: true,
      data: { completed: true },
    });
    await expect(handlers.get(IPC.diagnosticsSaveCleanMachine)?.(validEvent, {
      path: "C:\\Sensitive\\report.txt",
      contents: "secret",
    })).resolves.toMatchObject({ ok: false });
    expect(cleanMachineDiagnostics.saveReport).not.toHaveBeenCalled();
  });

  it("registers exactly the declared narrow channels and no reporting transport", () => {
    const { handlers } = createHarness();
    const invokeChannels = Object.values(IPC).filter((channel) => ![
      IPC.playbackStateChanged,
      IPC.downloadsChanged,
      IPC.smartDownloadsChanged,
      IPC.sessionPanelSoloChanged,
      IPC.watchPartiesChanged,
      IPC.companionChanged,
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

  it("allows only sanitized Smart Download intents", async () => {
    const { handlers, validEvent, smartDownloads } = createHarness();
    await expect(handlers.get(IPC.smartDownloadsFollow)?.(validEvent, {
      seriesId: "series-1",
      episodeLimit: 3,
    })).resolves.toEqual({ ok: true, data: { series: [], notice: null } });
    expect(smartDownloads.follow).toHaveBeenCalledWith("series-1", 3);

    await expect(handlers.get(IPC.smartDownloadsFollow)?.(validEvent, {
      seriesId: "series-1",
      episodeLimit: 3,
      serverId: "private-server",
      path: "D:\\private\\episode.mkv",
    })).resolves.toMatchObject({ ok: false });
    expect(smartDownloads.follow).toHaveBeenCalledTimes(1);

    await expect(handlers.get(IPC.smartDownloadsUnfollow)?.(validEvent, {
      seriesId: "series-1",
      disposition: "remove",
    })).resolves.toMatchObject({ ok: true });
    expect(smartDownloads.unfollow).toHaveBeenCalledWith("series-1", "remove");
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

  it("resolves trailers main-side and returns only a controlled embed URL", async () => {
    const { handlers, validEvent, api, trailerWindow } = createHarness();
    await expect(handlers.get(IPC.itemsOpenTrailer)?.(validEvent, { itemId: "movie-1" })).resolves.toEqual({
      ok: true,
      data: { opened: true, mode: "embedded", embedUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ" },
    });
    expect(api.getTrailerUrl).toHaveBeenCalledWith("movie-1");
    expect(trailerWindow.open).toHaveBeenCalledWith("https://www.youtube.com/watch?v=dQw4w9WgXcQ", undefined);

    await expect(handlers.get(IPC.itemsOpenTrailer)?.(validEvent, {
      itemId: "movie-1",
      openExternally: true,
    })).resolves.toEqual({
      ok: true,
      data: { opened: true, mode: "external", embedUrl: null },
    });

    const rejected = await handlers.get(IPC.itemsOpenTrailer)?.(validEvent, {
      itemId: "movie-1",
      url: "https://youtube.com.attacker.invalid/watch?v=dQw4w9WgXcQ",
    }) as { ok: boolean };
    expect(rejected.ok).toBe(false);
    expect(trailerWindow.open).toHaveBeenCalledTimes(2);
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

  it("keeps Live TV credentials and raw timer fields outside the renderer mutation surface", async () => {
    const { handlers, validEvent, api, playback } = createHarness();
    await expect(handlers.get(IPC.liveTvCreateRecording)?.(validEvent, {
      programId: "program-1",
      series: true,
      options: { recordNewOnly: true, prePaddingSeconds: 60 },
    })).resolves.toMatchObject({ ok: true });
    expect(api.createLiveTvRecording).toHaveBeenCalledWith("program-1", true, {
      recordNewOnly: true,
      prePaddingSeconds: 60,
    });

    await expect(handlers.get(IPC.liveTvCreateRecording)?.(validEvent, {
      programId: "program-1",
      series: false,
      options: { openToken: "secret", liveStreamId: "private" },
    })).resolves.toMatchObject({ ok: false });
    expect(api.createLiveTvRecording).toHaveBeenCalledTimes(1);

    playback.loadItem.mockResolvedValue({ playbackId: "playback-1" });
    await expect(handlers.get(IPC.playbackStartLive)?.(validEvent, { channelId: "channel-1" })).resolves.toMatchObject({ ok: true });
    expect(playback.loadItem).toHaveBeenCalledWith("channel-1", "start-over", { origin: "local-user" });
  });

  it("exposes only narrow Watchparty intents and rejects renderer-authored telemetry", async () => {
    const { handlers, validEvent, syncPlay } = createHarness();
    await expect(handlers.get(IPC.watchPartiesWait)?.(validEvent)).resolves.toMatchObject({ ok: true });
    await expect(handlers.get(IPC.watchPartiesContinue)?.(validEvent)).resolves.toMatchObject({ ok: true });
    await expect(handlers.get(IPC.watchPartiesResync)?.(validEvent)).resolves.toMatchObject({ ok: true });
    await expect(handlers.get(IPC.watchPartiesSetBufferingPolicy)?.(validEvent, { mode: "continue" })).resolves.toMatchObject({ ok: true });
    await expect(handlers.get(IPC.watchPartiesSetLocalSyncOffset)?.(validEvent, { offsetMilliseconds: -300 })).resolves.toMatchObject({ ok: true });
    expect(syncPlay.waitForAll).toHaveBeenCalledOnce();
    expect(syncPlay.continueAfterBuffering).toHaveBeenCalledOnce();
    expect(syncPlay.resyncGroup).toHaveBeenCalledOnce();
    expect(syncPlay.setBufferingPolicy).toHaveBeenCalledWith("continue");
    expect(syncPlay.setLocalSyncOffset).toHaveBeenCalledWith(-300);

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
    await expect(handlers.get(IPC.watchPartiesSetLocalSyncOffset)?.(validEvent, { offsetMilliseconds: 250 })).resolves.toMatchObject({ ok: false });
  });
});
