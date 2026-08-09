import { contextBridge, ipcRenderer, sharedTexture, type SharedTextureImported } from "electron";
import {
  IPC,
  type ArtworkInput,
  type BufferingPolicyPreferenceInput,
  type BrowseInput,
  type BrowsePage,
  type CleanMachineDiagnosticActionResult,
  type CleanMachineDiagnostics,
  type DiscoveredServer,
  type DownloadIdInput,
  type DownloadKeepInput,
  type DownloadLocationSummary,
  type DownloadStartInput,
  type DownloadSummary,
  type EpisodesInput,
  type HomePayload,
  type ItemIdInput,
  type JellyfinBridge,
  type LibraryItemsInput,
  type LibrarySummary,
  type LiveTvCancelScheduleInput,
  type LiveTvCreateRecordingInput,
  type LiveTvDeleteRecordingInput,
  type LiveTvGuide,
  type LiveTvGuideInput,
  type LiveTvProgramSearch,
  type LiveTvProgramSearchInput,
  type LiveTvPageInput,
  type LiveTvPlaybackInput,
  type LiveTvRecording,
  type LiveTvSeriesTimer,
  type LiveTvStatus,
  type LiveTvTimer,
  type LiveTvUpdateScheduleInput,
  type LoginInput,
  type MediaItem,
  type MediaVersion,
  type MovieVersionsInput,
  type PersonMediaResult,
  type MediaSourceCapabilities,
  type OpenSourceLicenseInventory,
  type OfflinePlayableSummary,
  type PlaybackIdInput,
  type PlaybackMediaSegmentsResult,
  type PlaybackFullscreenInput,
  type PlaybackPauseInput,
  type PlaybackRateInput,
  type PlaybackSeekInput,
  type PlaybackStartInput,
  type PlaybackStartResult,
  type PlaybackState,
  type PlaybackTrackInput,
  type PlaybackViewportInput,
  type PlaybackVolumeInput,
  type TrickplayManifest,
  type TrickplaySpriteInput,
  type PlaybackAdapterPreference,
  type PlaybackAdapterPreferenceInput,
  type RpcResult,
  type SafeSession,
  type SoloSessionDiagnostics,
  type TrailerOpenResult,
  type TrailerOpenInput,
  type SearchInput,
  type ServerConnection,
  type ServerUrlInput,
  type SmartDownloadFollowInput,
  type SmartDownloadsState,
  type SmartDownloadUnfollowInput,
  type SmartDownloadUnfollowResult,
  type WatchedStateInput,
  type WatchedStateResult,
  type UpdateCheckStatus,
  type WatchPartyCreateInput,
  type WatchPartyGroupInput,
  type WatchPartySyncOffsetInput,
  type WatchPartyVisibilityInput,
  type WatchPartyViewState,
} from "../shared/contracts";
import type { CompanionSettingsState } from "../shared/companionContracts";

async function invoke<T>(channel: string, input?: unknown): Promise<T> {
  const result = await ipcRenderer.invoke(channel, input) as RpcResult<T>;
  if (!result || typeof result !== "object" || typeof result.ok !== "boolean") throw new Error("The application returned an invalid response.");
  if (!result.ok) {
    // Plain data survives Electron's isolated-world promise bridge intact.
    // Error instances are normalized and lose an assigned application code.
    throw Object.freeze({
      code: result.error.code,
      message: result.error.message,
      retryable: result.error.retryable,
    });
  }
  return result.data;
}

const bridge: JellyfinBridge = {
  application: {
    close: () => invoke<void>(IPC.applicationClose),
  },
  server: {
    discover: () => invoke<DiscoveredServer[]>(IPC.serverDiscover),
    connect: (input: ServerUrlInput) => invoke<ServerConnection>(IPC.serverConnect, input),
  },
  session: {
    login: (input: LoginInput) => invoke<SafeSession>(IPC.sessionLogin, input),
    restore: () => invoke<SafeSession>(IPC.sessionRestore),
    getState: () => invoke<SafeSession>(IPC.sessionGetState),
    logout: () => invoke<SafeSession>(IPC.sessionLogout),
  },
  home: { get: () => invoke<HomePayload>(IPC.homeGet) },
  libraries: {
    list: () => invoke<LibrarySummary[]>(IPC.librariesList),
    getItems: (input: LibraryItemsInput) => invoke<MediaItem[]>(IPC.librariesGetItems, input),
  },
  browse: { get: (input: BrowseInput) => invoke<BrowsePage>(IPC.browseGet, input) },
  people: { getResults: (input: ItemIdInput) => invoke<PersonMediaResult[]>(IPC.peopleGetResults, input) },
  search: { query: (input: SearchInput) => invoke<MediaItem[]>(IPC.searchQuery, input) },
  items: {
    getDetails: (input: ItemIdInput) => invoke<MediaItem>(IPC.itemsGetDetails, input),
    openTrailer: (input: TrailerOpenInput) => invoke<TrailerOpenResult>(IPC.itemsOpenTrailer, input),
    setWatched: (input: WatchedStateInput) => invoke<WatchedStateResult>(IPC.itemsSetWatched, input),
  },
  shows: {
    getSeasons: (input: ItemIdInput) => invoke<MediaItem[]>(IPC.showsGetSeasons, input),
    getEpisodes: (input: EpisodesInput) => invoke<MediaItem[]>(IPC.showsGetEpisodes, input),
  },
  artwork: { getUrl: (input: ArtworkInput) => invoke<string>(IPC.artworkGetUrl, input) },
  playbackFeatures: {
    getMediaSegments: (input: PlaybackIdInput) => invoke<PlaybackMediaSegmentsResult>(IPC.playbackFeaturesGetMediaSegments, input),
    getTrickplayManifest: (input: PlaybackIdInput) => invoke<TrickplayManifest | null>(IPC.playbackFeaturesGetTrickplayManifest, input),
    getTrickplaySpriteUrl: (input: TrickplaySpriteInput) => invoke<string>(IPC.playbackFeaturesGetTrickplaySpriteUrl, input),
  },
  mediaSources: {
    getCapabilities: (input: ItemIdInput) => invoke<MediaSourceCapabilities>(IPC.mediaSourcesGetCapabilities, input),
    getVersions: (input: MovieVersionsInput) => invoke<MediaVersion[]>(IPC.mediaSourcesGetVersions, input),
  },
  liveTv: {
    getStatus: () => invoke<LiveTvStatus>(IPC.liveTvGetStatus),
    getGuide: (input: LiveTvGuideInput) => invoke<LiveTvGuide>(IPC.liveTvGetGuide, input),
    searchPrograms: (input: LiveTvProgramSearchInput) => invoke<LiveTvProgramSearch>(IPC.liveTvSearchPrograms, input),
    getRecordings: (input?: LiveTvPageInput) => invoke<LiveTvRecording[]>(IPC.liveTvGetRecordings, input ?? {}),
    getTimers: () => invoke<LiveTvTimer[]>(IPC.liveTvGetTimers),
    getSeriesTimers: () => invoke<LiveTvSeriesTimer[]>(IPC.liveTvGetSeriesTimers),
    createRecording: (input: LiveTvCreateRecordingInput) => invoke<void>(IPC.liveTvCreateRecording, input),
    updateSchedule: (input: LiveTvUpdateScheduleInput) => invoke<void>(IPC.liveTvUpdateSchedule, input),
    cancelSchedule: (input: LiveTvCancelScheduleInput) => invoke<void>(IPC.liveTvCancelSchedule, input),
    deleteRecording: (input: LiveTvDeleteRecordingInput) => invoke<void>(IPC.liveTvDeleteRecording, input),
  },
  downloads: {
    list: () => invoke<DownloadSummary[]>(IPC.downloadsList),
    listOfflinePlayable: () => invoke<OfflinePlayableSummary[]>(IPC.downloadsListOfflinePlayable),
    getLocation: () => invoke<DownloadLocationSummary>(IPC.downloadsGetLocation),
    chooseLocation: () => invoke<DownloadLocationSummary | null>(IPC.downloadsChooseLocation),
    useDefaultLocation: () => invoke<DownloadLocationSummary>(IPC.downloadsUseDefaultLocation),
    openLocation: () => invoke<{ opened: boolean }>(IPC.downloadsOpenLocation),
    start: (input: DownloadStartInput) => invoke<DownloadSummary>(IPC.downloadsStart, input),
    pause: (input: DownloadIdInput) => invoke<DownloadSummary>(IPC.downloadsPause, input),
    resume: (input: DownloadIdInput) => invoke<DownloadSummary>(IPC.downloadsResume, input),
    retry: (input: DownloadIdInput) => invoke<DownloadSummary>(IPC.downloadsRetry, input),
    cancel: (input: DownloadIdInput) => invoke<DownloadSummary>(IPC.downloadsCancel, input),
    delete: (input: DownloadIdInput) => invoke<DownloadSummary>(IPC.downloadsDelete, input),
    setKeep: (input: DownloadKeepInput) => invoke<DownloadSummary>(IPC.downloadsSetKeep, input),
    subscribe: (listener: (downloads: DownloadSummary[]) => void) => {
      const receive = (_event: Electron.IpcRendererEvent, downloads: DownloadSummary[]) => listener(downloads);
      ipcRenderer.on(IPC.downloadsChanged, receive);
      return () => ipcRenderer.removeListener(IPC.downloadsChanged, receive);
    },
  },
  smartDownloads: {
    getState: () => invoke<SmartDownloadsState>(IPC.smartDownloadsGetState),
    follow: (input: SmartDownloadFollowInput) => invoke<SmartDownloadsState>(IPC.smartDownloadsFollow, input),
    setLimit: (input: SmartDownloadFollowInput) => invoke<SmartDownloadsState>(IPC.smartDownloadsSetLimit, input),
    checkNow: () => invoke<SmartDownloadsState>(IPC.smartDownloadsCheckNow),
    unfollow: (input: SmartDownloadUnfollowInput) => invoke<SmartDownloadUnfollowResult>(IPC.smartDownloadsUnfollow, input),
    skip: (input: DownloadIdInput) => invoke<SmartDownloadsState>(IPC.smartDownloadsSkip, input),
    subscribe: (listener: (state: SmartDownloadsState) => void) => {
      const receive = (_event: Electron.IpcRendererEvent, state: SmartDownloadsState) => listener(state);
      ipcRenderer.on(IPC.smartDownloadsChanged, receive);
      return () => ipcRenderer.removeListener(IPC.smartDownloadsChanged, receive);
    },
  },
  updates: {
    check: () => invoke<UpdateCheckStatus>(IPC.updatesCheck),
    open: () => invoke<{ opened: boolean }>(IPC.updatesOpen),
    subscribe: (listener: (status: UpdateCheckStatus) => void) => {
      const receive = (_event: Electron.IpcRendererEvent, status: UpdateCheckStatus) => listener(status);
      ipcRenderer.on(IPC.updatesChanged, receive);
      return () => ipcRenderer.removeListener(IPC.updatesChanged, receive);
    },
  },
  playback: {
    start: (input: PlaybackStartInput) => invoke<PlaybackStartResult>(IPC.playbackStart, input),
    startLive: (input: LiveTvPlaybackInput) => invoke<PlaybackStartResult>(IPC.playbackStartLive, input),
    setPaused: (input: PlaybackPauseInput) => invoke<PlaybackState>(IPC.playbackSetPaused, input),
    seek: (input: PlaybackSeekInput) => invoke<PlaybackState>(IPC.playbackSeek, input),
    setRate: (input: PlaybackRateInput) => invoke<PlaybackState>(IPC.playbackSetRate, input),
    setVolume: (input: PlaybackVolumeInput) => invoke<PlaybackState>(IPC.playbackSetVolume, input),
    selectAudio: (input: PlaybackTrackInput) => invoke<PlaybackState>(IPC.playbackSelectAudio, input),
    selectSubtitle: (input: PlaybackTrackInput) => invoke<PlaybackState>(IPC.playbackSelectSubtitle, input),
    setFullscreen: (input: PlaybackFullscreenInput) => invoke<PlaybackState>(IPC.playbackSetFullscreen, input),
    continueNextEpisode: (input: PlaybackIdInput) => invoke<PlaybackState>(IPC.playbackContinueNextEpisode, input),
    cancelNextEpisode: (input: PlaybackIdInput) => invoke<PlaybackState>(IPC.playbackCancelNextEpisode, input),
    stop: (input: PlaybackIdInput) => invoke<PlaybackState>(IPC.playbackStop, input),
    getState: () => invoke<PlaybackState>(IPC.playbackGetState),
    setViewport: (input: PlaybackViewportInput) => invoke<{ embedded: boolean }>(IPC.playbackSetViewport, input),
    getAdapterPreference: () => invoke<PlaybackAdapterPreference>(IPC.playbackGetAdapterPreference),
    setAdapterPreference: (input: PlaybackAdapterPreferenceInput) => invoke<PlaybackAdapterPreference>(IPC.playbackSetAdapterPreference, input),
    subscribe: (listener: (state: PlaybackState) => void) => {
      const receive = (_event: Electron.IpcRendererEvent, state: PlaybackState) => listener(state);
      ipcRenderer.on(IPC.playbackStateChanged, receive);
      return () => ipcRenderer.removeListener(IPC.playbackStateChanged, receive);
    },
  },
  sessionPanel: {
    getSolo: () => invoke<SoloSessionDiagnostics>(IPC.sessionPanelGetSolo),
    subscribeSolo: (listener: (snapshot: SoloSessionDiagnostics) => void) => {
      const receive = (_event: Electron.IpcRendererEvent, snapshot: SoloSessionDiagnostics) => listener(snapshot);
      ipcRenderer.on(IPC.sessionPanelSoloChanged, receive);
      return () => ipcRenderer.removeListener(IPC.sessionPanelSoloChanged, receive);
    },
  },
  licenses: {
    list: () => invoke<OpenSourceLicenseInventory>(IPC.licensesList),
  },
  diagnostics: {
    getCleanMachine: () => invoke<CleanMachineDiagnostics>(IPC.diagnosticsGetCleanMachine),
    copyCleanMachine: () => invoke<CleanMachineDiagnosticActionResult>(IPC.diagnosticsCopyCleanMachine),
    saveCleanMachine: () => invoke<CleanMachineDiagnosticActionResult>(IPC.diagnosticsSaveCleanMachine),
  },
  companion: {
    getStatus: () => invoke<CompanionSettingsState>(IPC.companionGetStatus),
    setEnabled: (input) => invoke<CompanionSettingsState>(IPC.companionSetEnabled, input),
    selectNetwork: (input) => invoke<CompanionSettingsState>(IPC.companionSelectNetwork, input),
    beginPairing: () => invoke<CompanionSettingsState>(IPC.companionBeginPairing),
    cancelPairing: () => invoke<CompanionSettingsState>(IPC.companionCancelPairing),
    renameDevice: (input) => invoke<CompanionSettingsState>(IPC.companionRenameDevice, input),
    revokeDevice: (input) => invoke<CompanionSettingsState>(IPC.companionRevokeDevice, input),
    regeneratePort: (input) => invoke(IPC.companionRegeneratePort, input),
    subscribe: (listener) => {
      const receive = (_event: Electron.IpcRendererEvent, state: CompanionSettingsState) => listener(state);
      ipcRenderer.on(IPC.companionChanged, receive);
      return () => ipcRenderer.removeListener(IPC.companionChanged, receive);
    },
  },
  watchParties: {
    getState: () => invoke<WatchPartyViewState>(IPC.watchPartiesGetState),
    list: () => invoke<WatchPartyViewState>(IPC.watchPartiesList),
    create: (input: WatchPartyCreateInput) => invoke<WatchPartyViewState>(IPC.watchPartiesCreate, input),
    join: (input: WatchPartyGroupInput) => invoke<WatchPartyViewState>(IPC.watchPartiesJoin, input),
    leave: () => invoke<WatchPartyViewState>(IPC.watchPartiesLeave),
    wait: () => invoke<WatchPartyViewState>(IPC.watchPartiesWait),
    continue: () => invoke<WatchPartyViewState>(IPC.watchPartiesContinue),
    resync: () => invoke<WatchPartyViewState>(IPC.watchPartiesResync),
    setLocalSyncOffset: (input: WatchPartySyncOffsetInput) => invoke<WatchPartyViewState>(IPC.watchPartiesSetLocalSyncOffset, input),
    setBufferingPolicy: (input: BufferingPolicyPreferenceInput) => invoke<WatchPartyViewState>(IPC.watchPartiesSetBufferingPolicy, input),
    setVisible: (input: WatchPartyVisibilityInput) => invoke<WatchPartyViewState>(IPC.watchPartiesSetVisible, input),
    subscribe: (listener: (state: WatchPartyViewState) => void) => {
      const receive = (_event: Electron.IpcRendererEvent, state: WatchPartyViewState) => listener(state);
      ipcRenderer.on(IPC.watchPartiesChanged, receive);
      return () => ipcRenderer.removeListener(IPC.watchPartiesChanged, receive);
    },
  },
};

for (const value of Object.values(bridge)) Object.freeze(value);
Object.freeze(bridge);

contextBridge.exposeInMainWorld("jellyfin", bridge);

// Private libmpv presentation transport. Nothing from this receiver is exposed
// through contextBridge: native handles, frames, paths, and source details stay
// inside Electron's isolated preload world.
const libmpvPresenterIpc = Object.freeze({
  listenerReady: "seeing-stone:libmpv-presenter-listener-ready",
  start: "seeing-stone:libmpv-presenter-start",
  ready: "seeing-stone:libmpv-presenter-ready",
  stop: "seeing-stone:libmpv-presenter-stop",
  presented: "seeing-stone:libmpv-presenter-presented",
  error: "seeing-stone:libmpv-presenter-error",
});

let libmpvSurfaceGeneration = 0;
let libmpvSurface: HTMLCanvasElement | null = null;
let libmpvSurfaceContext: ImageBitmapRenderingContext | null = null;
let libmpvBackSurface: HTMLCanvasElement | null = null;
let libmpvBackSurfaceContext: ImageBitmapRenderingContext | null = null;
let libmpvPresentedTexture: SharedTextureImported | null = null;
let libmpvResizeObserver: ResizeObserver | null = null;
let libmpvStopped = true;
let libmpvLastAcceptedSequence = 0;

async function playerViewport(): Promise<HTMLElement> {
  const existing = document.getElementById("playerViewport");
  if (existing) return existing;
  await new Promise<void>((resolve) => document.addEventListener("DOMContentLoaded", () => resolve(), { once: true }));
  const viewport = document.getElementById("playerViewport");
  if (!viewport) throw new Error("PLAYER_VIEWPORT_UNAVAILABLE");
  return viewport;
}

function stopLibMpvPresenter(): void {
  libmpvStopped = true;
  libmpvLastAcceptedSequence = 0;
  libmpvResizeObserver?.disconnect();
  libmpvResizeObserver = null;
  libmpvPresentedTexture?.release();
  libmpvPresentedTexture = null;
  libmpvSurfaceContext = null;
  libmpvBackSurfaceContext = null;
  libmpvSurface?.remove();
  libmpvBackSurface?.remove();
  libmpvSurface = null;
  libmpvBackSurface = null;
}

async function startLibMpvPresenter(input: unknown): Promise<void> {
  stopLibMpvPresenter();
  if (!input || typeof input !== "object") throw new Error("PRESENTER_INPUT_INVALID");
  const generation = (input as Record<string, unknown>).surfaceGeneration;
  if (!Number.isSafeInteger(generation) || Number(generation) <= 0) throw new Error("PRESENTER_GENERATION_INVALID");
  const viewport = await playerViewport();
  const createSurface = (id: string, zIndex: number): { surface: HTMLCanvasElement; context: ImageBitmapRenderingContext } => {
    const surface = document.createElement("canvas");
    surface.id = id;
    surface.setAttribute("aria-hidden", "true");
    Object.assign(surface.style, {
      position: "absolute",
      inset: "0",
      zIndex: String(zIndex),
      width: "100%",
      height: "100%",
      background: "#020207",
      display: "block",
      contain: "strict",
      pointerEvents: "none",
      transform: "scaleY(-1)",
      transformOrigin: "center",
      willChange: "transform",
    });
    const context = surface.getContext("bitmaprenderer");
    if (!context) throw new Error("GPU_PRESENTER_UNAVAILABLE");
    return { surface, context };
  };
  const front = createSurface("libmpvVideoSurface", 1);
  const back = createSurface("libmpvVideoSurfaceBack", 0);
  const resize = (): void => {
    const bounds = viewport.getBoundingClientRect();
    const scale = Math.max(0.5, Math.min(4, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.round(bounds.width * scale));
    const height = Math.max(1, Math.round(bounds.height * scale));
    // Assigning either canvas dimension clears the bitmap. ResizeObserver can
    // report an unchanged box after insertion, so only resize when necessary.
    for (const surface of [front.surface, back.surface]) {
      if (surface.width !== width) surface.width = width;
      if (surface.height !== height) surface.height = height;
    }
  };
  libmpvResizeObserver = new ResizeObserver(resize);
  libmpvResizeObserver.observe(viewport);
  resize();
  viewport.append(front.surface, back.surface);
  libmpvSurfaceGeneration = Number(generation);
  libmpvLastAcceptedSequence = 0;
  libmpvSurface = front.surface;
  libmpvSurfaceContext = front.context;
  libmpvBackSurface = back.surface;
  libmpvBackSurfaceContext = back.context;
  libmpvStopped = false;
  ipcRenderer.send(libmpvPresenterIpc.ready, {
    surfaceGeneration: libmpvSurfaceGeneration,
    mechanism: "image-bitmap-renderer",
    deviceScaleFactor: window.devicePixelRatio,
  });
}

sharedTexture?.setSharedTextureReceiver(async ({ importedSharedTexture }, metadata: unknown) => {
  let frame: VideoFrame | null = null;
  let retainedForPresentation = false;
  try {
    const record = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : null;
    const sequence = record?.sequence;
    if (libmpvStopped || !record || record.surfaceGeneration !== libmpvSurfaceGeneration
      || !Number.isSafeInteger(sequence) || Number(sequence) <= libmpvLastAcceptedSequence
      || !libmpvSurfaceContext || !libmpvSurface || !libmpvBackSurfaceContext || !libmpvBackSurface) return;
    const acceptedSequence = Number(sequence);
    const acceptedGeneration = libmpvSurfaceGeneration;
    const backSurface = libmpvBackSurface;
    const backSurfaceContext = libmpvBackSurfaceContext;
    libmpvLastAcceptedSequence = acceptedSequence;
    frame = importedSharedTexture.getVideoFrame();
    const bitmap = await createImageBitmap(frame);
    if (libmpvStopped || acceptedGeneration !== libmpvSurfaceGeneration
      || acceptedSequence !== libmpvLastAcceptedSequence
      || backSurface !== libmpvBackSurface || backSurfaceContext !== libmpvBackSurfaceContext) {
      bitmap.close();
      return;
    }
    backSurfaceContext.transferFromImageBitmap(bitmap);
    // Keep both video buffers permanently below the renderer controls. The
    // previous monotonically increasing layer eventually covered every HTML
    // overlay after only a few frames.
    libmpvSurface.style.zIndex = "1";
    libmpvBackSurface.style.zIndex = "2";
    [libmpvSurface, libmpvBackSurface] = [libmpvBackSurface, libmpvSurface];
    [libmpvSurfaceContext, libmpvBackSurfaceContext] = [libmpvBackSurfaceContext, libmpvSurfaceContext];
    const previousTexture = libmpvPresentedTexture;
    libmpvPresentedTexture = importedSharedTexture;
    retainedForPresentation = true;
    ipcRenderer.send(libmpvPresenterIpc.presented, {
      surfaceGeneration: libmpvSurfaceGeneration,
      sequence: acceptedSequence,
    });
    previousTexture?.release();
  } finally {
    frame?.close();
    if (!retainedForPresentation) importedSharedTexture.release();
  }
});

ipcRenderer.on(libmpvPresenterIpc.start, (_event, input) => {
  void startLibMpvPresenter(input).catch((error) => {
    ipcRenderer.send(libmpvPresenterIpc.error, {
      surfaceGeneration: input && typeof input === "object" ? (input as Record<string, unknown>).surfaceGeneration : null,
      code: error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "PRESENTER_INITIALIZATION_FAILED",
    });
  });
});
ipcRenderer.on(libmpvPresenterIpc.stop, () => stopLibMpvPresenter());
window.addEventListener("beforeunload", () => stopLibMpvPresenter(), { once: true });
ipcRenderer.send(libmpvPresenterIpc.listenerReady);
