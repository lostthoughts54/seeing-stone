import type {
  CleanMachineDiagnostics,
  DiscoveredServer,
  DownloadLocationSummary,
  DownloadSummary,
  ImageKind,
  LibrarySummary,
  LiveTvGuide,
  LiveTvProgram,
  LiveTvProgramSearch,
  LiveTvRecording,
  LiveTvSeriesTimer,
  LiveTvTimer,
  MediaItem,
  MediaVersion,
  MediaPerson,
  PersonMediaResult,
  OpenSourceLicenseInventory,
  PlaybackAdapterPreference,
  OfflinePlayableSummary,
  PlaybackSourceKind,
  PlaybackMediaSegment,
  PlaybackState,
  PlaybackTrack,
  SafeSession,
  SessionPanelView,
  SmartDownloadsState,
  SmartSeriesSummary,
  SoloSessionDiagnostics,
  WatchPartyViewState,
  TrickplayManifest,
} from "../shared/contracts";
import type { CompanionSettingsState } from "../shared/companionContracts";
import { BRANDING } from "../shared/branding";
import {
  connectionStatePresentation,
  formatBitrate,
  formatBufferAhead,
  formatPlaybackRate,
  formatPlaybackTime,
  playbackPhasePresentation,
  safeTimelineValue,
  sourceKindLabel,
  timelineTicks,
  trackLabel,
} from "./playerPresentation";
import { activeMediaSegment, canSkipSegment, segmentLabel } from "./playerSegments";
import { clampedPreviewLeft, trickplayFrame } from "./trickplayPresentation";
import { loadAllBrowseItems } from "./browsePagination";
import { LIVE_TV_GUIDE_WINDOW_MS, LIVE_TV_HALF_HOUR_MS, LIVE_TV_HALF_HOUR_PX, currentTimeMarkerPercent, guideScrollLeftForTime, isCurrentProgram, isLocalDateTransition, normalGuideWindow, placeProgramInWindow, timeAxisLabels, visibleChannelSlice } from "./liveTvPresentation";
import { presentPeople } from "../shared/personPresentation";
import { groupMovieVersions } from "../shared/mediaVersions";

const TICKS_PER_SECOND = 10000000;
const DOWNLOADED_LIBRARY_ID = "seeing-stone:downloaded";
const DOWNLOADED_LIBRARY: LibrarySummary = {
  id: DOWNLOADED_LIBRARY_ID,
  name: "Downloaded",
  collectionType: "downloaded",
};
type Route = "home" | "library" | "search" | "details" | "watch-parties" | "live-tv";
type LiveTvTab = "guide" | "recordings" | "scheduled";
type MediaRow = {
  title: string;
  items: MediaItem[];
  shape: "poster" | "landscape";
  linkEpisodeSeries?: boolean;
};
type ImageOptions = { width?: number; height?: number };
type LibraryFilter = "all" | "unwatched" | "watched" | "downloaded";
type LibrarySort = "title-ascending" | "title-descending" | "date-added-descending" | "year-descending" | "year-ascending" | "rating-descending";

function byId<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required UI element: ${id}`);
  return element as unknown as T;
}

const loginView = byId<HTMLElement>("loginView");
const mainView = byId<HTMLElement>("mainView");
const loginForm = byId<HTMLFormElement>("loginForm");
const serverUrlInput = byId<HTMLInputElement>("serverUrlInput");
const discoverButton = byId<HTMLButtonElement>("discoverButton");
const discoveryDot = byId<HTMLElement>("discoveryDot");
const discoveryMessage = byId<HTMLElement>("discoveryMessage");
const serverResults = byId<HTMLElement>("serverResults");
const usernameInput = byId<HTMLInputElement>("usernameInput");
const passwordInput = byId<HTMLInputElement>("passwordInput");
const loginMessage = byId<HTMLElement>("loginMessage");

const brandHomeButton = byId<HTMLButtonElement>("brandHomeButton");
const navHomeButton = byId<HTMLButtonElement>("navHomeButton");
const navLiveTvButton = byId<HTMLButtonElement>("navLiveTvButton");
const mainLibraryNavigation = byId<HTMLElement>("mainLibraryNavigation");
const navWatchPartiesButton = byId<HTMLButtonElement>("navWatchPartiesButton");
const navCompanionButton = byId<HTMLButtonElement>("navCompanionButton");
const companionNavStatusDot = byId<HTMLElement>("companionNavStatusDot");
const closeApplicationButton = byId<HTMLButtonElement>("closeApplicationButton");
const searchInput = byId<HTMLInputElement>("searchInput");
const profileButton = byId<HTMLButtonElement>("profileButton");
const profileInitial = byId<HTMLElement>("profileInitial");
const profileMenu = byId<HTMLElement>("profileMenu");
const userLabel = byId<HTMLElement>("userLabel");
const serverLabel = byId<HTMLElement>("serverLabel");
const profileAdapterSelect = byId<HTMLSelectElement>("profileAdapterSelect");
const profileAdapterSelectSetting = byId<HTMLElement>("profileAdapterSelectSetting");
const profileAdapterFixed = byId<HTMLElement>("profileAdapterFixed");
const profileAdapterStatus = byId<HTMLElement>("profileAdapterStatus");
const downloadsButton = byId<HTMLButtonElement>("downloadsButton");
const refreshButton = byId<HTMLButtonElement>("refreshButton");
const logoutButton = byId<HTMLButtonElement>("logoutButton");

const contentScroller = byId<HTMLElement>("contentScroller");
const homeView = byId<HTMLElement>("homeView");
const libraryView = byId<HTMLElement>("libraryView");
const searchView = byId<HTMLElement>("searchView");
const detailsView = byId<HTMLElement>("detailsView");
const watchPartiesView = byId<HTMLElement>("watchPartiesView");
const liveTvView = byId<HTMLElement>("liveTvView");
const liveTvStatus = byId<HTMLElement>("liveTvStatus");
const liveTvContent = byId<HTMLElement>("liveTvContent");
const liveTvGuideTools = byId<HTMLElement>("liveTvGuideTools");
const liveTvChannelSearch = byId<HTMLInputElement>("liveTvChannelSearch");
const liveTvChannelSearchStatus = byId<HTMLElement>("liveTvChannelSearchStatus");
const refreshLiveTvButton = byId<HTMLButtonElement>("refreshLiveTvButton");
const liveTvNowButton = byId<HTMLButtonElement>("liveTvNowButton");
const liveTvGuideTab = byId<HTMLButtonElement>("liveTvGuideTab");
const liveTvRecordingsTab = byId<HTMLButtonElement>("liveTvRecordingsTab");
const liveTvScheduledTab = byId<HTMLButtonElement>("liveTvScheduledTab");
const watchPartyNameInput = byId<HTMLInputElement>("watchPartyNameInput");
const createWatchPartyButton = byId<HTMLButtonElement>("createWatchPartyButton");
const refreshWatchPartiesButton = byId<HTMLButtonElement>("refreshWatchPartiesButton");
const watchPartyStatus = byId<HTMLElement>("watchPartyStatus");
const joinedWatchParty = byId<HTMLElement>("joinedWatchParty");
const watchPartyList = byId<HTMLElement>("watchPartyList");

const featureHero = byId<HTMLElement>("featureHero");
const featureImage = byId<HTMLImageElement>("featureImage");
const featureEyebrow = byId<HTMLElement>("featureEyebrow");
const featureTitle = byId<HTMLElement>("featureTitle");
const featureOverview = byId<HTMLElement>("featureOverview");
const featurePlayButton = byId<HTMLButtonElement>("featurePlayButton");
const featureInfoButton = byId<HTMLButtonElement>("featureInfoButton");
const homeRows = byId<HTMLElement>("homeRows");

const libraryTitle = byId<HTMLElement>("libraryTitle");
const libraryFilter = byId<HTMLSelectElement>("libraryFilter");
const librarySort = byId<HTMLSelectElement>("librarySort");
const downloadedLibraryActions = byId<HTMLElement>("downloadedLibraryActions");
const selectDownloadedButton = byId<HTMLButtonElement>("selectDownloadedButton");
const selectAllDownloadedButton = byId<HTMLButtonElement>("selectAllDownloadedButton");
const deleteSelectedDownloadedButton = byId<HTMLButtonElement>("deleteSelectedDownloadedButton");
const cancelDownloadedSelectionButton = byId<HTMLButtonElement>("cancelDownloadedSelectionButton");
const downloadedFollowedSeries = byId<HTMLElement>("downloadedFollowedSeries");
const downloadedFollowedSeriesList = byId<HTMLElement>("downloadedFollowedSeriesList");
const libraryGrid = byId<HTMLElement>("libraryGrid");
const searchTitle = byId<HTMLElement>("searchTitle");
const searchRows = byId<HTMLElement>("searchRows");

const detailsBackButton = byId<HTMLButtonElement>("detailsBackButton");
const detailHero = byId<HTMLElement>("detailHero");
const detailBackdrop = byId<HTMLImageElement>("detailBackdrop");
const detailPosterFrame = byId<HTMLElement>("detailPosterFrame");
const detailPoster = byId<HTMLImageElement>("detailPoster");
const detailPosterFallback = byId<HTMLElement>("detailPosterFallback");
const detailEyebrow = byId<HTMLElement>("detailEyebrow");
const detailTitle = byId<HTMLElement>("detailTitle");
const detailMeta = byId<HTMLElement>("detailMeta");
const detailOverview = byId<HTMLElement>("detailOverview");
const detailGenres = byId<HTMLElement>("detailGenres");
const detailVersionControl = byId<HTMLElement>("detailVersionControl");
const detailVersionSelect = byId<HTMLSelectElement>("detailVersionSelect");
const detailVersionNote = byId<HTMLElement>("detailVersionNote");
const detailCast = byId<HTMLElement>("detailCast");
const detailPeople = byId<HTMLElement>("detailPeople");
const detailPlayButton = byId<HTMLButtonElement>("detailPlayButton");
const detailPlayLabel = byId<HTMLElement>("detailPlayLabel");
const detailDownloadButton = byId<HTMLButtonElement>("detailDownloadButton");
const detailDownloadLabel = byId<HTMLElement>("detailDownloadLabel");
const detailTrailerButton = byId<HTMLButtonElement>("detailTrailerButton");
const detailWatchedButton = byId<HTMLButtonElement>("detailWatchedButton");
const detailWatchedLabel = byId<HTMLElement>("detailWatchedLabel");
const detailSeriesButton = byId<HTMLButtonElement>("detailSeriesButton");
const detailSmartDownloadsButton = byId<HTMLButtonElement>("detailSmartDownloadsButton");
const detailSmartDownloadsLabel = byId<HTMLElement>("detailSmartDownloadsLabel");
const episodeSection = byId<HTMLElement>("episodeSection");
const seasonSelect = byId<HTMLSelectElement>("seasonSelect");
const selectSeasonEpisodes = byId<HTMLInputElement>("selectSeasonEpisodes");
const downloadSelectedEpisodes = byId<HTMLButtonElement>("downloadSelectedEpisodes");
const episodeList = byId<HTMLOListElement>("episodeList");

const mobileHomeButton = byId<HTMLButtonElement>("mobileHomeButton");
const mobileSearchButton = byId<HTMLButtonElement>("mobileSearchButton");
const mobileLibraryButton = byId<HTMLButtonElement>("mobileLibraryButton");
const mobileLiveTvButton = byId<HTMLButtonElement>("mobileLiveTvButton");
const mobileWatchPartiesButton = byId<HTMLButtonElement>("mobileWatchPartiesButton");
const playerView = byId<HTMLElement>("playerView");
const playerLibraryNavigation = byId<HTMLElement>("playerLibraryNavigation");
const playerCenter = byId<HTMLElement>("playerCenter");
const playerFrame = byId<HTMLElement>("playerFrame");
const playerViewport = byId<HTMLElement>("playerViewport");
const playerSegmentSkipButton = byId<HTMLButtonElement>("playerSegmentSkipButton");
const nextEpisodeCountdown = byId<HTMLElement>("nextEpisodeCountdown");
const watchPartyStartCue = byId<HTMLElement>("watchPartyStartCue");
const nextEpisodeCountdownTitle = byId<HTMLElement>("nextEpisodeCountdownTitle");
const nextEpisodeCountdownMeta = byId<HTMLElement>("nextEpisodeCountdownMeta");
const nextEpisodeCountdownLabel = byId<HTMLElement>("nextEpisodeCountdownLabel");
const nextEpisodeCountdownProgress = byId<HTMLProgressElement>("nextEpisodeCountdownProgress");
const nextEpisodePlayNowButton = byId<HTMLButtonElement>("nextEpisodePlayNowButton");
const nextEpisodeCancelButton = byId<HTMLButtonElement>("nextEpisodeCancelButton");
const playerEpisodeBrowser = byId<HTMLElement>("playerEpisodeBrowser");
const playerEpisodeBrowserTitle = byId<HTMLElement>("playerEpisodeBrowserTitle");
const closePlayerEpisodeBrowserButton = byId<HTMLButtonElement>("closePlayerEpisodeBrowserButton");
const playerEpisodeSeasonSelect = byId<HTMLSelectElement>("playerEpisodeSeasonSelect");
const playerEpisodeBrowserStatus = byId<HTMLElement>("playerEpisodeBrowserStatus");
const playerEpisodeList = byId<HTMLElement>("playerEpisodeList");
const playerTitle = byId<HTMLElement>("playerTitle");
const playerMeta = byId<HTMLElement>("playerMeta");
const playerSourceBadge = byId<HTMLElement>("playerSourceBadge");
const playerConnectionBadge = byId<HTMLElement>("playerConnectionBadge");
const playerSyncBadge = byId<HTMLElement>("playerSyncBadge");
const playerFrameStatus = byId<HTMLElement>("playerFrameStatus");
const playerPhaseLabel = byId<HTMLElement>("playerPhaseLabel");
const playerControls = byId<HTMLElement>("playerControls");
const playerLiveControls = byId<HTMLElement>("playerLiveControls");
const playerPreviousChannelButton = byId<HTMLButtonElement>("playerPreviousChannelButton");
const playerGoLiveButton = byId<HTMLButtonElement>("playerGoLiveButton");
const playerMiniGuideButton = byId<HTMLButtonElement>("playerMiniGuideButton");
const playerNextChannelButton = byId<HTMLButtonElement>("playerNextChannelButton");
const playerMiniGuide = byId<HTMLElement>("playerMiniGuide");
const playerTimeline = byId<HTMLInputElement>("playerTimeline");
const playerTimelineTrack = byId<HTMLElement>("playerTimelineTrack");
const playerTimelinePreview = byId<HTMLElement>("playerTimelinePreview");
const playerTimelinePreviewImage = byId<HTMLElement>("playerTimelinePreviewImage");
const playerTimelinePreviewImg = byId<HTMLImageElement>("playerTimelinePreviewImg");
const playerTimelinePreviewTime = byId<HTMLElement>("playerTimelinePreviewTime");
const playerCurrentTime = byId<HTMLElement>("playerCurrentTime");
const playerDuration = byId<HTMLElement>("playerDuration");
const playerMuteButton = byId<HTMLButtonElement>("playerMuteButton");
const playerVolume = byId<HTMLInputElement>("playerVolume");
const playerBack10Button = byId<HTMLButtonElement>("playerBack10Button");
const playerPlayPauseButton = byId<HTMLButtonElement>("playerPlayPauseButton");
const playerPlayIcon = byId<SVGElement>("playerPlayIcon");
const playerForward10Button = byId<HTMLButtonElement>("playerForward10Button");
const playerRateSelect = byId<HTMLSelectElement>("playerRateSelect");
const playerAudioSelect = byId<HTMLSelectElement>("playerAudioSelect");
const playerSubtitleSelect = byId<HTMLSelectElement>("playerSubtitleSelect");
const playerSettingsButton = byId<HTMLButtonElement>("playerSettingsButton");
const playerSettingsMenu = byId<HTMLElement>("playerSettingsMenu");
const closePlayerSettingsButton = byId<HTMLButtonElement>("closePlayerSettingsButton");
const playerSettingsRateSelect = byId<HTMLSelectElement>("playerSettingsRateSelect");
const playerSettingsAudioSelect = byId<HTMLSelectElement>("playerSettingsAudioSelect");
const playerSettingsSubtitleSelect = byId<HTMLSelectElement>("playerSettingsSubtitleSelect");
const playerAdapterSelect = byId<HTMLSelectElement>("playerAdapterSelect");
const playerAdapterSelectSetting = byId<HTMLElement>("playerAdapterSelectSetting");
const playerAdapterFixed = byId<HTMLElement>("playerAdapterFixed");
const playerAdapterStatus = byId<HTMLElement>("playerAdapterStatus");
const playerSettingsDiagnosticsButton = byId<HTMLButtonElement>("playerSettingsDiagnosticsButton");
const playerEpisodeBrowserButton = byId<HTMLButtonElement>("playerEpisodeBrowserButton");
const playerNextButton = byId<HTMLButtonElement>("playerNextButton");
const playerFullscreenButton = byId<HTMLButtonElement>("playerFullscreenButton");
const playerEyebrow = byId<HTMLElement>("playerEyebrow");
const playerMetadataTitle = byId<HTMLElement>("playerMetadataTitle");
const playerOverview = byId<HTMLElement>("playerOverview");
const playerMediaPills = byId<HTMLElement>("playerMediaPills");
const playerNextCard = byId<HTMLElement>("playerNextCard");
const playerNextTitle = byId<HTMLElement>("playerNextTitle");
const playerNextMeta = byId<HTMLElement>("playerNextMeta");
const playerNextCardButton = byId<HTMLButtonElement>("playerNextCardButton");
const sessionPanel = byId<HTMLElement>("sessionPanel");
const sessionPanelContent = byId<HTMLElement>("sessionPanelContent");
const sessionSoloTab = byId<HTMLButtonElement>("sessionSoloTab");
const sessionWatchpartyTab = byId<HTMLButtonElement>("sessionWatchpartyTab");
const toggleSessionPanelButton = byId<HTMLButtonElement>("toggleSessionPanelButton");
const openSessionPanelButton = byId<HTMLButtonElement>("openSessionPanelButton");
const sessionPanelScrim = byId<HTMLButtonElement>("sessionPanelScrim");
const playerExitButton = byId<HTMLButtonElement>("playerExitButton");
const closePlayerButton = byId<HTMLButtonElement>("closePlayerButton");
const licensesButton = byId<HTMLButtonElement>("licensesButton");
const loginCleanMachineDiagnosticsButton = byId<HTMLButtonElement>("loginCleanMachineDiagnosticsButton");
const licensesScrim = byId<HTMLElement>("licensesScrim");
const licensesPanel = byId<HTMLElement>("licensesPanel");
const closeLicensesButton = byId<HTMLButtonElement>("closeLicensesButton");
const licensesSearchInput = byId<HTMLInputElement>("licensesSearchInput");
const licensesSummary = byId<HTMLElement>("licensesSummary");
const licensesList = byId<HTMLElement>("licensesList");
const cleanMachineDiagnosticsButton = byId<HTMLButtonElement>("cleanMachineDiagnosticsButton");
const cleanMachineDiagnosticsScrim = byId<HTMLElement>("cleanMachineDiagnosticsScrim");
const cleanMachineDiagnosticsPanel = byId<HTMLElement>("cleanMachineDiagnosticsPanel");
const closeCleanMachineDiagnosticsButton = byId<HTMLButtonElement>("closeCleanMachineDiagnosticsButton");
const cleanMachineDiagnosticsSummary = byId<HTMLElement>("cleanMachineDiagnosticsSummary");
const cleanMachineDiagnosticsMetadata = byId<HTMLElement>("cleanMachineDiagnosticsMetadata");
const cleanMachineDiagnosticsChecks = byId<HTMLElement>("cleanMachineDiagnosticsChecks");
const rerunCleanMachineDiagnosticsButton = byId<HTMLButtonElement>("rerunCleanMachineDiagnosticsButton");
const copyCleanMachineDiagnosticsButton = byId<HTMLButtonElement>("copyCleanMachineDiagnosticsButton");
const saveCleanMachineDiagnosticsButton = byId<HTMLButtonElement>("saveCleanMachineDiagnosticsButton");
const downloadsScrim = byId<HTMLElement>("downloadsScrim");
const downloadsPanel = byId<HTMLElement>("downloadsPanel");
const closeDownloadsButton = byId<HTMLButtonElement>("closeDownloadsButton");
const companionScrim = byId<HTMLElement>("companionScrim");
const companionPanel = byId<HTMLElement>("companionPanel");
const closeCompanionButton = byId<HTMLButtonElement>("closeCompanionButton");
const trailerScrim = byId<HTMLElement>("trailerScrim");
const trailerPanel = byId<HTMLElement>("trailerPanel");
const trailerTitle = byId<HTMLElement>("trailerTitle");
const trailerFrame = byId<HTMLIFrameElement>("trailerFrame");
const closeTrailerButton = byId<HTMLButtonElement>("closeTrailerButton");
const openTrailerBrowserButton = byId<HTMLButtonElement>("openTrailerBrowserButton");
const companionNetwork = byId<HTMLSelectElement>("companionNetwork");
const companionEnabled = byId<HTMLInputElement>("companionEnabled");
const companionStatus = byId<HTMLElement>("companionStatus");
const companionAddresses = byId<HTMLElement>("companionAddresses");
const companionPairButton = byId<HTMLButtonElement>("companionPairButton");
const companionCancelPairButton = byId<HTMLButtonElement>("companionCancelPairButton");
const companionRegeneratePortButton = byId<HTMLButtonElement>("companionRegeneratePortButton");
const companionPairing = byId<HTMLElement>("companionPairing");
const companionQr = byId<HTMLImageElement>("companionQr");
const companionPairAddress = byId<HTMLElement>("companionPairAddress");
const companionPairCode = byId<HTMLElement>("companionPairCode");
const companionPairExpiry = byId<HTMLElement>("companionPairExpiry");
const companionDevices = byId<HTMLElement>("companionDevices");
const downloadLocationLabel = byId<HTMLElement>("downloadLocationLabel");
const chooseDownloadLocationButton = byId<HTMLButtonElement>("chooseDownloadLocationButton");
const openDownloadLocationButton = byId<HTMLButtonElement>("openDownloadLocationButton");
const defaultDownloadLocationButton = byId<HTMLButtonElement>("defaultDownloadLocationButton");
const downloadsList = byId<HTMLElement>("downloadsList");
const smartDownloadsList = byId<HTMLElement>("smartDownloadsList");
const checkSmartDownloadsButton = byId<HTMLButtonElement>("checkSmartDownloadsButton");
const smartDownloadDialog = byId<HTMLDialogElement>("smartDownloadDialog");
const smartDownloadDialogTitle = byId<HTMLElement>("smartDownloadDialogTitle");
const smartDownloadDialogDescription = byId<HTMLElement>("smartDownloadDialogDescription");
const smartDownloadEpisodeLimit = byId<HTMLSelectElement>("smartDownloadEpisodeLimit");
const smartUnfollowDialog = byId<HTMLDialogElement>("smartUnfollowDialog");
const smartUnfollowDialogDescription = byId<HTMLElement>("smartUnfollowDialogDescription");
const playerFallbackNotice = byId<HTMLElement>("playerFallbackNotice");
const playerFallbackNoticeMessage = byId<HTMLElement>("playerFallbackNoticeMessage");
const toast = byId<HTMLElement>("toast");

interface RendererState {
  session: SafeSession | null;
  discoveredServers: DiscoveredServer[];
  libraries: LibrarySummary[];
  homeRows: MediaRow[];
  homeRequestId: number;
  resumeItems: MediaItem[];
  nextUpItems: MediaItem[];
  featureItem: MediaItem | null;
  currentRoute: Route;
  returnRoute: Route;
  returnScrollTop: number;
  searchReturnRoute: Route;
  searchReturnScrollTop: number;
  selectedLibraryId: string | null;
  libraryFilter: LibraryFilter;
  librarySort: LibrarySort;
  libraryCache: Map<string, MediaItem[]>;
  libraryRequestIds: Map<string, number>;
  downloadedSelectionMode: boolean;
  selectedDownloadIds: Set<string>;
  detailItem: MediaItem | null;
  detailPlayItem: MediaItem | null;
  detailVersions: MediaVersion[];
  detailsRequestId: number;
  seasons: MediaItem[];
  episodes: MediaItem[];
  selectedEpisodeIds: Set<string>;
  playbackItem: MediaItem | null;
  playbackId: string | null;
  playbackSource: "server" | "local" | null;
  playbackSourceKind: PlaybackSourceKind | null;
  playbackState: PlaybackState | null;
  playbackRequestId: number;
  playerEpisodeBrowserSeriesId: string | null;
  playerEpisodeBrowserSeasonId: string | null;
  playerEpisodeBrowserSeasons: MediaItem[];
  playerEpisodeBrowserEpisodes: MediaItem[];
  playerEpisodeBrowserRequestId: number;
  soloDiagnostics: SoloSessionDiagnostics | null;
  soloDiagnosticsRequestId: number;
  sessionPanelView: SessionPanelView;
  sessionPanelCollapsed: boolean;
  licenseInventory: OpenSourceLicenseInventory | null;
  cleanMachineDiagnostics: CleanMachineDiagnostics | null;
  downloads: DownloadSummary[];
  offlinePlayable: OfflinePlayableSummary[];
  downloadLocation: DownloadLocationSummary | null;
  smartDownloads: SmartDownloadsState;
  lastFocusElement: HTMLElement | null;
  searchTimer: ReturnType<typeof setTimeout> | null;
  searchRequestId: number;
  toastTimer: ReturnType<typeof setTimeout> | null;
  watchParties: WatchPartyViewState | null;
  liveTvGuide: LiveTvGuide | null;
  liveTvRecordings: LiveTvRecording[];
  liveTvTimers: LiveTvTimer[];
  liveTvSeriesTimers: LiveTvSeriesTimer[];
  liveTvTab: LiveTvTab;
  liveTvRequestId: number;
  liveTvChannelQuery: string;
  liveTvProgramSearch: LiveTvProgramSearch | null;
  liveTvProgramSearchRequestId: number;
}

const state: RendererState = {
  session: null,
  discoveredServers: [],
  libraries: [],
  homeRows: [],
  homeRequestId: 0,
  resumeItems: [],
  nextUpItems: [],
  featureItem: null,
  currentRoute: "home",
  returnRoute: "home",
  returnScrollTop: 0,
  searchReturnRoute: "home",
  searchReturnScrollTop: 0,
  selectedLibraryId: null,
  libraryFilter: "all",
  librarySort: "title-ascending",
  libraryCache: new Map(),
  libraryRequestIds: new Map(),
  downloadedSelectionMode: false,
  selectedDownloadIds: new Set(),
  detailItem: null,
  detailPlayItem: null,
  detailVersions: [],
  detailsRequestId: 0,
  seasons: [],
  episodes: [],
  selectedEpisodeIds: new Set(),
  playbackItem: null,
  playbackId: null,
  playbackSource: null,
  playbackSourceKind: null,
  playbackState: null,
  playbackRequestId: 0,
  playerEpisodeBrowserSeriesId: null,
  playerEpisodeBrowserSeasonId: null,
  playerEpisodeBrowserSeasons: [],
  playerEpisodeBrowserEpisodes: [],
  playerEpisodeBrowserRequestId: 0,
  soloDiagnostics: null,
  soloDiagnosticsRequestId: 0,
  sessionPanelView: "solo",
  sessionPanelCollapsed: false,
  licenseInventory: null,
  cleanMachineDiagnostics: null,
  downloads: [],
  offlinePlayable: [],
  downloadLocation: null,
  smartDownloads: { series: [], notice: null },
  lastFocusElement: null,
  searchTimer: null,
  searchRequestId: 0,
  toastTimer: null,
  watchParties: null,
  liveTvGuide: null,
  liveTvRecordings: [],
  liveTvTimers: [],
  liveTvSeriesTimers: [],
  liveTvTab: "guide",
  liveTvRequestId: 0,
  liveTvChannelQuery: "",
  liveTvProgramSearch: null,
  liveTvProgramSearchRequestId: 0,
};

let connectionRetryInFlight = false;
let companionPairingExpiresAt = 0;
let watchPartiesVisible = false;
let playerControlsTimer: ReturnType<typeof setTimeout> | null = null;
let playerViewportClickTimer: ReturnType<typeof setTimeout> | null = null;
let playbackFeatureRequestId = 0;
let playbackSegments: PlaybackMediaSegment[] = [];
let trickplayManifest: TrickplayManifest | null = null;
let trickplaySpriteTimer: ReturnType<typeof setTimeout> | null = null;
let trickplaySpriteRequestId = 0;
let trickplaySpriteUrls = new Map<number, string>();
let previewTargetTicks = 0;
let previewHovering = false;
let previewFocused = false;
let previewPendingUrl = "";
let volumeUpdateTimer: ReturnType<typeof setTimeout> | null = null;
let lastAudibleVolume = 100;
let soloDiagnosticsRefreshedAt = 0;
let licensesLastFocus: HTMLElement | null = null;
let cleanMachineDiagnosticsLastFocus: HTMLElement | null = null;
let playerSettingsLastFocus: HTMLElement | null = null;
let playerStructuralRenderKey = "";
let playerDrawerMode = window.matchMedia("(max-width: 1120px)").matches;
let offlinePlayableRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let playerAdapterPreference: PlaybackAdapterPreference | null = null;
let visibleCatalogRefreshInFlight = false;
let visibleCatalogRefreshQueued = false;
let dismissedPlaybackId: string | null = null;
let liveTvChannelSearchTimer: ReturnType<typeof setTimeout> | null = null;
const liveTvArtworkUrls = new Map<string, string>();
let miniGuideSelection = { channelId: "", programIndex: 0 };
let pendingGuideTarget: { programId: string; channelId: string; timeMs: number } | null = null;
const liveTvRecordedProgramIds = new Set<string>();

const CATALOG_REFRESH_INTERVAL_MS = 60_000;

document.title = BRANDING.productName;

function syncPlayerControlsPlacement(fullscreen = playerView.dataset.fullscreen === "true"): void {
  const overlay = fullscreen && playerAdapterPreference?.active === "libmpv";
  playerView.dataset.controlsOverlay = String(overlay);
  if (overlay && playerControls.parentElement !== playerFrame) {
    playerFrame.append(playerControls);
    schedulePlayerViewportSettled();
  } else if (!overlay && playerControls.parentElement !== playerCenter) {
    playerFrame.insertAdjacentElement("afterend", playerControls);
    schedulePlayerViewportSettled();
  }
}

function normalizeServerUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function setDiscoveryMessage(message: string, status = "idle"): void {
  discoveryMessage.textContent = message;
  discoveryDot.className = "discovery-dot";
  if (status !== "idle") discoveryDot.classList.add(`is-${status}`);
}

function selectDiscoveredServer(server: DiscoveredServer): void {
  serverUrlInput.value = server.address;
  setDiscoveryMessage(`${server.name} is ready at ${server.address}`, "found");
  renderDiscoveredServers();
  usernameInput.focus();
}

function renderDiscoveredServers(): void {
  serverResults.innerHTML = "";
  const selectedAddress = normalizeServerUrl(serverUrlInput.value);
  for (const server of state.discoveredServers) {
    const button = document.createElement("button");
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    const address = document.createElement("small");
    const status = document.createElement("span");

    button.type = "button";
    button.className = normalizeServerUrl(server.address) === selectedAddress
      ? "server-choice is-active"
      : "server-choice";
    button.addEventListener("click", () => selectDiscoveredServer(server));
    name.textContent = server.name || "Jellyfin Server";
    address.textContent = server.address;
    status.textContent = button.classList.contains("is-active") ? "Selected" : "Available";
    copy.append(name, address);
    button.append(copy, status);
    serverResults.append(button);
  }
}

async function discoverServers(): Promise<void> {
  discoverButton.disabled = true;
  setDiscoveryMessage("Searching the local network for Jellyfin...", "searching");
  serverResults.innerHTML = "";
  try {
    state.discoveredServers = await window.jellyfin.server.discover();
    renderDiscoveredServers();
    if (state.discoveredServers.length === 1) {
      selectDiscoveredServer(state.discoveredServers[0]);
    } else if (state.discoveredServers.length > 1) {
      setDiscoveryMessage(`Found ${state.discoveredServers.length} Jellyfin servers. Choose one.`, "found");
    } else {
      setDiscoveryMessage("No Jellyfin server answered. Enter its address manually.", "error");
    }
  } catch {
    state.discoveredServers = [];
    setDiscoveryMessage("Network search is unavailable. Enter the server address manually.", "error");
  } finally {
    discoverButton.disabled = false;
  }
}

function hasImage(item: MediaItem | null | undefined, kind: ImageKind): boolean {
  if (!item) return false;
  if (kind === "Backdrop") return Boolean(item.backdropImageTag);
  return Boolean(item.imageTags?.[kind]);
}

async function imageUrl(item: MediaItem, kind: ImageKind = "Primary", options: ImageOptions = {}): Promise<string> {
  if (!state.session || !item?.id || !hasImage(item, kind)) return "";
  const tag = kind === "Backdrop" ? item.backdropImageTag : item.imageTags?.[kind];
  return window.jellyfin.artwork.getUrl({
    itemId: item.id,
    kind,
    tag: tag || undefined,
    width: options.width || (kind === "Backdrop" ? 1600 : 500),
    height: options.height,
  });
}

async function personImageUrl(person: MediaPerson): Promise<string> {
  if (!state.session || !person.id || !person.primaryImageTag) return "";
  return window.jellyfin.artwork.getUrl({ itemId: person.id, kind: "Primary", tag: person.primaryImageTag, width: 280, height: 420 });
}

function setPersonImage(image: HTMLImageElement, fallback: HTMLElement, person: MediaPerson): void {
  fallback.textContent = initials(person.name);
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  void personImageUrl(person).then((url) => {
    if (!url || !image.isConnected) return;
    image.src = url;
    image.classList.remove("is-hidden");
    image.onerror = () => { image.removeAttribute("src"); image.classList.add("is-hidden"); };
  }).catch(() => undefined);
}

function createPersonCard(person: MediaPerson): HTMLButtonElement {
  const button = document.createElement("button");
  const portrait = document.createElement("span");
  const image = document.createElement("img");
  const fallback = document.createElement("span");
  const name = document.createElement("strong");
  const role = document.createElement("small");
  button.type = "button";
  button.className = "person-card";
  button.setAttribute("aria-label", [person.name, person.role, person.type !== "Actor" ? person.type : ""].filter(Boolean).join(", "));
  portrait.className = "person-portrait";
  fallback.className = "person-portrait-fallback";
  name.textContent = person.name;
  role.textContent = person.role || (person.type !== "Actor" ? person.type : "");
  role.classList.toggle("is-hidden", !role.textContent);
  portrait.append(image, fallback);
  setPersonImage(image, fallback, person);
  button.append(portrait, name, role);
  button.addEventListener("click", () => { void openPersonBrowse(person); });
  return button;
}

function preferredArtwork(item: MediaItem, shape: "poster" | "landscape"): ImageKind | "" {
  if (shape === "landscape") {
    if (hasImage(item, "Backdrop")) return "Backdrop";
    if (hasImage(item, "Thumb")) return "Thumb";
  }
  return hasImage(item, "Primary") ? "Primary" : "";
}

const imageRequestIds = new WeakMap<HTMLImageElement, number>();

function clearImage(image: HTMLImageElement, fallback: HTMLElement | null = null): void {
  imageRequestIds.set(image, (imageRequestIds.get(image) || 0) + 1);
  image.onload = null;
  image.onerror = null;
  image.removeAttribute("src");
  image.classList.remove("is-loading", "use-contain");
  image.classList.add("is-hidden");
  if (fallback) fallback.classList.remove("is-hidden");
}

async function setImage(
  image: HTMLImageElement,
  fallback: HTMLElement | null,
  item: MediaItem,
  kind: ImageKind | "",
  options: ImageOptions = {},
): Promise<void> {
  const requestId = (imageRequestIds.get(image) || 0) + 1;
  imageRequestIds.set(image, requestId);
  image.onload = null;
  image.onerror = null;
  image.removeAttribute("src");
  image.classList.remove("is-hidden");
  image.classList.add("is-loading");
  if (fallback) fallback.classList.remove("is-hidden");
  const url = kind ? await imageUrl(item, kind, options).catch(() => "") : "";
  if (imageRequestIds.get(image) !== requestId) return;
  if (!url) {
    image.classList.remove("is-loading");
    image.classList.add("is-hidden");
    return;
  }
  image.onload = () => {
    if (imageRequestIds.get(image) !== requestId) return;
    image.classList.remove("is-loading");
    if (fallback) fallback.classList.add("is-hidden");
  };
  image.onerror = () => {
    if (imageRequestIds.get(image) !== requestId) return;
    image.classList.remove("is-loading");
    image.classList.add("is-hidden");
    if (fallback) fallback.classList.remove("is-hidden");
  };
  image.src = url;
}

function initials(name = ""): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((word) => word[0].toUpperCase())
    .join("");
}

function itemYear(item: MediaItem | null | undefined): number | "" {
  return item?.productionYear || item?.premiereYear || "";
}

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string" && error.message) {
    return error.message;
  }
  return fallback;
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "";
}

function runtime(item: MediaItem | null | undefined): string {
  if (!item?.runTimeTicks) return "";
  const totalSeconds = Math.round(item.runTimeTicks / TICKS_PER_SECOND);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function episodeCode(item: MediaItem | null | undefined): string {
  const season = item?.parentIndexNumber;
  const episode = item?.indexNumber;
  if (season == null && episode == null) return "";
  return [season == null ? "" : `S${season}`, episode == null ? "" : `E${episode}`].filter(Boolean).join(" ");
}

function canPlay(item: MediaItem | null | undefined): boolean {
  return Boolean(item?.playable);
}

function itemCardTitle(item: MediaItem): string {
  return item?.type === "Episode" && item.seriesName ? item.seriesName : item?.name || "Untitled";
}

function itemCardSubtitle(item: MediaItem): string {
  if (item?.type === "Episode") {
    return [episodeCode(item), item.name].filter(Boolean).join(" - ");
  }
  const versionCount = item.mediaVersions?.length ?? 0;
  return [itemYear(item), runtime(item), versionCount > 1 ? `${versionCount} versions` : ""].filter(Boolean).join(" - ");
}

function selectedDetailVersion(): MediaVersion | null {
  if (detailVersionSelect.value === "auto") return null;
  const index = Number(detailVersionSelect.value);
  return Number.isSafeInteger(index) ? state.detailVersions[index] ?? null : null;
}

function renderDetailVersionControl(): void {
  const versions = state.detailVersions;
  const current = detailVersionSelect.value;
  detailVersionSelect.replaceChildren();
  const auto = document.createElement("option");
  auto.value = "auto";
  auto.textContent = "Auto / Best Available";
  detailVersionSelect.append(auto);
  versions.forEach((version, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = version.label;
    option.title = [version.container, version.size ? formatBytes(version.size) : ""].filter(Boolean).join(" • ");
    detailVersionSelect.append(option);
  });
  detailVersionSelect.value = [...detailVersionSelect.options].some((option) => option.value === current) ? current : "auto";
  const joined = Boolean(state.watchParties?.joinedGroup);
  if (joined) detailVersionSelect.value = "auto";
  detailVersionControl.classList.toggle("is-hidden", versions.length <= 1);
  detailVersionSelect.disabled = versions.length <= 1 || joined;
  detailVersionNote.textContent = joined && versions.length > 1
    ? "Specific versions are unavailable in a Watch Party; Auto keeps every participant on Jellyfin's shared item."
    : "";
}

function metadataParts(item: MediaItem): string[] {
  const parts: string[] = [];
  if (item?.type === "Episode" && item.seriesName) parts.push(item.seriesName);
  if (episodeCode(item)) parts.push(episodeCode(item));
  if (itemYear(item)) parts.push(String(itemYear(item)));
  if (item.officialRating) parts.push(item.officialRating);
  if (runtime(item)) parts.push(runtime(item));
  if (typeof item.communityRating === "number" && Number.isFinite(item.communityRating)) parts.push(`★ ${item.communityRating.toFixed(1)}`);
  return parts;
}

function showLogin(message = ""): void {
  loginView.classList.remove("is-hidden");
  mainView.classList.add("is-hidden");
  playerView.classList.add("is-hidden");
  document.body.classList.remove("is-playing");
  loginMessage.textContent = message;
}

function showMain(): void {
  if (!state.session?.authenticated || !state.session.user || !state.session.server) return;
  loginView.classList.add("is-hidden");
  mainView.classList.remove("is-hidden");
  userLabel.textContent = state.session.user.name;
  serverLabel.textContent = `${state.session.server.name} - ${state.session.server.address}`;
  profileInitial.textContent = (state.session.user.name || "J")[0].toUpperCase();
}

function setLoginMessage(message: string, isError = false): void {
  loginMessage.textContent = message;
  loginMessage.classList.toggle("is-error", isError);
}

function setButtonActive(button: HTMLButtonElement, active: boolean): void {
  button.classList.toggle("is-active", active);
  button.setAttribute("aria-current", active ? "page" : "false");
}

function setRoute(route: Route, options: { preserveScroll?: boolean; scrollTop?: number } = {}): void {
  const views = { home: homeView, library: libraryView, search: searchView, details: detailsView, "watch-parties": watchPartiesView, "live-tv": liveTvView };
  for (const [name, element] of Object.entries(views)) element.classList.toggle("is-hidden", name !== route);
  state.currentRoute = route;
  const nextWatchPartiesVisible = route === "watch-parties";
  if (nextWatchPartiesVisible !== watchPartiesVisible) {
    watchPartiesVisible = nextWatchPartiesVisible;
    void window.jellyfin.watchParties.setVisible({ visible: nextWatchPartiesVisible }).catch(() => undefined);
  }

  const desktopRoute = route === "details" ? state.returnRoute : route;
  setButtonActive(navHomeButton, desktopRoute === "home");
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-library-id]")) {
    setButtonActive(button, desktopRoute === "library" && button.dataset.libraryId === state.selectedLibraryId);
  }
  setButtonActive(navWatchPartiesButton, desktopRoute === "watch-parties");
  setButtonActive(navLiveTvButton, desktopRoute === "live-tv");
  setButtonActive(mobileHomeButton, desktopRoute === "home");
  setButtonActive(mobileSearchButton, desktopRoute === "search");
  setButtonActive(mobileLibraryButton, desktopRoute === "library");
  setButtonActive(mobileWatchPartiesButton, desktopRoute === "watch-parties");
  setButtonActive(mobileLiveTvButton, desktopRoute === "live-tv");

  if (!options.preserveScroll) contentScroller.scrollTop = options.scrollTop || 0;
}

function showToast(message: string): void {
  if (state.toastTimer) clearTimeout(state.toastTimer);
  toast.textContent = message;
  toast.classList.remove("is-hidden");
  state.toastTimer = setTimeout(() => toast.classList.add("is-hidden"), 3400);
}

function watchPartyStateLabel(value: string): string {
  if (value === "Playing") return "Playing";
  if (value === "Paused") return "Paused";
  if (value === "Waiting") return "Waiting for everyone";
  return "Idle";
}

function watchPartyPreparationLabel(phase: NonNullable<typeof state.watchParties>["preparation"]["phase"]): string {
  if (phase === "waiting-for-participant") return "Waiting for another participant";
  if (phase === "preparing") return "Preparing this computer";
  if (phase === "ready") return "This computer is ready—waiting for everyone";
  if (phase === "starting") return "Starting…";
  if (phase === "playing") return "Playing together";
  if (phase === "error") return "This computer could not prepare playback";
  return "Watch party joined";
}

function watchPartyOffsetLabel(offsetMilliseconds: number): string {
  return offsetMilliseconds === 0
    ? "In sync"
    : `${Math.abs(offsetMilliseconds)} ms ${offsetMilliseconds > 0 ? "earlier" : "later"}`;
}

function renderWatchParties(): void {
  const value = state.watchParties;
  watchPartyList.innerHTML = "";
  joinedWatchParty.innerHTML = "";
  joinedWatchParty.classList.add("is-hidden");
  const available = value?.availability === "available" && value.connection === "connected";
  createWatchPartyButton.disabled = !available;
  refreshWatchPartiesButton.disabled = value?.availability === "signed-out" || value?.availability === "connecting";

  if (!value || value.availability === "connecting") {
    watchPartyStatus.textContent = "Connecting to Jellyfin watch parties...";
    renderMessage(watchPartyList, "Loading active parties...");
    return;
  }
  if (value.error) watchPartyStatus.textContent = value.error.message;
  else if (value.joinedGroup) watchPartyStatus.textContent = "You are in a party. Playback controls are shared by everyone.";
  else watchPartyStatus.textContent = "Parties are visible only to signed-in users on this Jellyfin server.";

  if (value.joinedGroup) {
    const group = value.joinedGroup;
    joinedWatchParty.classList.remove("is-hidden");
    const heading = document.createElement("div");
    const copy = document.createElement("div");
    const eyebrow = document.createElement("span");
    const name = document.createElement("strong");
    const metadata = document.createElement("p");
    const leave = document.createElement("button");
    const resync = document.createElement("button");
    const actions = document.createElement("div");
    eyebrow.textContent = "Joined party";
    name.textContent = group.name;
    metadata.textContent = `${watchPartyStateLabel(group.playbackState)} - ${group.participantCount} participant${group.participantCount === 1 ? "" : "s"}`;
    leave.type = "button";
    leave.textContent = "Leave Party";
    leave.dataset.watchPartyAction = "leave";
    leave.addEventListener("click", () => { void leaveWatchParty(leave); });
    resync.type = "button";
    resync.textContent = "Resync Party";
    resync.title = "Move everyone to the current authoritative watchparty timeline";
    resync.dataset.watchPartyAction = "resync";
    resync.disabled = !available;
    resync.addEventListener("click", () => { void resyncWatchParty(resync); });
    copy.append(eyebrow, name, metadata);
    actions.className = "watch-party-actions";
    actions.append(resync, leave);
    heading.append(copy, actions);
    const participants = document.createElement("p");
    participants.textContent = group.participants.length ? `Watching with: ${group.participants.join(", ")}` : "Waiting for participants";
    const shared = document.createElement("p");
    shared.className = "shared-control-note";
    shared.textContent = "Shared controls: anyone can choose an item, play, pause, or seek.";
    const delivery = document.createElement("p");
    delivery.className = "watch-party-delivery-note";
    delivery.textContent = state.playbackSource === "local"
      ? "This computer: Local download"
      : state.playbackSource === "server"
        ? "This computer: Jellyfin stream"
        : "This computer: Waiting for shared media";
    const resyncAccess = document.createElement("p");
    resyncAccess.className = "watch-party-delivery-note";
    resyncAccess.textContent = "During playback, restore Seeing Stone from the taskbar or press Ctrl+R in the player to resync this computer.";
    joinedWatchParty.append(heading, participants, shared, delivery, resyncAccess);
  }

  if (!available) {
    renderMessage(watchPartyList, value.error?.message || "Watch parties are unavailable.");
    return;
  }
  if (value.groups.length === 0) {
    renderMessage(watchPartyList, "No active parties yet. Create one to start watching together.");
    return;
  }
  for (const group of value.groups) {
    const card = document.createElement("article");
    const copy = document.createElement("div");
    const name = document.createElement("h2");
    const status = document.createElement("p");
    const participants = document.createElement("p");
    const join = document.createElement("button");
    card.className = "watch-party-card";
    name.textContent = group.name;
    status.textContent = watchPartyStateLabel(group.playbackState);
    participants.textContent = group.participants.length
      ? `${group.participantCount} participant${group.participantCount === 1 ? "" : "s"}: ${group.participants.join(", ")}`
      : "No participants";
    join.type = "button";
    join.className = "primary";
    const alreadyJoined = value.joinedGroup?.groupId === group.groupId;
    join.textContent = alreadyJoined ? "Joined" : "Join Party";
    join.disabled = alreadyJoined;
    join.addEventListener("click", () => { void joinWatchParty(group.groupId, join); });
    copy.append(name, status, participants);
    card.append(copy, join);
    watchPartyList.append(card);
  }
}

async function refreshWatchParties(): Promise<void> {
  try {
    state.watchParties = await window.jellyfin.watchParties.list();
    renderWatchParties();
  } catch (error) {
    showToast(errorMessage(error, "Watch parties could not be refreshed."));
  }
}

async function openWatchParties(): Promise<void> {
  profileMenu.classList.add("is-hidden");
  profileButton.setAttribute("aria-expanded", "false");
  setRoute("watch-parties");
  await refreshWatchParties();
}

function liveTvTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function liveTvDateTime(value: string | null): string {
  if (!value) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function liveTvDay(value: string): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(new Date(value));
}

function setLiveTvTab(tab: LiveTvTab): void {
  state.liveTvTab = tab;
  setButtonActive(liveTvGuideTab, tab === "guide");
  setButtonActive(liveTvRecordingsTab, tab === "recordings");
  setButtonActive(liveTvScheduledTab, tab === "scheduled");
  liveTvGuideTools.classList.toggle("is-hidden", tab !== "guide");
  renderLiveTv();
}

function liveChannelItem(channelId: string, name: string): MediaItem {
  return {
    id: channelId, name, type: "TvChannel", overview: "", productionYear: null, premiereYear: null,
    officialRating: null, communityRating: null, runTimeTicks: 0, genres: [], people: [], primaryImageAspectRatio: null,
    imageTags: {}, backdropImageTag: null, parentThumbItemId: null, parentThumbImageTag: null,
    seriesId: null, seriesName: null, seasonId: null, indexNumber: null, parentIndexNumber: null,
    userData: { played: false, playbackPositionTicks: 0, playedPercentage: 0 }, hasTrailer: false, playable: true,
  };
}

async function watchLive(channelId: string): Promise<void> {
  const channel = state.liveTvGuide?.channels.find((entry) => entry.id === channelId);
  const program = state.liveTvGuide?.programs.find((entry) => entry.channelId === channelId
    && Date.parse(entry.startUtc) <= Date.now() && Date.parse(entry.endUtc) > Date.now());
  await startPresentedPlayback({
    item: liveChannelItem(channelId, channel?.name || "Live TV"),
    itemId: channelId,
    resumeMode: "start-over",
    title: program?.name || channel?.name || "Live TV",
    meta: ["LIVE", channel?.number, channel?.name].filter(Boolean).join(" · "),
    failureMessage: "The live channel could not be started.",
    liveChannelId: channelId,
  });
}

async function changeLiveChannel(offset: number): Promise<void> {
  const channels = state.liveTvGuide?.channels || [];
  const currentId = state.playbackItem?.type === "TvChannel" ? state.playbackItem.id : "";
  const currentIndex = channels.findIndex((channel) => channel.id === currentId);
  if (!channels.length) return;
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + offset + channels.length) % channels.length;
  await watchLive(channels[nextIndex].id);
}

function programsByLiveTvChannel(guide: LiveTvGuide): Map<string, LiveTvProgram[]> {
  const grouped = new Map<string, LiveTvProgram[]>();
  for (const program of guide.programs) {
    const entries = grouped.get(program.channelId);
    if (entries) entries.push(program);
    else grouped.set(program.channelId, [program]);
  }
  for (const entries of grouped.values()) entries.sort((left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc));
  return grouped;
}

function setLiveTvChannelLogo(image: HTMLImageElement, fallback: HTMLElement, channel: LiveTvGuide["channels"][number], width: number, height: number): void {
  fallback.textContent = initials(channel.name);
  image.alt = `${channel.name} logo`;
  // These are small, visible identity assets. Chromium's lazy loader may discard and
  // later restart a no-store custom-protocol request while this scroll container moves.
  // Keep each session-scoped artwork reference eagerly loaded for the life of this row.
  image.loading = "eager";
  image.decoding = "async";
  if (!channel.imageTag) return;
  const key = `${channel.id}:${channel.imageTag}:${width}x${height}`;
  const apply = (url: string): void => {
    if (!url || !image.isConnected) return;
    image.src = url;
    image.classList.remove("is-hidden");
    fallback.classList.add("is-hidden");
    image.onerror = () => { image.removeAttribute("src"); image.classList.add("is-hidden"); fallback.classList.remove("is-hidden"); };
  };
  const cached = liveTvArtworkUrls.get(key);
  if (cached) { apply(cached); return; }
  void window.jellyfin.artwork.getUrl({ itemId: channel.id, kind: "Primary", tag: channel.imageTag, width, height })
    .then((url) => { if (url) liveTvArtworkUrls.set(key, url); apply(url); })
    .catch(() => undefined);
}

function createLiveTvChannelIdentity(channel: LiveTvGuide["channels"][number], compact = false): HTMLButtonElement {
  const button = document.createElement("button");
  const number = document.createElement("span");
  const logoBox = document.createElement("span");
  const image = document.createElement("img");
  const fallback = document.createElement("span");
  const copy = document.createElement("span");
  const name = document.createElement("strong");
  button.type = "button";
  button.className = compact ? "mini-guide-channel" : "live-tv-channel";
  button.title = `Watch ${[channel.number, channel.name].filter(Boolean).join(" ")}`;
  button.setAttribute("aria-label", button.title);
  number.className = "live-tv-channel-number";
  number.textContent = channel.number || "–";
  logoBox.className = "live-tv-channel-logo";
  fallback.className = "live-tv-channel-fallback";
  image.className = "is-hidden";
  copy.className = "live-tv-channel-copy";
  name.textContent = channel.name;
  copy.append(name);
  if (channel.isFavorite) {
    const favorite = document.createElement("span");
    favorite.className = "live-tv-favorite";
    favorite.textContent = "♥";
    favorite.setAttribute("aria-label", "Favorite channel");
    copy.append(favorite);
  }
  logoBox.append(image, fallback);
  button.append(number, logoBox, copy);
  setLiveTvChannelLogo(image, fallback, channel, compact ? 72 : 160, compact ? 42 : 84);
  button.addEventListener("click", () => { void watchLive(channel.id); });
  return button;
}

function closePlayerMiniGuide(restoreFocus = false): void {
  if (playerMiniGuide.classList.contains("is-hidden")) return;
  playerMiniGuide.classList.add("is-hidden");
  playerMiniGuideButton.setAttribute("aria-expanded", "false");
  if (restoreFocus) playerMiniGuideButton.focus({ preventScroll: true });
  markPlayerActivity();
}

function miniGuidePrograms(channelId: string, guide: LiveTvGuide, start = Date.parse(guide.windowStartUtc), end = Date.parse(guide.windowEndUtc)): LiveTvProgram[] {
  return (programsByLiveTvChannel(guide).get(channelId) || []).filter((program) => placeProgramInWindow(program, start, end));
}

function initialMiniGuideProgramIndex(channelId: string, guide: LiveTvGuide, now = Date.now()): number {
  const start = Math.max(Date.parse(guide.windowStartUtc), Math.floor(now / LIVE_TV_HALF_HOUR_MS) * LIVE_TV_HALF_HOUR_MS);
  const programs = miniGuidePrograms(channelId, guide, start, Math.min(Date.parse(guide.windowEndUtc), start + 2 * 60 * 60_000));
  return Math.max(0, programs.findIndex((program) => isCurrentProgram(program, now)));
}

function renderPlayerMiniGuide(): void {
  const guide = state.liveTvGuide;
  if (!guide || guide.status.availability !== "available") return;
  const now = Date.now();
  const start = Date.parse(guide.windowStartUtc);
  const end = Date.parse(guide.windowEndUtc);
  const miniStart = Math.max(start, Math.floor(now / LIVE_TV_HALF_HOUR_MS) * LIVE_TV_HALF_HOUR_MS);
  const miniEnd = Math.min(end, miniStart + 2 * 60 * 60_000);
  const marker = currentTimeMarkerPercent(now, miniStart, miniEnd);
  const channels = guide.channels;
  if (!channels.length) return;
  if (!channels.some((channel) => channel.id === miniGuideSelection.channelId)) {
    miniGuideSelection = { channelId: state.playbackItem?.id || channels[0].id, programIndex: 0 };
  }
  const selectedPrograms = miniGuidePrograms(miniGuideSelection.channelId, guide, miniStart, miniEnd);
  miniGuideSelection.programIndex = Math.max(0, Math.min(miniGuideSelection.programIndex, Math.max(0, selectedPrograms.length - 1)));
  const visible = visibleChannelSlice(channels, miniGuideSelection.channelId, 5);
  const labelTimes = timeAxisLabels(miniStart, miniEnd);
  playerMiniGuide.replaceChildren();
  playerMiniGuide.style.setProperty("--live-tv-now", marker === null ? "-10" : String(marker));
  const header = document.createElement("header");
  const title = document.createElement("strong");
  const hint = document.createElement("span");
  const fullGuide = document.createElement("button");
  title.textContent = "Seeing Stone · Mini Guide";
  hint.textContent = "↑↓ Channels · ←→ Programs · Enter Watch · Esc Close";
  fullGuide.type = "button";
  fullGuide.className = "mini-guide-full";
  fullGuide.textContent = "Full Guide";
  fullGuide.addEventListener("click", () => { void closePlayer().then(openLiveTv); });
  header.append(title, hint, fullGuide);
  const axis = document.createElement("div");
  axis.className = "mini-guide-axis";
  const blank = document.createElement("span");
  blank.textContent = "Channels";
  axis.append(blank);
  for (const value of labelTimes) {
    const label = document.createElement("span");
    label.textContent = liveTvTime(new Date(value).toISOString());
    axis.append(label);
  }
  const body = document.createElement("div");
  body.className = "mini-guide-body";
  const grouped = programsByLiveTvChannel(guide);
  for (const channel of visible) {
    const row = document.createElement("div");
    row.className = "mini-guide-row";
    row.classList.toggle("is-playing", channel.id === state.playbackItem?.id);
    const track = document.createElement("div");
    track.className = "mini-guide-track";
    track.style.setProperty("--live-tv-now", marker === null ? "-10" : String(marker));
    for (const program of grouped.get(channel.id) || []) {
      const placement = placeProgramInWindow(program, miniStart, miniEnd);
      if (!placement) continue;
      const button = document.createElement("button");
      const selected = channel.id === miniGuideSelection.channelId && program === selectedPrograms[miniGuideSelection.programIndex];
      button.type = "button";
      button.className = "mini-guide-program";
      button.classList.toggle("is-selected", selected);
      button.classList.toggle("is-current", isCurrentProgram(program, now));
      button.style.left = `${placement.leftPercent}%`;
      button.style.width = `${placement.widthPercent}%`;
      button.textContent = program.name;
      button.title = `${program.name}, ${liveTvTime(program.startUtc)} to ${liveTvTime(program.endUtc)}`;
      button.setAttribute("aria-label", button.title);
      button.addEventListener("click", () => { miniGuideSelection = { channelId: channel.id, programIndex: miniGuidePrograms(channel.id, guide, miniStart, miniEnd).indexOf(program) }; void watchLive(channel.id); closePlayerMiniGuide(); });
      track.append(button);
    }
    row.append(createLiveTvChannelIdentity(channel, true), track);
    body.append(row);
  }
  playerMiniGuide.append(header, axis, body);
}

function togglePlayerMiniGuide(): void {
  const livePlayback = state.playbackItem?.type === "TvChannel" || playbackForPlayer()?.contentKind === "live-tv";
  if (!livePlayback) { showToast("Mini Guide is available while watching Live TV."); return; }
  if (!playerMiniGuide.classList.contains("is-hidden")) { closePlayerMiniGuide(true); return; }
  const open = (): void => {
    const channels = state.liveTvGuide?.channels || [];
    const channelId = state.playbackItem?.id || channels[0]?.id || "";
    miniGuideSelection = { channelId, programIndex: channelId ? initialMiniGuideProgramIndex(channelId, state.liveTvGuide as LiveTvGuide) : 0 };
    playerMiniGuide.classList.remove("is-hidden");
    playerMiniGuideButton.setAttribute("aria-expanded", "true");
    keepPlayerControlsVisible();
    renderPlayerMiniGuide();
    playerMiniGuide.focus({ preventScroll: true });
  };
  if (state.liveTvGuide?.status.availability === "available") open();
  else void refreshLiveTv(false).then(open).catch(() => showToast("Live TV guide is unavailable."));
}

function handlePlayerMiniGuideKey(event: KeyboardEvent): boolean {
  if (playerMiniGuide.classList.contains("is-hidden")) return false;
  const guide = state.liveTvGuide;
  if (!guide || !guide.channels.length) return false;
  const currentIndex = Math.max(0, guide.channels.findIndex((channel) => channel.id === miniGuideSelection.channelId));
  if (event.key === "Escape") { event.preventDefault(); closePlayerMiniGuide(true); return true; }
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault();
    const direction = event.key === "ArrowUp" ? -1 : 1;
    const next = (currentIndex + direction + guide.channels.length) % guide.channels.length;
    const channelId = guide.channels[next].id;
    miniGuideSelection = { channelId, programIndex: initialMiniGuideProgramIndex(channelId, guide) };
    renderPlayerMiniGuide();
    playerMiniGuide.focus({ preventScroll: true });
    return true;
  }
  const now = Date.now();
  const miniStart = Math.max(Date.parse(guide.windowStartUtc), Math.floor(now / LIVE_TV_HALF_HOUR_MS) * LIVE_TV_HALF_HOUR_MS);
  const programs = miniGuidePrograms(miniGuideSelection.channelId, guide, miniStart, Math.min(Date.parse(guide.windowEndUtc), miniStart + 2 * 60 * 60_000));
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    if (programs.length) {
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      miniGuideSelection.programIndex = (miniGuideSelection.programIndex + direction + programs.length) % programs.length;
      renderPlayerMiniGuide();
      playerMiniGuide.focus({ preventScroll: true });
    }
    return true;
  }
  if (event.key === "Enter" && !(event.target instanceof Element && event.target.closest("button"))) {
    event.preventDefault();
    void watchLive(miniGuideSelection.channelId);
    closePlayerMiniGuide();
    return true;
  }
  return false;
}

async function recordProgram(program: LiveTvProgram, series: boolean, options: { prePaddingSeconds?: number; postPaddingSeconds?: number } = {}): Promise<void> {
  try {
    await window.jellyfin.liveTv.createRecording({ programId: program.id, series, options });
    liveTvRecordedProgramIds.add(program.id);
    showToast(series ? "Series recording scheduled." : "Recording scheduled.");
    await refreshLiveTv(false);
  } catch (error) {
    showToast(errorMessage(error, "The recording could not be scheduled."));
  }
}

function showProgramDetails(program: LiveTvProgram): void {
  const existing = liveTvContent.querySelector(".live-tv-program-details");
  existing?.remove();
  const panel = document.createElement("section");
  panel.className = "live-tv-program-details";
  const copy = document.createElement("div");
  const title = document.createElement("h2");
  const meta = document.createElement("p");
  const overview = document.createElement("p");
  title.textContent = program.name;
  meta.textContent = `${liveTvTime(program.startUtc)}–${liveTvTime(program.endUtc)}${program.isLive ? " · Live" : ""}`;
  overview.textContent = program.overview || program.episodeTitle || "No program description is available.";
  copy.append(title, meta, overview);
  const actions = document.createElement("div");
  actions.className = "live-tv-program-actions";
  const watch = document.createElement("button");
  watch.className = "primary";
  watch.textContent = "Watch Live";
  watch.addEventListener("click", () => { void watchLive(program.channelId); });
  const record = document.createElement("button");
  record.textContent = program.timerId ? "Cancel Recording" : "Record";
  record.addEventListener("click", () => {
    if (!program.timerId) { void recordProgram(program, false); return; }
    if (!window.confirm(`Cancel the recording for “${program.name}”?`)) return;
    void window.jellyfin.liveTv.cancelSchedule({ id: program.timerId, series: false })
      .then(() => refreshLiveTv(false))
      .catch((error) => showToast(errorMessage(error, "The recording could not be canceled.")));
  });
  const series = document.createElement("button");
  series.textContent = program.seriesTimerId ? "Cancel Series" : "Record Series";
  series.disabled = !program.isSeries;
  series.addEventListener("click", () => {
    if (!program.seriesTimerId) { void recordProgram(program, true); return; }
    if (!window.confirm(`Cancel the series rule for “${program.name}”?`)) return;
    void window.jellyfin.liveTv.cancelSchedule({ id: program.seriesTimerId, series: true })
      .then(() => refreshLiveTv(false))
      .catch((error) => showToast(errorMessage(error, "The series rule could not be canceled.")));
  });
  const advanced = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Advanced";
  const pre = document.createElement("input");
  const post = document.createElement("input");
  for (const input of [pre, post]) { input.type = "number"; input.min = "0"; input.max = "1440"; input.value = "0"; }
  pre.setAttribute("aria-label", "Minutes before");
  post.setAttribute("aria-label", "Minutes after");
  const advancedRecord = document.createElement("button");
  advancedRecord.textContent = "Record with padding";
  advancedRecord.addEventListener("click", () => {
    void recordProgram(program, false, {
      prePaddingSeconds: Math.max(0, Number(pre.value) || 0) * 60,
      postPaddingSeconds: Math.max(0, Number(post.value) || 0) * 60,
    });
  });
  const labels = document.createElement("span");
  labels.textContent = "Minutes before / after";
  advanced.append(summary, labels, pre, post, advancedRecord);
  actions.append(watch, record, series, advanced);
  panel.append(copy, actions);
  liveTvContent.prepend(panel);
}

function guideWindowForTime(timeMs: number): { startUtc: string; endUtc: string } {
  const start = Math.floor(timeMs / LIVE_TV_HALF_HOUR_MS) * LIVE_TV_HALF_HOUR_MS - LIVE_TV_HALF_HOUR_MS;
  return { startUtc: new Date(start).toISOString(), endUtc: new Date(start + LIVE_TV_GUIDE_WINDOW_MS).toISOString() };
}

function scrollLiveTvGuideToTime(timeMs: number, behavior: ScrollBehavior = "smooth"): void {
  const guide = state.liveTvGuide;
  const grid = liveTvContent.querySelector<HTMLElement>(".live-tv-grid");
  const track = grid?.querySelector<HTMLElement>(".live-tv-track");
  if (!guide || !grid || !track) return;
  const target = guideScrollLeftForTime(timeMs, Date.parse(guide.windowStartUtc), track.offsetLeft, grid.clientWidth);
  grid.scrollTo({ left: Math.min(target, Math.max(0, grid.scrollWidth - grid.clientWidth)), behavior });
}

function focusPendingGuideTarget(): void {
  const target = pendingGuideTarget;
  if (!target) return;
  pendingGuideTarget = null;
  requestAnimationFrame(() => {
    const grid = liveTvContent.querySelector<HTMLElement>(".live-tv-grid");
    const row = Array.from(liveTvContent.querySelectorAll<HTMLElement>(".live-tv-row"))
      .find((entry) => entry.dataset.liveTvChannelId === target.channelId);
    const program = Array.from(liveTvContent.querySelectorAll<HTMLButtonElement>(".live-tv-program"))
      .find((entry) => entry.dataset.liveTvProgramId === target.programId);
    if (grid && row) {
      const gridBounds = grid.getBoundingClientRect();
      const rowBounds = row.getBoundingClientRect();
      const top = grid.scrollTop + rowBounds.top - gridBounds.top - (grid.clientHeight - rowBounds.height) / 2;
      grid.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    }
    if (grid) scrollLiveTvGuideToTime(target.timeMs);
    if (program) {
      program.classList.add("is-guide-target");
      program.focus({ preventScroll: true });
      window.setTimeout(() => program.classList.remove("is-guide-target"), 3_000);
    }
  });
}

async function viewProgramInGuide(result: LiveTvProgramSearch["programs"][number]): Promise<void> {
  const timeMs = Date.parse(result.program.startUtc);
  pendingGuideTarget = { programId: result.program.id, channelId: result.channel.id, timeMs };
  state.liveTvChannelQuery = "";
  liveTvChannelSearch.value = "";
  state.liveTvProgramSearch = null;
  state.liveTvProgramSearchRequestId += 1;
  setLiveTvTab("guide");
  const guide = state.liveTvGuide;
  if (guide && timeMs >= Date.parse(guide.windowStartUtc) && timeMs < Date.parse(guide.windowEndUtc)) {
    renderLiveTv();
    focusPendingGuideTarget();
    return;
  }
  await refreshLiveTv(true, guideWindowForTime(timeMs));
}

function createLiveTvSearchProgramResult(result: LiveTvProgramSearch["programs"][number]): HTMLElement {
  const { program, channel } = result;
  const card = document.createElement("article");
  const identity = document.createElement("div");
  const number = document.createElement("span");
  const logoBox = document.createElement("span");
  const image = document.createElement("img");
  const fallback = document.createElement("span");
  const copy = document.createElement("div");
  const title = document.createElement("h3");
  const episode = document.createElement("p");
  const metadata = document.createElement("p");
  const actions = document.createElement("div");
  const now = Date.now();
  const current = isCurrentProgram(program, now);
  card.className = "live-tv-search-program";
  identity.className = "live-tv-search-channel";
  number.className = "live-tv-channel-number";
  number.textContent = channel.number || "–";
  logoBox.className = "live-tv-channel-logo";
  image.className = "is-hidden";
  fallback.className = "live-tv-channel-fallback";
  logoBox.append(image, fallback);
  // Match the full-guide dimensions so an already-resolved opaque artwork URL
  // can be reused when the same channel appears in search results.
  setLiveTvChannelLogo(image, fallback, channel, 160, 84);
  identity.append(number, logoBox);
  title.textContent = program.name;
  episode.textContent = program.episodeTitle || "";
  episode.classList.toggle("is-hidden", !program.episodeTitle);
  metadata.textContent = `${[channel.number, channel.name].filter(Boolean).join(" · ")} · ${liveTvDateTime(program.startUtc)}–${liveTvTime(program.endUtc)}`;
  copy.append(title, episode, metadata);
  if (current) {
    const nowBadge = document.createElement("span");
    nowBadge.className = "live-tv-search-badge";
    nowBadge.textContent = program.isLive ? "LIVE" : "NOW";
    copy.append(nowBadge);
  }
  if (program.timerId || liveTvRecordedProgramIds.has(program.id)) {
    const scheduled = document.createElement("span");
    scheduled.className = "live-tv-search-badge is-scheduled";
    scheduled.textContent = "Scheduled";
    copy.append(scheduled);
  }
  if (current) {
    const watch = document.createElement("button");
    watch.type = "button";
    watch.className = "primary";
    watch.textContent = "Watch";
    watch.setAttribute("aria-label", `Watch ${program.name} on ${channel.name}`);
    watch.addEventListener("click", () => { void watchLive(channel.id); });
    actions.append(watch);
  }
  const record = document.createElement("button");
  record.type = "button";
  record.textContent = program.timerId || liveTvRecordedProgramIds.has(program.id) ? "Scheduled" : "Record";
  record.disabled = Boolean(program.timerId || liveTvRecordedProgramIds.has(program.id));
  record.setAttribute("aria-label", `Record ${program.name} on ${channel.name}`);
  record.addEventListener("click", () => { void recordProgram(program, false); });
  const series = document.createElement("button");
  series.type = "button";
  series.textContent = program.seriesTimerId ? "Series Scheduled" : "Record Series";
  series.disabled = !program.isSeries || Boolean(program.seriesTimerId);
  series.setAttribute("aria-label", `Record series for ${program.name} on ${channel.name}`);
  series.addEventListener("click", () => { void recordProgram(program, true); });
  const guide = document.createElement("button");
  guide.type = "button";
  guide.textContent = "View in Guide";
  guide.setAttribute("aria-label", `View ${program.name} on ${channel.name} in the guide`);
  guide.addEventListener("click", () => { void viewProgramInGuide(result); });
  actions.append(record, series, guide);
  card.append(identity, copy, actions);
  return card;
}

function renderLiveTvSearchResults(): void {
  const search = state.liveTvProgramSearch;
  const query = state.liveTvChannelQuery.trim();
  if (!search) {
    renderMessage(liveTvContent, `Searching Live TV for “${query}”…`);
    return;
  }
  liveTvChannelSearchStatus.textContent = `${search.channels.length} channel matches · ${search.programs.length} program airings${search.truncated ? " (results capped for this server)" : ""}`;
  if (!search.channels.length && !search.programs.length) {
    renderMessage(liveTvContent, `No channels or programs match “${query}” in the available guide.`);
    return;
  }
  const now = Date.now();
  const appendSection = (title: string, entries: HTMLElement[]): void => {
    if (!entries.length) return;
    const section = document.createElement("section");
    const heading = document.createElement("h2");
    const list = document.createElement("div");
    section.className = "live-tv-search-section";
    heading.textContent = title;
    list.className = "live-tv-search-list";
    list.append(...entries);
    section.append(heading, list);
    liveTvContent.append(section);
  };
  appendSection("Channels", search.channels.map((channel) => createLiveTvChannelIdentity(channel)));
  appendSection("On Now", search.programs.filter((entry) => isCurrentProgram(entry.program, now)).map(createLiveTvSearchProgramResult));
  appendSection("Upcoming", search.programs.filter((entry) => Date.parse(entry.program.startUtc) > now).map(createLiveTvSearchProgramResult));
}

async function runLiveTvSearch(query: string): Promise<void> {
  const normalized = query.trim();
  const requestId = ++state.liveTvProgramSearchRequestId;
  if (normalized.length < 2) {
    state.liveTvProgramSearch = null;
    renderLiveTv();
    return;
  }
  state.liveTvProgramSearch = null;
  renderLiveTv();
  try {
    const result = await window.jellyfin.liveTv.searchPrograms({ query: normalized });
    if (requestId !== state.liveTvProgramSearchRequestId || state.liveTvChannelQuery.trim() !== normalized) return;
    state.liveTvProgramSearch = result;
    renderLiveTv();
  } catch (error) {
    if (requestId !== state.liveTvProgramSearchRequestId) return;
    liveTvChannelSearchStatus.textContent = errorMessage(error, "Live TV search is unavailable.");
    renderMessage(liveTvContent, "Live TV search could not be completed. Try again.");
  }
}

function renderLiveTvGuide(): void {
  const guide = state.liveTvGuide;
  if (!guide || guide.status.availability !== "available") {
    liveTvChannelSearchStatus.textContent = "";
    const empty = document.createElement("section");
    empty.className = "live-tv-empty";
    const title = document.createElement("h2");
    const text = document.createElement("p");
    title.textContent = guide?.status.availability === "forbidden" ? "Live TV permission required" : "Set up Live TV in Jellyfin";
    text.textContent = guide?.status.message || "Add an M3U or HDHomeRun tuner and XMLTV guide in the Jellyfin dashboard, then refresh this screen.";
    empty.append(title, text);
    liveTvContent.append(empty);
    return;
  }
  if (state.liveTvChannelQuery.trim().length >= 2) {
    renderLiveTvSearchResults();
    return;
  }
  const start = Date.parse(guide.windowStartUtc);
  const end = Date.parse(guide.windowEndUtc);
  const query = state.liveTvChannelQuery.trim().toLocaleLowerCase();
  const queryTerms = query.split(/\s+/).filter(Boolean);
  const matchingChannels = queryTerms.length
    ? guide.channels.filter((channel) => {
      const searchable = `${channel.number ?? ""} ${channel.name}`.toLocaleLowerCase();
      return queryTerms.every((term) => searchable.includes(term));
    })
    : guide.channels;
  const visibleChannels = matchingChannels.slice(0, 300);
  liveTvChannelSearchStatus.textContent = matchingChannels.length > visibleChannels.length
    ? `Showing ${visibleChannels.length.toLocaleString()} of ${matchingChannels.length.toLocaleString()} matching channels. Refine your search to see more.`
    : `${matchingChannels.length.toLocaleString()} ${matchingChannels.length === 1 ? "channel" : "channels"}`;
  if (!matchingChannels.length) {
    renderMessage(liveTvContent, `No channels match “${state.liveTvChannelQuery.trim()}”.`);
    return;
  }
  const programsByChannel = programsByLiveTvChannel(guide);
  const now = Date.now();
  const marker = currentTimeMarkerPercent(now, start, end);
  const labels = timeAxisLabels(start, end);
  const grid = document.createElement("div");
  grid.className = "live-tv-grid";
  grid.style.setProperty("--live-tv-columns", String(Math.max(1, labels.length)));
  grid.style.setProperty("--live-tv-track-width", `${Math.max(1, labels.length) * LIVE_TV_HALF_HOUR_PX}px`);
  const axis = document.createElement("div");
  axis.className = "live-tv-axis";
  const axisChannel = document.createElement("span");
  axisChannel.className = "live-tv-axis-channel";
  axisChannel.textContent = "Channels";
  const axisTrack = document.createElement("div");
  axisTrack.className = "live-tv-axis-track";
  for (const [index, time] of labels.entries()) {
    const label = document.createElement("span");
    const timestamp = new Date(time).toISOString();
    if (index === 0 || isLocalDateTransition(labels[index - 1], time)) {
      const day = document.createElement("b");
      day.textContent = liveTvDay(timestamp);
      label.classList.add("is-date-transition");
      label.append(day);
    }
    const timeLabel = document.createElement("time");
    timeLabel.dateTime = timestamp;
    timeLabel.textContent = liveTvTime(timestamp);
    label.append(timeLabel);
    axisTrack.append(label);
  }
  if (marker !== null) {
    const nowLabel = document.createElement("span");
    nowLabel.className = "live-tv-now-label";
    nowLabel.style.left = `${marker}%`;
    nowLabel.textContent = liveTvTime(new Date(now).toISOString());
    axisTrack.append(nowLabel);
  }
  axis.append(axisChannel, axisTrack);
  grid.append(axis);
  for (const channel of visibleChannels) {
    const row = document.createElement("section");
    row.className = "live-tv-row";
    row.dataset.liveTvChannelId = channel.id;
    const track = document.createElement("div");
    track.className = "live-tv-track";
    track.style.setProperty("--live-tv-now", marker === null ? "-10" : String(marker));
    for (const program of programsByChannel.get(channel.id) ?? []) {
      const placement = placeProgramInWindow(program, start, end);
      if (!placement) continue;
      const cell = document.createElement("button");
      cell.className = "live-tv-program";
      cell.style.left = `${placement.leftPercent}%`;
      cell.style.width = `${placement.widthPercent}%`;
      const title = document.createElement("strong");
      const meta = document.createElement("span");
      title.textContent = program.name;
      meta.textContent = `${liveTvTime(program.startUtc)}–${liveTvTime(program.endUtc)}`;
      cell.append(title, meta);
      cell.title = `${program.name}, ${liveTvTime(program.startUtc)} to ${liveTvTime(program.endUtc)}`;
      cell.setAttribute("aria-label", cell.title);
      cell.dataset.liveTvStart = program.startUtc;
      cell.dataset.liveTvEnd = program.endUtc;
      cell.dataset.liveTvProgramId = program.id;
      if (isCurrentProgram(program, now)) cell.classList.add("is-current");
      if (program.isLive) {
        const badge = document.createElement("em");
        badge.textContent = "LIVE";
        cell.append(badge);
      }
      cell.addEventListener("click", () => showProgramDetails(program));
      track.append(cell);
    }
    row.append(createLiveTvChannelIdentity(channel), track);
    grid.append(row);
  }
  liveTvContent.append(grid);
  focusPendingGuideTarget();
}

function renderLiveTvRecordings(): void {
  if (!state.liveTvRecordings.length) { renderMessage(liveTvContent, "No completed recordings yet."); return; }
  const list = document.createElement("div");
  list.className = "live-tv-card-list";
  for (const recording of state.liveTvRecordings) {
    const card = document.createElement("article");
    const copy = document.createElement("div");
    const title = document.createElement("h2");
    const meta = document.createElement("p");
    title.textContent = recording.name;
    meta.textContent = [recording.channelName, liveTvDateTime(recording.startUtc), recording.status].filter(Boolean).join(" · ");
    copy.append(title, meta);
    const play = document.createElement("button");
    play.className = "primary"; play.textContent = "Play";
    play.addEventListener("click", () => { void playItem(recording.item); });
    const remove = document.createElement("button");
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Delete “${recording.name}”? This cannot be undone.`)) return;
      await window.jellyfin.liveTv.deleteRecording({ recordingId: recording.id });
      await refreshLiveTv(false);
    });
    card.append(copy, play, remove);
    list.append(card);
  }
  liveTvContent.append(list);
}

function renderLiveTvSchedules(): void {
  const entries = [
    ...state.liveTvTimers.map((timer) => ({ id: timer.id, series: false, name: timer.name, meta: `${liveTvDateTime(timer.startUtc)} · ${timer.status}` })),
    ...state.liveTvSeriesTimers.map((timer) => ({ id: timer.id, series: true, name: timer.name, meta: "Series rule" })),
  ];
  if (!entries.length) { renderMessage(liveTvContent, "No scheduled recordings."); return; }
  const list = document.createElement("div");
  list.className = "live-tv-card-list";
  for (const entry of entries) {
    const card = document.createElement("article");
    const copy = document.createElement("div");
    const title = document.createElement("h2"); title.textContent = entry.name;
    const meta = document.createElement("p"); meta.textContent = entry.meta;
    copy.append(title, meta);
    const cancel = document.createElement("button"); cancel.textContent = "Cancel";
    cancel.addEventListener("click", async () => {
      if (!window.confirm(`Cancel “${entry.name}”?`)) return;
      await window.jellyfin.liveTv.cancelSchedule({ id: entry.id, series: entry.series });
      await refreshLiveTv(false);
    });
    const edit = document.createElement("button"); edit.textContent = "Edit";
    edit.addEventListener("click", async () => {
      const pre = window.prompt("Minutes to record before the program:", "0");
      if (pre === null) return;
      const post = window.prompt("Minutes to record after the program:", "0");
      if (post === null) return;
      try {
        await window.jellyfin.liveTv.updateSchedule({
          id: entry.id,
          series: entry.series,
          options: {
            prePaddingSeconds: Math.max(0, Math.min(1440, Number(pre) || 0)) * 60,
            postPaddingSeconds: Math.max(0, Math.min(1440, Number(post) || 0)) * 60,
          },
        });
        showToast("Recording schedule updated.");
        await refreshLiveTv(false);
      } catch (error) {
        showToast(errorMessage(error, "The schedule could not be updated."));
      }
    });
    card.append(copy, edit, cancel); list.append(card);
  }
  liveTvContent.append(list);
}

function renderLiveTv(): void {
  liveTvContent.innerHTML = "";
  liveTvGuideTools.classList.toggle("is-hidden", state.liveTvTab !== "guide");
  liveTvStatus.textContent = state.liveTvGuide
    ? `Guide updated ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date())}`
    : "Loading Live TV…";
  if (state.liveTvTab === "guide") renderLiveTvGuide();
  else if (state.liveTvTab === "recordings") renderLiveTvRecordings();
  else renderLiveTvSchedules();
}

function updateLiveTvTimeMarkers(): void {
  const guide = state.liveTvGuide;
  if (!guide || guide.status.availability !== "available") return;
  const now = Date.now();
  const marker = currentTimeMarkerPercent(now, Date.parse(guide.windowStartUtc), Date.parse(guide.windowEndUtc));
  for (const track of liveTvContent.querySelectorAll<HTMLElement>(".live-tv-track")) {
    track.style.setProperty("--live-tv-now", marker === null ? "-10" : String(marker));
  }
  const label = liveTvContent.querySelector<HTMLElement>(".live-tv-now-label");
  if (label && marker !== null) {
    label.style.left = `${marker}%`;
    label.textContent = liveTvTime(new Date(now).toISOString());
  }
  for (const cell of liveTvContent.querySelectorAll<HTMLElement>(".live-tv-program[data-live-tv-start]")) {
    cell.classList.toggle("is-current", Date.parse(cell.dataset.liveTvStart || "") <= now && Date.parse(cell.dataset.liveTvEnd || "") > now);
  }
  if (!playerMiniGuide.classList.contains("is-hidden")) renderPlayerMiniGuide();
}

async function refreshLiveTv(showLoading = true, windowOverride?: { startUtc: string; endUtc: string }): Promise<void> {
  const requestId = ++state.liveTvRequestId;
  if (showLoading) { liveTvStatus.textContent = "Loading Live TV…"; refreshLiveTvButton.disabled = true; }
  const now = Date.now();
  const guideWindow = normalGuideWindow(now);
  const start = windowOverride?.startUtc || new Date(guideWindow.startMs).toISOString();
  const end = windowOverride?.endUtc || new Date(guideWindow.endMs).toISOString();
  try {
    const guide = await window.jellyfin.liveTv.getGuide({ startUtc: start, endUtc: end });
    const [recordings, timers, seriesTimers] = guide.status.availability === "available"
      ? await Promise.all([
        window.jellyfin.liveTv.getRecordings({ startIndex: 0, limit: 200 }),
        window.jellyfin.liveTv.getTimers(),
        window.jellyfin.liveTv.getSeriesTimers(),
      ])
      : [[], [], []] as [LiveTvRecording[], LiveTvTimer[], LiveTvSeriesTimer[]];
    if (requestId !== state.liveTvRequestId) return;
    state.liveTvGuide = guide; state.liveTvRecordings = recordings; state.liveTvTimers = timers; state.liveTvSeriesTimers = seriesTimers;
    renderLiveTv();
    if (!playerMiniGuide.classList.contains("is-hidden")) renderPlayerMiniGuide();
  } catch (error) {
    if (requestId !== state.liveTvRequestId) return;
    liveTvStatus.textContent = errorMessage(error, "Live TV could not be loaded.");
    liveTvContent.innerHTML = "";
    renderMessage(liveTvContent, "The guide is unavailable. Check the Jellyfin connection and try again.");
  } finally {
    if (requestId === state.liveTvRequestId) refreshLiveTvButton.disabled = false;
  }
}

async function openLiveTv(): Promise<void> {
  setRoute("live-tv");
  await refreshLiveTv();
}

async function createWatchParty(): Promise<void> {
  const name = watchPartyNameInput.value.trim();
  if (!name) {
    showToast("Enter a party name first.");
    watchPartyNameInput.focus();
    return;
  }
  createWatchPartyButton.disabled = true;
  try {
    state.watchParties = await window.jellyfin.watchParties.create({ name });
    watchPartyNameInput.value = "";
    renderWatchParties();
    showToast("Watch party created. Choose something to play when everyone joins.");
  } catch (error) {
    showToast(errorMessage(error, "The watch party could not be created."));
  } finally {
    createWatchPartyButton.disabled = state.watchParties?.availability !== "available";
  }
}

async function joinWatchParty(groupId: string, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    state.watchParties = await window.jellyfin.watchParties.join({ groupId });
    renderWatchParties();
    if (!playerView.classList.contains("is-hidden")) renderPlayerState();
    showToast("Joined. Playback controls are now shared with the party.");
  } catch (error) {
    button.disabled = false;
    showToast(errorMessage(error, "That watch party could not be joined."));
  }
}

async function leaveWatchParty(button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    state.watchParties = await window.jellyfin.watchParties.leave();
    renderWatchParties();
    if (!playerView.classList.contains("is-hidden")) renderPlayerState();
    showToast("Left the party. Playback controls are independent again.");
  } catch (error) {
    button.disabled = false;
    showToast(errorMessage(error, "The watch party could not be left."));
  }
}

async function resyncWatchParty(button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  const label = button.textContent;
  button.textContent = "Resyncing...";
  try {
    state.watchParties = await window.jellyfin.watchParties.resync();
    renderWatchParties();
    if (!playerView.classList.contains("is-hidden")) renderPlayerState();
    showToast("The watch party was corrected to the authoritative timeline.");
  } catch (error) {
    button.disabled = false;
    button.textContent = label;
    showToast(errorMessage(error, "The watch party could not be resynced."));
  }
}

async function setWatchPartySyncOffset(offsetMilliseconds: number, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    state.watchParties = await window.jellyfin.watchParties.setLocalSyncOffset({ offsetMilliseconds });
    renderWatchParties();
    if (!playerView.classList.contains("is-hidden")) renderPlayerState(true);
    showToast(offsetMilliseconds === 0
      ? "This computer’s timing adjustment was reset."
      : `This computer will play ${watchPartyOffsetLabel(offsetMilliseconds)}.`);
  } catch (error) {
    button.disabled = false;
    showToast(errorMessage(error, "The timing adjustment could not be saved."));
  }
}

async function waitForWatchParty(button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    state.watchParties = await window.jellyfin.watchParties.wait();
    renderSessionPanel();
    showToast("Waiting for everyone. Jellyfin SyncPlay is pausing the party.");
  } catch (error) {
    button.disabled = false;
    showToast(errorMessage(error, "The watch party could not be paused."));
  }
}

async function continueWatchParty(button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    state.watchParties = await window.jellyfin.watchParties.continue();
    renderSessionPanel();
    showToast("Continuing through Jellyfin SyncPlay.");
  } catch (error) {
    button.disabled = false;
    showToast(errorMessage(error, "The watch party could not continue."));
  }
}

async function updateBufferingPolicy(mode: "wait-for-all" | "continue", select: HTMLSelectElement): Promise<void> {
  select.disabled = true;
  try {
    state.watchParties = await window.jellyfin.watchParties.setBufferingPolicy({ mode });
    renderSessionPanel();
    showToast(mode === "wait-for-all" ? "Buffering policy set to wait for everyone." : "Automatic waiting is off.");
  } catch (error) {
    select.disabled = false;
    showToast(errorMessage(error, "The buffering policy could not be saved."));
  }
}

function renderMessage(container: HTMLElement, message: string): void {
  container.innerHTML = "";
  const element = document.createElement("p");
  element.className = "empty-state";
  element.textContent = message;
  container.append(element);
}

function renderLoadingRows(container: HTMLElement): void {
  container.innerHTML = "";
  for (let rowIndex = 0; rowIndex < 3; rowIndex += 1) {
    const section = document.createElement("section");
    const heading = document.createElement("div");
    const rail = document.createElement("div");
    section.className = "media-row skeleton-row";
    heading.className = "skeleton-heading";
    rail.className = rowIndex < 2 ? "skeleton-rail landscape" : "skeleton-rail poster";
    for (let cardIndex = 0; cardIndex < 7; cardIndex += 1) {
      const card = document.createElement("span");
      card.className = "skeleton-card";
      rail.append(card);
    }
    section.append(heading, rail);
    container.append(section);
  }
}

function mediaItemsEqual(left: MediaItem[], right: MediaItem[]): boolean {
  return left.length === right.length
    && left.every((item, index) => JSON.stringify(item) === JSON.stringify(right[index]));
}

function mediaRowsEqual(left: MediaRow[], right: MediaRow[]): boolean {
  return left.length === right.length
    && left.every((row, index) => {
      const candidate = right[index];
      return candidate?.title === row.title
        && candidate.shape === row.shape
        && mediaItemsEqual(row.items, candidate.items);
    });
}

function librariesEqual(left: LibrarySummary[], right: LibrarySummary[]): boolean {
  return left.length === right.length
    && left.every((library, index) => JSON.stringify(library) === JSON.stringify(right[index]));
}

async function loadLibraries(): Promise<void> {
  state.libraries = await window.jellyfin.libraries.list();
  renderLibraryNavigation();
}

function navigationLibraries(): LibrarySummary[] {
  const serverLibraries = state.libraries.filter((library) => {
    if (!library.id || !library.name.trim()) return false;
    const collectionType = library.collectionType?.trim().toLocaleLowerCase() ?? null;
    return collectionType !== "boxsets" && collectionType !== "livetv";
  });
  return state.offlinePlayable.length
    ? [...serverLibraries, DOWNLOADED_LIBRARY]
    : serverLibraries;
}

function libraryItemType(library: LibrarySummary): "Movie" | "Series" | "Mixed" | null {
  if (library.collectionType === "movies") return "Movie";
  if (library.collectionType === "tvshows") return "Series";
  if (library.collectionType === null || ["mixed", "homevideos", "homevideosandphotos", "musicvideos", "downloaded"].includes(library.collectionType)) {
    return "Mixed";
  }
  return null;
}

function supportedLibraries(): LibrarySummary[] {
  return navigationLibraries().filter((library) => libraryItemType(library) !== null);
}

function createLibraryNavigationButton(library: LibrarySummary, player: boolean): HTMLButtonElement {
  const button = document.createElement("button");
  const itemType = libraryItemType(library);
  button.type = "button";
  button.title = itemType ? library.name : `${library.name} is not supported by this video client yet`;
  button.dataset.libraryId = library.id;
  button.disabled = itemType === null;
  button.setAttribute("aria-label", itemType ? library.name : `${library.name}, unsupported media library`);
  button.innerHTML = library.collectionType === "downloaded"
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m-4-4 4 4 4-4"></path><path d="M4 16v4h16v-4"></path></svg>'
    : library.collectionType === "movies"
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"></rect><path d="M4 8h16M9 3v5m6-5v5"></path></svg>'
    : library.collectionType === "tvshows"
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="15" rx="2"></rect><path d="M8 2h8"></path></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v11H3z"></path><path d="M3 7V4h7l2 3"></path></svg>';
  const label = document.createElement("span");
  label.textContent = library.name;
  button.append(label);
  if (itemType) {
    button.addEventListener("click", async () => {
      if (player) await closePlayer();
      await openLibrary(library.id);
    });
  }
  return button;
}

function renderLibraryNavigation(): void {
  const navigation = navigationLibraries();
  const libraries = supportedLibraries();
  mainLibraryNavigation.replaceChildren(...navigation.map((library) => createLibraryNavigationButton(library, false)));
  playerLibraryNavigation.replaceChildren(...navigation.map((library) => createLibraryNavigationButton(library, true)));
  if (!libraries.some((library) => library.id === state.selectedLibraryId)) {
    state.selectedLibraryId = libraries[0]?.id ?? null;
  }
  if (state.currentRoute === "library" && !state.selectedLibraryId) setRoute("home");
  else setRoute(state.currentRoute, { preserveScroll: true });
}

async function loadHome(requestId = ++state.homeRequestId, showLoading = true): Promise<void> {
  if (showLoading && requestId === state.homeRequestId) renderLoadingRows(homeRows);
  const payload = await window.jellyfin.home.get();
  if (requestId !== state.homeRequestId) return;
  const navigationChanged = !librariesEqual(state.libraries, payload.libraries);
  state.libraries = payload.libraries;
  if (showLoading || navigationChanged) renderLibraryNavigation();
  state.resumeItems = payload.resumeItems;
  state.nextUpItems = payload.nextUpItems;
  const rows: MediaRow[] = [];
  if (state.resumeItems.length) rows.push({
    title: "Continue Watching",
    items: state.resumeItems,
    shape: "landscape",
    linkEpisodeSeries: true,
  });
  if (state.nextUpItems.length) rows.push({
    title: "Next Up",
    items: state.nextUpItems,
    shape: "landscape",
    linkEpisodeSeries: true,
  });
  for (const result of payload.latestRows) {
    if (result.items.length) rows.push({ title: `Recently Added to ${result.library.name}`, items: result.items, shape: "poster" });
  }
  const rowsChanged = !mediaRowsEqual(state.homeRows, rows);
  state.homeRows = rows;
  state.featureItem = state.resumeItems[0] || state.nextUpItems[0] || rows[0]?.items[0] || null;
  if (showLoading || rowsChanged) {
    renderFeature(state.featureItem);
    renderMediaRows(homeRows, rows);
  }
}

async function loadInitialData(): Promise<void> {
  const requestId = ++state.homeRequestId;
  showMain();
  void refreshCompanionNavStatus();
  renderLoadingRows(homeRows);
  const downloadsRequest = refreshDownloads(() => requestId === state.homeRequestId).catch((error) => {
    if (requestId === state.homeRequestId) showToast(errorMessage(error, "Downloads could not be loaded."));
  });
  try {
    await Promise.all([loadHome(requestId), downloadsRequest]);
    if (requestId !== state.homeRequestId) return;
    setRoute("home");
  } catch (error) {
    await downloadsRequest;
    if (requestId !== state.homeRequestId) return;
    if (errorCode(error) === "SESSION_EXPIRED") {
      await window.jellyfin.session.logout().catch(() => undefined);
      state.session = null;
      resetSignedInState();
      showLogin("Your Jellyfin session expired. Sign in again.");
      return;
    }
    renderConnectionFailure();
    showToast(errorMessage(error, "Jellyfin could not load the home screen."));
  }
}

function renderConnectionFailure(): void {
  state.homeRows = [];
  state.resumeItems = [];
  state.nextUpItems = [];
  renderFeature(null);
  featureEyebrow.textContent = "Connection unavailable";
  featureTitle.textContent = "Jellyfin is offline";
  featureOverview.textContent = "Start or restart your server, then try the connection again.";

  const panel = document.createElement("section");
  panel.className = "connection-failure";

  const heading = document.createElement("h2");
  heading.textContent = "Could not reach Jellyfin";

  const copy = document.createElement("p");
  copy.textContent = "Your protected session is still available. Verified local media remains available while the server is offline.";

  const retryButton = document.createElement("button");
  retryButton.type = "button";
  retryButton.className = "primary";
  retryButton.dataset.retryConnection = "";
  retryButton.textContent = "Retry Connection";
  retryButton.addEventListener("click", () => { void retryConnection(retryButton); });

  panel.append(heading, copy, retryButton);
  homeRows.replaceChildren(panel);
  if (state.offlinePlayable.length) {
    const byItemId = new Map(state.offlinePlayable.map((entry) => [entry.item.id, entry]));
    homeRows.append(createMediaRow({
      title: "Local playback available",
      items: groupMovieVersions(state.offlinePlayable.map((entry) => entry.item)),
      shape: "landscape",
    }, (item) => {
      const local = byItemId.get(item.id);
      if (local) void playOfflineItem(local);
    }, "Play offline", false));
  }
  setRoute("home");
}

async function retryConnection(trigger?: HTMLButtonElement): Promise<void> {
  if (connectionRetryInFlight) return;
  connectionRetryInFlight = true;
  trigger?.setAttribute("disabled", "");
  refreshButton.disabled = true;
  profileMenu.classList.add("is-hidden");
  profileButton.setAttribute("aria-expanded", "false");
  state.libraryCache.clear();
  try {
    await loadInitialData();
  } finally {
    connectionRetryInFlight = false;
    refreshButton.disabled = false;
    if (trigger?.isConnected) trigger.disabled = false;
  }
}

function renderFeature(item: MediaItem | null): void {
  state.featureItem = item;
  featurePlayButton.onclick = null;
  featureInfoButton.onclick = null;
  featurePlayButton.disabled = !canPlay(item);
  featureInfoButton.disabled = !item;

  if (!item) {
    featureEyebrow.textContent = "Your Jellyfin";
    featureTitle.textContent = "No titles available";
    featureOverview.textContent = "";
    featureImage.classList.add("is-hidden");
    featureHero.classList.add("has-no-art");
    return;
  }

  featureHero.classList.remove("has-no-art");
  featureEyebrow.textContent = item.type === "Episode"
    ? [item.seriesName, episodeCode(item)].filter(Boolean).join(" - ")
    : [item.type, itemYear(item)].filter(Boolean).join(" - ");
  featureTitle.textContent = item.type === "Episode" && item.seriesName ? item.seriesName : item.name;
  featureOverview.textContent = item.overview || (item.type === "Episode" ? item.name : "");
  const kind = hasImage(item, "Backdrop") ? "Backdrop" : hasImage(item, "Primary") ? "Primary" : "";
  featureImage.classList.toggle("use-contain", kind === "Primary" && Number(item.primaryImageAspectRatio || 0) < 1.15);
  setImage(featureImage, null, item, kind, { width: 1800 });
  featurePlayButton.onclick = canPlay(item) ? () => playItem(item) : null;
  featureInfoButton.onclick = () => openDetails(item);
}

function renderMediaRows(container: HTMLElement, rows: MediaRow[]): void {
  container.innerHTML = "";
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Nothing to show yet.";
    container.append(empty);
    return;
  }
  for (const row of rows) container.append(createMediaRow(row));
}

function createMediaRow(
  row: MediaRow,
  activate?: (item: MediaItem) => void,
  actionLabel?: string,
  loadArtwork = true,
): HTMLElement {
  const section = document.createElement("section");
  const heading = document.createElement("div");
  const title = document.createElement("h2");
  const railShell = document.createElement("div");
  const rail = document.createElement("div");
  const previous = document.createElement("button");
  const next = document.createElement("button");

  section.className = "media-row";
  heading.className = "row-heading";
  title.textContent = row.title;
  heading.append(title);

  railShell.className = "rail-shell";
  rail.className = `media-rail ${row.shape}`;
  rail.setAttribute("tabindex", "0");
  rail.setAttribute("aria-label", row.title);
  for (const item of row.items) {
    rail.append(createMediaCard(
      item,
      row.shape,
      activate,
      actionLabel,
      loadArtwork,
      row.linkEpisodeSeries ? openEpisodeSeriesFromCard : undefined,
    ));
  }

  previous.className = "rail-arrow previous";
  previous.type = "button";
  previous.textContent = "<";
  previous.setAttribute("aria-label", `Scroll ${row.title} left`);
  previous.addEventListener("click", () => rail.scrollBy({ left: -rail.clientWidth * 0.82, behavior: "smooth" }));

  next.className = "rail-arrow next";
  next.type = "button";
  next.textContent = ">";
  next.setAttribute("aria-label", `Scroll ${row.title} right`);
  next.addEventListener("click", () => rail.scrollBy({ left: rail.clientWidth * 0.82, behavior: "smooth" }));

  railShell.append(previous, rail, next);
  section.append(heading, railShell);
  return section;
}

function createMediaCard(
  item: MediaItem,
  shape: "poster" | "landscape" = "poster",
  activate?: (item: MediaItem) => void,
  actionLabel?: string,
  loadArtwork = true,
  seriesTitleActivate?: (episode: MediaItem, trigger: HTMLButtonElement) => void,
): HTMLElement {
  const shell = document.createElement("span");
  const button = document.createElement("button");
  const art = document.createElement("span");
  const image = document.createElement("img");
  const fallback = document.createElement("span");
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  const subtitle = document.createElement("small");
  const localBadge = document.createElement("span");
  const separateSeriesTitle = item.type === "Episode" && Boolean(item.seriesId && item.seriesName && seriesTitleActivate);

  shell.className = `media-card-shell ${shape}`;
  button.type = "button";
  button.className = `media-card ${shape}`;
  button.dataset.mediaItem = item.id;
  button.title = actionLabel ? `${actionLabel}: ${itemCardTitle(item)}` : itemCardTitle(item);
  if (actionLabel) button.setAttribute("aria-label", `${actionLabel}: ${itemCardTitle(item)}`);
  else if (separateSeriesTitle) button.setAttribute("aria-label", `Open episode ${item.name}`);
  button.addEventListener("click", () => activate ? activate(item) : openDetails(item));

  art.className = "media-art";
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  fallback.className = "art-fallback";
  fallback.textContent = initials(itemCardTitle(item));
  localBadge.className = `local-availability-badge${downloadForItem(item.id)?.state === "downloaded" ? "" : " is-hidden"}`;
  localBadge.textContent = "Local";
  art.append(image, fallback, localBadge);
  if (actionLabel) {
    const action = document.createElement("span");
    action.className = "media-card-action";
    action.textContent = actionLabel;
    art.append(action);
  }
  if (loadArtwork) {
    setImage(image, fallback, item, preferredArtwork(item, shape), {
      width: shape === "poster" ? 460 : 760,
      height: shape === "poster" ? 690 : 430,
    });
  } else {
    image.classList.add("is-hidden");
  }

  const percentage = Number(item.userData?.playedPercentage || 0);
  if (percentage > 0 && percentage < 100) {
    const progress = document.createElement("progress");
    progress.className = "watch-progress";
    progress.max = 100;
    progress.value = Math.min(100, Math.max(1, percentage));
    progress.setAttribute("aria-label", `${Math.round(progress.value)} percent watched`);
    art.append(progress);
  }

  copy.className = `media-copy${separateSeriesTitle ? " separate-series-copy" : ""}`;
  title.textContent = itemCardTitle(item);
  subtitle.textContent = itemCardSubtitle(item);
  if (separateSeriesTitle) {
    const seriesButton = document.createElement("button");
    seriesButton.type = "button";
    seriesButton.className = "media-card-series-link";
    seriesButton.dataset.seriesLink = item.seriesId!;
    seriesButton.title = `Open ${item.seriesName}`;
    seriesButton.setAttribute("aria-label", `Open series ${item.seriesName}`);
    seriesButton.append(title);
    seriesButton.addEventListener("click", () => seriesTitleActivate!(item, seriesButton));
    copy.append(seriesButton, subtitle);
    button.classList.add("artwork-only");
    button.append(art);
    shell.append(button, copy);
  } else {
    copy.append(title, subtitle);
    button.append(art, copy);
    shell.append(button);
  }
  if (!activate && canPlay(item)) {
    const quickPlay = document.createElement("button");
    quickPlay.type = "button";
    quickPlay.className = "media-card-quick-play";
    quickPlay.dataset.quickPlayItem = item.id;
    quickPlay.title = `Play ${itemCardTitle(item)}`;
    quickPlay.setAttribute("aria-label", `Play ${itemCardTitle(item)}`);
    quickPlay.textContent = "▶";
    quickPlay.addEventListener("click", () => { void playItem(item); });
    shell.append(quickPlay);
  }
  return shell;
}

function renderDetails(item: MediaItem): void {
  state.detailItem = item;
  state.detailPlayItem = canPlay(item) ? item : null;
  detailEyebrow.textContent = item.type === "Episode"
    ? [item.seriesName, episodeCode(item)].filter(Boolean).join(" - ")
    : item.type || "Jellyfin";
  detailTitle.textContent = item.name || "Untitled";
  detailOverview.textContent = item.overview || "No description is available.";

  detailMeta.innerHTML = "";
  for (const value of metadataParts(item)) {
    const span = document.createElement("span");
    span.textContent = value;
    detailMeta.append(span);
  }

  detailGenres.innerHTML = "";
  for (const genre of item.genres || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "genre-button";
    button.textContent = genre;
    button.addEventListener("click", () => { void openBrowse(`Genre: ${genre}`, { type: "Mixed", genre, sort: "title-ascending", startIndex: 0, limit: 60 }); });
    detailGenres.append(button);
  }
  renderDetailVersionControl();
  detailPeople.replaceChildren();
  detailCast.classList.toggle("is-hidden", !(item.people?.length));
  for (const person of presentPeople(item.people ?? [])) {
    detailPeople.append(createPersonCard(person));
  }

  const backdropKind = hasImage(item, "Backdrop") ? "Backdrop" : hasImage(item, "Primary") ? "Primary" : "";
  detailBackdrop.classList.toggle("use-contain", backdropKind === "Primary" && Number(item.primaryImageAspectRatio || 0) < 1.15);
  setImage(detailBackdrop, null, item, backdropKind, { width: 1800 });

  const posterSuitable = hasImage(item, "Primary") && Number(item.primaryImageAspectRatio || 0) < 1.15;
  detailHero.classList.toggle("has-no-poster", !posterSuitable);
  detailPosterFrame.classList.toggle("is-hidden", !posterSuitable);
  detailPosterFallback.textContent = initials(item.name);
  if (posterSuitable) setImage(detailPoster, detailPosterFallback, item, "Primary", { width: 520, height: 780 });

  const downloadable = item.type === "Movie" || item.type === "Episode";
  detailDownloadButton.disabled = !downloadable;
  detailDownloadButton.dataset.downloadItem = downloadable ? item.id : "";
  detailDownloadButton.onclick = downloadable ? () => startDownload(item, selectedDetailVersion()) : null;
  detailTrailerButton.disabled = !item.hasTrailer;
  detailTrailerButton.onclick = item.hasTrailer
    ? () => { void openTrailer(item.id); }
    : null;
  const watchedCapable = item.type === "Movie" || item.type === "Episode" || item.type === "Video";
  detailWatchedButton.classList.toggle("is-hidden", !watchedCapable);
  detailWatchedButton.disabled = !watchedCapable;
  detailWatchedLabel.textContent = item.userData?.played ? "Mark Unwatched" : "Mark Watched";
  detailWatchedButton.onclick = watchedCapable
    ? () => setWatchedState(item, !item.userData.played, detailWatchedButton)
    : null;
  const seriesCapable = item.type === "Episode" && Boolean(item.seriesId);
  detailSeriesButton.classList.toggle("is-hidden", !seriesCapable);
  detailSeriesButton.disabled = !seriesCapable;
  detailSeriesButton.onclick = seriesCapable
    ? () => { void openSeriesFromEpisode(item); }
    : null;
  updateDetailSmartDownloadsButton(item);
  updateDetailPlayButton();
  syncVisibleDownloadButtons();
}

function smartSeries(seriesId: string): SmartSeriesSummary | null {
  return state.smartDownloads.series.find((series) => series.seriesId === seriesId) ?? null;
}

function updateDetailSmartDownloadsButton(item: MediaItem | null = state.detailItem): void {
  const seriesCapable = item?.type === "Series";
  detailSmartDownloadsButton.classList.toggle("is-hidden", !seriesCapable);
  detailSmartDownloadsButton.disabled = !seriesCapable;
  detailSmartDownloadsButton.onclick = seriesCapable ? () => { void configureSmartDownloads(item); } : null;
  const followed = seriesCapable ? smartSeries(item.id) : null;
  detailSmartDownloadsLabel.textContent = followed
    ? `Smart Downloads: ${followed.episodeLimit}`
    : "Smart Downloads";
}

function showDialog(dialog: HTMLDialogElement): Promise<string> {
  dialog.returnValue = "cancel";
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue || "cancel"), { once: true });
    dialog.showModal();
  });
}

async function configureSmartDownloads(series: MediaItem): Promise<void> {
  const existing = smartSeries(series.id);
  smartDownloadDialogTitle.textContent = existing ? `Smart Downloads for ${series.name}` : `Follow ${series.name}`;
  smartDownloadDialogDescription.textContent = "Choose how many upcoming unwatched regular episodes to keep ready.";
  smartDownloadEpisodeLimit.value = String(existing?.episodeLimit ?? 3);
  const action = await showDialog(smartDownloadDialog);
  if (action !== "save") return;
  const episodeLimit = Number(smartDownloadEpisodeLimit.value);
  detailSmartDownloadsButton.disabled = true;
  try {
    state.smartDownloads = existing
      ? await window.jellyfin.smartDownloads.setLimit({ seriesId: series.id, episodeLimit })
      : await window.jellyfin.smartDownloads.follow({ seriesId: series.id, episodeLimit });
    renderSmartDownloads();
    updateDetailSmartDownloadsButton(series);
    showToast(existing ? "Smart Download limit updated." : `${series.name} is now followed for Smart Downloads.`);
  } catch (error) {
    showToast(errorMessage(error, "Smart Downloads could not be updated."));
  } finally {
    detailSmartDownloadsButton.disabled = false;
  }
}

async function openTrailer(itemId: string): Promise<void> {
  detailTrailerButton.disabled = true;
  try {
    const result = await window.jellyfin.items.openTrailer({ itemId });
    if (!result.opened) showToast("No trailer is available for this title.");
    else if (result.mode === "external") showToast("This trailer cannot be embedded, so it opened in your browser.");
    else if (result.embedUrl) {
      activeTrailerItemId = itemId;
      trailerLastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      trailerTitle.textContent = `${detailTitle.textContent || "Title"} Trailer`;
      trailerFrame.src = result.embedUrl;
      trailerScrim.classList.remove("is-hidden");
      trailerPanel.classList.remove("is-hidden");
      closeTrailerButton.focus();
    }
  } catch (error) {
    showToast(errorMessage(error, "The trailer could not be opened."));
  } finally {
    detailTrailerButton.disabled = false;
  }
}

let activeTrailerItemId: string | null = null;
let trailerLastFocus: HTMLElement | null = null;

function closeTrailer(): void {
  if (trailerPanel.classList.contains("is-hidden")) return;
  trailerFrame.removeAttribute("src");
  trailerScrim.classList.add("is-hidden");
  trailerPanel.classList.add("is-hidden");
  activeTrailerItemId = null;
  trailerLastFocus?.focus();
  trailerLastFocus = null;
}

async function openTrailerInBrowser(): Promise<void> {
  if (!activeTrailerItemId) return;
  openTrailerBrowserButton.disabled = true;
  try {
    await window.jellyfin.items.openTrailer({ itemId: activeTrailerItemId, openExternally: true });
  } catch (error) {
    showToast(errorMessage(error, "The trailer could not be opened in your browser."));
  } finally {
    openTrailerBrowserButton.disabled = false;
  }
}

function applyKnownWatchedState(itemId: string, watched: boolean): void {
  const candidates = [
    ...state.homeRows.flatMap((row) => row.items),
    ...state.resumeItems,
    ...state.nextUpItems,
    ...[...state.libraryCache.values()].flat(),
    ...state.episodes,
    state.featureItem,
    state.detailItem,
    state.detailPlayItem,
    state.playbackItem,
  ];
  const seen = new Set<MediaItem>();
  for (const candidate of candidates) {
    if (!candidate || candidate.id !== itemId || seen.has(candidate)) continue;
    seen.add(candidate);
    candidate.userData = {
      ...candidate.userData,
      played: watched,
      playbackPositionTicks: 0,
      playedPercentage: watched ? 100 : 0,
    };
  }
  if (watched) {
    state.resumeItems = state.resumeItems.filter((item) => item.id !== itemId);
    for (const row of state.homeRows) {
      if (row.title === "Continue Watching") row.items = row.items.filter((item) => item.id !== itemId);
    }
  }
}

async function setWatchedState(item: MediaItem, watched: boolean, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const result = await window.jellyfin.items.setWatched({ itemId: item.id, watched });
    applyKnownWatchedState(item.id, result.watched);
    if (state.detailItem?.id === item.id) renderDetails(state.detailItem);
    if (state.episodes.some((episode) => episode.id === item.id)) {
      state.detailPlayItem = state.episodes.find((episode) => !episode.userData.played)
        || state.episodes[0]
        || null;
      updateDetailPlayButton();
      renderEpisodes();
    }
    const stateLabel = result.watched ? "watched" : "unwatched";
    showToast(result.synchronization === "queued"
      ? `Marked ${stateLabel}. It will sync when Jellyfin is available.`
      : `Marked ${stateLabel}.`);
    if (result.synchronization === "synchronized") {
      void loadHome().catch(() => undefined);
    }
  } catch (error) {
    button.disabled = false;
    showToast(errorMessage(error, "Watched state could not be changed."));
  }
}

function updateDetailPlayButton(): void {
  const item = state.detailPlayItem;
  detailPlayButton.disabled = !item;
  detailPlayButton.onclick = item ? () => playItem(item, selectedDetailVersion()) : null;
  if (!item) {
    detailPlayLabel.textContent = state.detailItem?.type === "Series" ? "Loading" : "Play";
    return;
  }
  const hasProgress = Number(item.userData?.playbackPositionTicks || 0) > 0;
  detailPlayLabel.textContent = hasProgress ? "Resume" : "Play";
}

interface OpenDetailsOptions {
  alreadyLoaded?: boolean;
  preferredSeasonId?: string | null;
}

async function openDetails(item: MediaItem, options: OpenDetailsOptions = {}): Promise<void> {
  if (!item?.id) return;
  state.returnRoute = state.currentRoute === "details" ? "home" : state.currentRoute;
  state.returnScrollTop = contentScroller.scrollTop;
  state.detailsRequestId += 1;
  const requestId = state.detailsRequestId;
  state.seasons = [];
  state.episodes = [];
  state.detailVersions = [];
  detailVersionSelect.value = "auto";
  episodeSection.classList.add("is-hidden");
  renderDetails(item);
  setRoute("details");
  try {
    const fullItem = options.alreadyLoaded
      ? item
      : await window.jellyfin.items.getDetails({ itemId: item.id });
    if (requestId !== state.detailsRequestId) return;
    const versionItemIds = [...new Set((item.mediaVersions?.length ? item.mediaVersions : fullItem.mediaVersions ?? []).map((version) => version.itemId))];
    const versions = fullItem.type === "Movie" && versionItemIds.length
      ? await window.jellyfin.mediaSources.getVersions({ itemIds: versionItemIds }).catch(() => fullItem.mediaVersions ?? item.mediaVersions ?? [])
      : [];
    if (requestId !== state.detailsRequestId) return;
    state.detailVersions = versions;
    renderDetails({ ...fullItem, mediaVersions: versions });
    if (fullItem.type === "Series") await loadSeriesSeasons(fullItem, requestId, options.preferredSeasonId);
  } catch (error) {
    showToast(errorMessage(error, "Details could not be loaded."));
  }
}

async function openEpisodeSeriesFromCard(episode: MediaItem, trigger: HTMLButtonElement): Promise<void> {
  if (episode.type !== "Episode" || !episode.seriesId) return;
  trigger.disabled = true;
  try {
    const series = await window.jellyfin.items.getDetails({ itemId: episode.seriesId });
    if (series.type !== "Series") throw new Error("The parent series could not be found.");
    await openDetails(series, {
      alreadyLoaded: true,
      preferredSeasonId: episode.seasonId,
    });
  } catch (error) {
    trigger.disabled = false;
    showToast(errorMessage(error, "The series could not be opened."));
  }
}

async function openSeriesFromEpisode(episode: MediaItem): Promise<void> {
  if (episode.type !== "Episode" || !episode.seriesId) return;
  const originRequestId = state.detailsRequestId;
  const originIsActive = (): boolean => state.currentRoute === "details"
    && originRequestId === state.detailsRequestId
    && state.detailItem?.id === episode.id;
  detailSeriesButton.disabled = true;
  try {
    const series = await window.jellyfin.items.getDetails({ itemId: episode.seriesId });
    if (!originIsActive()) return;
    if (series.type !== "Series") throw new Error("The parent series could not be found.");
    await openDetails(series, {
      alreadyLoaded: true,
      preferredSeasonId: episode.seasonId,
    });
  } catch (error) {
    if (!originIsActive()) return;
    detailSeriesButton.disabled = false;
    showToast(errorMessage(error, "The series could not be opened."));
  }
}

function returnFromDetails(): void {
  const route = state.returnRoute || "home";
  const scrollTop = state.returnScrollTop || 0;
  setRoute(route, { scrollTop });
  requestAnimationFrame(() => {
    contentScroller.scrollTop = scrollTop;
  });
}

async function loadSeriesSeasons(series: MediaItem, requestId: number, preferredSeasonId?: string | null): Promise<void> {
  episodeSection.classList.remove("is-hidden");
  state.selectedEpisodeIds.clear();
  updateEpisodeSelectionControls();
  seasonSelect.disabled = true;
  episodeList.innerHTML = '<li class="empty-state">Loading episodes...</li>';
  const result = await window.jellyfin.shows.getSeasons({ itemId: series.id });
  if (requestId !== state.detailsRequestId) return;
  state.seasons = result;
  seasonSelect.innerHTML = "";
  for (const season of state.seasons) {
    const option = document.createElement("option");
    option.value = season.id;
    option.textContent = season.name;
    seasonSelect.append(option);
  }
  seasonSelect.disabled = state.seasons.length === 0;
  if (!state.seasons.length) {
    episodeList.innerHTML = '<li class="empty-state">No episodes found.</li>';
    return;
  }
  const nextForSeries = state.nextUpItems.find((entry) => entry.seriesId === series.id);
  const preferredSeason = state.seasons.find((season) => season.id === preferredSeasonId)
    || state.seasons.find((season) => season.id === nextForSeries?.seasonId)
    || state.seasons[0];
  seasonSelect.value = preferredSeason.id;
  await loadEpisodes(series.id, preferredSeason.id, requestId);
}

async function loadEpisodes(seriesId: string, seasonId: string, requestId = state.detailsRequestId): Promise<void> {
  state.selectedEpisodeIds.clear();
  updateEpisodeSelectionControls();
  episodeList.innerHTML = '<li class="empty-state">Loading episodes...</li>';
  const result = await window.jellyfin.shows.getEpisodes({ seriesId, seasonId });
  if (requestId !== state.detailsRequestId) return;
  state.episodes = result;
  const nextForSeries = state.nextUpItems.find((entry) => entry.seriesId === seriesId && entry.seasonId === seasonId);
  state.detailPlayItem = nextForSeries
    || state.episodes.find((episode) => !episode.userData?.played)
    || state.episodes[0]
    || null;
  updateDetailPlayButton();
  renderEpisodes();
}

function renderEpisodes(): void {
  episodeList.innerHTML = "";
  if (!state.episodes.length) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = "No episodes found.";
    episodeList.append(empty);
    return;
  }

  for (const episode of state.episodes) {
    const row = document.createElement("li");
    const thumb = document.createElement("span");
    const image = document.createElement("img");
    const fallback = document.createElement("span");
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    const overview = document.createElement("p");
    const actions = document.createElement("span");
    const selection = document.createElement("label");
    const checkbox = document.createElement("input");
    const play = document.createElement("button");
    const download = document.createElement("button");
    const watched = document.createElement("button");

    row.className = "episode-row";
    thumb.className = "episode-thumb";
    image.alt = "";
    image.loading = "lazy";
    fallback.className = "art-fallback";
    fallback.textContent = episode.indexNumber == null ? "E" : `E${episode.indexNumber}`;
    selection.className = "episode-selector";
    checkbox.type = "checkbox";
    checkbox.dataset.episodeSelect = episode.id;
    checkbox.setAttribute("aria-label", `Select ${episode.name || `episode ${episode.indexNumber || ""}`} for download`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedEpisodeIds.add(episode.id);
      else state.selectedEpisodeIds.delete(episode.id);
      updateEpisodeSelectionControls();
    });
    selection.append(checkbox);
    thumb.append(image, fallback, selection);
    setImage(image, fallback, episode, preferredArtwork(episode, "landscape"), { width: 720, height: 405 });

    const percentage = Number(episode.userData?.playedPercentage || 0);
    if (percentage > 0 && percentage < 100) {
      const progress = document.createElement("progress");
      progress.className = "watch-progress";
      progress.max = 100;
      progress.value = Math.min(100, Math.max(1, percentage));
      progress.setAttribute("aria-label", `${Math.round(progress.value)} percent watched`);
      thumb.append(progress);
    }

    copy.className = "episode-copy";
    const details = document.createElement("button");
    details.type = "button";
    details.className = "episode-title-button";
    details.textContent = episode.name || `Episode ${episode.indexNumber || ""}`;
    details.addEventListener("click", () => { void openDetails(episode); });
    title.append(details);
    meta.textContent = [episodeCode(episode), runtime(episode), typeof episode.communityRating === "number" ? `★ ${episode.communityRating.toFixed(1)}` : ""].filter(Boolean).join(" - ");
    overview.textContent = episode.overview || "";
    copy.append(title, meta, overview);

    actions.className = "episode-actions";
    play.type = "button";
    play.className = "primary";
    play.textContent = episode.userData?.playbackPositionTicks ? "Resume" : "Play";
    play.addEventListener("click", () => playItem(episode));
    download.type = "button";
    download.dataset.downloadItem = episode.id;
    download.textContent = "Download";
    download.addEventListener("click", () => startDownload(episode));
    watched.type = "button";
    watched.textContent = episode.userData?.played ? "Mark Unwatched" : "Mark Watched";
    watched.addEventListener("click", () => setWatchedState(episode, !episode.userData.played, watched));
    actions.append(play, download, watched);

    row.append(thumb, copy, actions);
    episodeList.append(row);
  }
  syncVisibleDownloadButtons();
}

function updateEpisodeSelectionControls(): void {
  const eligibleIds = state.episodes
    .filter((episode) => !downloadForItem(episode.id))
    .map((episode) => episode.id);
  const eligible = new Set(eligibleIds);
  for (const itemId of [...state.selectedEpisodeIds]) {
    if (!eligible.has(itemId)) state.selectedEpisodeIds.delete(itemId);
  }
  for (const checkbox of document.querySelectorAll<HTMLInputElement>("[data-episode-select]")) {
    const itemId = checkbox.dataset.episodeSelect || "";
    checkbox.disabled = !eligible.has(itemId);
    checkbox.checked = !checkbox.disabled && state.selectedEpisodeIds.has(itemId);
  }
  const selectedCount = state.selectedEpisodeIds.size;
  selectSeasonEpisodes.disabled = eligibleIds.length === 0;
  selectSeasonEpisodes.checked = eligibleIds.length > 0 && selectedCount === eligibleIds.length;
  selectSeasonEpisodes.indeterminate = selectedCount > 0 && selectedCount < eligibleIds.length;
  downloadSelectedEpisodes.disabled = selectedCount === 0;
  downloadSelectedEpisodes.textContent = selectedCount > 0
    ? `Download selected (${selectedCount})`
    : "Download selected";
}

async function startSelectedEpisodeDownloads(): Promise<void> {
  const selected = state.episodes.filter((episode) => state.selectedEpisodeIds.has(episode.id) && !downloadForItem(episode.id));
  if (!selected.length) {
    updateEpisodeSelectionControls();
    return;
  }
  downloadSelectedEpisodes.disabled = true;
  let started = 0;
  let failed = 0;
  for (const episode of selected) {
    try {
      const download = await window.jellyfin.downloads.start({ itemId: episode.id });
      state.downloads = [download, ...state.downloads.filter((entry) => entry.downloadId !== download.downloadId)];
      state.selectedEpisodeIds.delete(episode.id);
      started += 1;
    } catch {
      failed += 1;
    }
  }
  renderDownloads();
  syncVisibleDownloadButtons();
  updateEpisodeSelectionControls();
  if (started > 0) openDownloads();
  if (failed > 0) showToast(`${failed} selected ${failed === 1 ? "episode" : "episodes"} could not be queued.`);
}

function renderLibraryLoading(): void {
  libraryGrid.innerHTML = "";
  for (let index = 0; index < 18; index += 1) {
    const skeleton = document.createElement("span");
    skeleton.className = "library-skeleton";
    libraryGrid.append(skeleton);
  }
}

async function refreshLibrary(library: LibrarySummary, showLoading = false): Promise<void> {
  const type = libraryItemType(library);
  if (!type) return;
  const cachedItems = state.libraryCache.get(library.id);
  if (library.id === DOWNLOADED_LIBRARY_ID) {
    const items = groupMovieVersions(state.offlinePlayable.map((entry) => entry.item));
    state.libraryCache.set(library.id, items);
    if ((!cachedItems || !mediaItemsEqual(cachedItems, items))
      && state.currentRoute === "library"
      && state.selectedLibraryId === library.id) {
      renderLibraryGrid(items);
    }
    return;
  }
  if (showLoading && !cachedItems) renderLibraryLoading();
  const requestId = (state.libraryRequestIds.get(library.id) || 0) + 1;
  state.libraryRequestIds.set(library.id, requestId);
  try {
    const query = {
      libraryId: library.id, type,
      watched: state.libraryFilter === "all" || state.libraryFilter === "downloaded" ? undefined : state.libraryFilter === "watched",
      sort: state.librarySort === "year-descending" ? "release-date-descending" : state.librarySort === "year-ascending" ? "release-date-ascending" : state.librarySort,
      startIndex: 0, limit: 100,
    } as const;
    const items = await loadAllBrowseItems(
      query,
      (pageQuery) => window.jellyfin.browse.get(pageQuery),
      () => state.libraryRequestIds.get(library.id) === requestId,
    );
    if (!items) return;
    if (state.libraryRequestIds.get(library.id) !== requestId) return;
    const itemsChanged = !cachedItems || !mediaItemsEqual(cachedItems, items);
    state.libraryCache.set(library.id, items);
    if (itemsChanged && state.currentRoute === "library" && state.selectedLibraryId === library.id) {
      renderLibraryGrid(items);
    }
  } catch (error) {
    if (!cachedItems && state.currentRoute === "library" && state.selectedLibraryId === library.id) {
      renderMessage(libraryGrid, errorMessage(error, "The library could not be loaded."));
    }
  }
}

async function openLibrary(libraryId: string): Promise<void> {
  const library = navigationLibraries().find((candidate) => candidate.id === libraryId);
  if (!library) return;
  if (!libraryItemType(library)) {
    showToast(`${library.name} is not supported by this video client yet.`);
    return;
  }
  if (library.id !== DOWNLOADED_LIBRARY_ID) {
    state.downloadedSelectionMode = false;
    state.selectedDownloadIds.clear();
  }
  state.selectedLibraryId = library.id;
  libraryTitle.textContent = library.name;
  setRoute("library");

  const cachedItems = state.libraryCache.get(library.id);
  if (cachedItems) renderLibraryGrid(cachedItems);
  await refreshLibrary(library, true);
}

async function refreshVisibleCatalog(): Promise<void> {
  if (visibleCatalogRefreshInFlight) {
    visibleCatalogRefreshQueued = true;
    return;
  }
  if (document.hidden
    || !state.session?.authenticated
    || !playerView.classList.contains("is-hidden")) return;
  visibleCatalogRefreshInFlight = true;
  try {
    if (state.currentRoute === "home") {
      await loadHome(++state.homeRequestId, false);
    } else if (state.currentRoute === "library" && state.selectedLibraryId) {
      const library = supportedLibraries().find((candidate) => candidate.id === state.selectedLibraryId);
      if (library) await refreshLibrary(library);
    } else if (state.currentRoute === "live-tv") {
      // The guide has a dedicated five-minute data refresh. Its one-minute refresh
      // should only advance the time indicator, never replace scrolling image rows.
      updateLiveTvTimeMarkers();
    }
  } catch {
    // Background refresh keeps the last successfully rendered catalog.
  } finally {
    visibleCatalogRefreshInFlight = false;
    if (visibleCatalogRefreshQueued) {
      visibleCatalogRefreshQueued = false;
      void refreshVisibleCatalog();
    }
  }
}

function openHome(): void {
  setRoute("home");
  void refreshVisibleCatalog();
}

function selectableDownloadForItem(itemId: string): DownloadSummary | undefined {
  return state.downloads.find((download) => download.itemId === itemId
    && download.state === "downloaded"
    && download.canDelete);
}

function updateDownloadedSelectionActions(): void {
  const localLibrary = state.selectedLibraryId === DOWNLOADED_LIBRARY_ID;
  downloadedLibraryActions.classList.toggle("is-hidden", !localLibrary);
  selectDownloadedButton.disabled = !state.downloads.some((download) => download.state === "downloaded" && download.canDelete);
  selectDownloadedButton.classList.toggle("is-hidden", state.downloadedSelectionMode);
  selectAllDownloadedButton.classList.toggle("is-hidden", !state.downloadedSelectionMode);
  deleteSelectedDownloadedButton.classList.toggle("is-hidden", !state.downloadedSelectionMode);
  cancelDownloadedSelectionButton.classList.toggle("is-hidden", !state.downloadedSelectionMode);
  const count = state.selectedDownloadIds.size;
  deleteSelectedDownloadedButton.disabled = count === 0;
  deleteSelectedDownloadedButton.textContent = count > 0 ? `Delete selected (${count})` : "Delete selected";
}

function renderDownloadedFollowedSeries(): void {
  const localLibrary = state.selectedLibraryId === DOWNLOADED_LIBRARY_ID;
  downloadedFollowedSeries.classList.toggle("is-hidden", !localLibrary);
  downloadedFollowedSeriesList.replaceChildren();
  if (!localLibrary) return;
  if (!state.smartDownloads.series.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No shows are currently followed.";
    downloadedFollowedSeriesList.append(empty);
    return;
  }
  for (const series of state.smartDownloads.series) {
    const button = document.createElement("button");
    const name = document.createElement("strong");
    const details = document.createElement("span");
    button.type = "button";
    button.className = "downloaded-followed-series-card";
    button.title = `Open ${series.name}`;
    name.textContent = series.name;
    details.textContent = `Keep ${series.episodeLimit} · ${smartStatusLabel(series.status)}`;
    button.append(name, details);
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const item = await window.jellyfin.items.getDetails({ itemId: series.seriesId });
        await openDetails(item, { alreadyLoaded: true });
      } catch (error) {
        button.disabled = false;
        showToast(errorMessage(error, "The followed show could not be opened."));
      }
    });
    downloadedFollowedSeriesList.append(button);
  }
}

function renderDownloadedLibraryExtras(): void {
  updateDownloadedSelectionActions();
  renderDownloadedFollowedSeries();
}

function toggleDownloadedSelection(downloadId: string): void {
  if (state.selectedDownloadIds.has(downloadId)) state.selectedDownloadIds.delete(downloadId);
  else state.selectedDownloadIds.add(downloadId);
  renderLibraryGrid(state.libraryCache.get(DOWNLOADED_LIBRARY_ID) || []);
}

async function deleteSelectedDownloads(): Promise<void> {
  const selected = state.downloads.filter((download) => state.selectedDownloadIds.has(download.downloadId)
    && download.state === "downloaded"
    && download.canDelete);
  if (!selected.length) return;
  const smartCount = selected.filter((download) => download.smartManaged).length;
  const prompt = `Delete ${selected.length} selected ${selected.length === 1 ? "download" : "downloads"}?${smartCount > 0
    ? " Smart Download episodes will also be skipped so they are not downloaded again."
    : ""}`;
  if (!window.confirm(prompt)) return;

  deleteSelectedDownloadedButton.disabled = true;
  let removed = 0;
  let failed = 0;
  for (const download of selected) {
    try {
      if (download.smartManaged) {
        state.smartDownloads = await window.jellyfin.smartDownloads.skip({ downloadId: download.downloadId });
      } else {
        await window.jellyfin.downloads.delete({ downloadId: download.downloadId });
      }
      state.selectedDownloadIds.delete(download.downloadId);
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  state.downloadedSelectionMode = failed > 0 && state.selectedDownloadIds.size > 0;
  await refreshDownloads().catch(() => undefined);
  if (state.currentRoute === "library" && state.selectedLibraryId === DOWNLOADED_LIBRARY_ID) {
    renderLibraryGrid(state.libraryCache.get(DOWNLOADED_LIBRARY_ID) || []);
  }
  if (failed > 0) showToast(`${removed} removed. ${failed} could not be deleted.`);
  else showToast(`${removed} ${removed === 1 ? "download" : "downloads"} deleted.`);
}

function renderLibraryGrid(items: MediaItem[]): void {
  libraryGrid.innerHTML = "";
  renderDownloadedLibraryExtras();
  const filtered = items.filter((item) => {
    if (state.libraryFilter === "watched") return item.userData.played;
    if (state.libraryFilter === "unwatched") return !item.userData.played;
    if (state.libraryFilter === "downloaded") return downloadForItem(item.id)?.state === "downloaded";
    return true;
  });
  const titleCompare = (left: MediaItem, right: MediaItem): number => left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (state.selectedLibraryId === DOWNLOADED_LIBRARY_ID) filtered.sort((left, right) => {
    if (state.librarySort === "title-descending") return -titleCompare(left, right);
    if (state.librarySort === "year-descending") return (itemYear(right) || 0) - (itemYear(left) || 0) || titleCompare(left, right);
    if (state.librarySort === "year-ascending") return (itemYear(left) || Number.MAX_SAFE_INTEGER) - (itemYear(right) || Number.MAX_SAFE_INTEGER) || titleCompare(left, right);
    if (state.librarySort === "rating-descending") return (right.communityRating || 0) - (left.communityRating || 0) || titleCompare(left, right);
    return titleCompare(left, right);
  });
  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = items.length ? "No titles match this filter." : "No titles found.";
    libraryGrid.append(empty);
    return;
  }
  const localOnly = state.selectedLibraryId === DOWNLOADED_LIBRARY_ID;
  for (const item of filtered) {
    const download = localOnly ? selectableDownloadForItem(item.id) : undefined;
    const card = createMediaCard(
      item,
      "poster",
      localOnly
        ? (selected) => {
          if (state.downloadedSelectionMode && download) toggleDownloadedSelection(download.downloadId);
          else if (!state.downloadedSelectionMode) void openDetails(selected, { alreadyLoaded: true });
        }
        : undefined,
    );
    if (localOnly && state.downloadedSelectionMode) {
      const selector = document.createElement("label");
      const checkbox = document.createElement("input");
      selector.className = "download-selection-checkbox";
      checkbox.type = "checkbox";
      checkbox.checked = Boolean(download && state.selectedDownloadIds.has(download.downloadId));
      checkbox.disabled = !download;
      checkbox.dataset.downloadSelect = download?.downloadId ?? "";
      checkbox.setAttribute("aria-label", download ? `Select ${itemCardTitle(item)}` : `${itemCardTitle(item)} cannot be deleted`);
      checkbox.addEventListener("change", () => {
        if (download) toggleDownloadedSelection(download.downloadId);
      });
      selector.append(checkbox);
      card.classList.toggle("is-download-selected", checkbox.checked);
      card.append(selector);
    }
    libraryGrid.append(card);
  }
}

async function runSearch(query: string): Promise<void> {
  const trimmed = query.trim();
  state.searchRequestId += 1;
  const requestId = state.searchRequestId;
  if (!trimmed) {
    searchRows.innerHTML = "";
    searchTitle.textContent = "Search";
    if (state.currentRoute === "search") {
      setRoute(state.searchReturnRoute || "home", { scrollTop: state.searchReturnScrollTop || 0 });
    }
    return;
  }

  if (state.currentRoute !== "search") {
    state.searchReturnRoute = state.currentRoute === "details" ? "home" : state.currentRoute;
    state.searchReturnScrollTop = contentScroller.scrollTop;
  }
  searchTitle.textContent = `Results for "${trimmed}"`;
  setRoute("search");
  renderLoadingRows(searchRows);

  try {
    const items = await window.jellyfin.search.query({ query: trimmed });
    if (requestId !== state.searchRequestId) return;
    const allRows: MediaRow[] = [
      { title: "Movies", items: items.filter((item) => item.type === "Movie"), shape: "poster" },
      { title: "Shows", items: items.filter((item) => item.type === "Series"), shape: "poster" },
      { title: "Episodes", items: items.filter((item) => item.type === "Episode"), shape: "landscape" },
    ];
    const rows = allRows.filter((row) => row.items.length);
    renderMediaRows(searchRows, rows);
  } catch (error) {
    if (requestId !== state.searchRequestId) return;
    renderMessage(searchRows, errorMessage(error, "Search could not be completed."));
  }
}

async function openBrowse(title: string, input: Parameters<typeof window.jellyfin.browse.get>[0]): Promise<void> {
  state.searchRequestId += 1;
  const requestId = state.searchRequestId;
  state.searchReturnRoute = state.currentRoute === "details" ? "home" : state.currentRoute;
  state.searchReturnScrollTop = contentScroller.scrollTop;
  searchTitle.textContent = title;
  setRoute("search");
  renderLoadingRows(searchRows);
  try {
    const items = await loadAllBrowseItems(
      input,
      (pageQuery) => window.jellyfin.browse.get(pageQuery),
      () => requestId === state.searchRequestId,
    );
    if (!items) return;
    renderMediaRows(searchRows, [{ title: input.personId ? "Movies and shows featuring this person" : "Results", items, shape: "poster" }]);
  } catch (error) {
    if (requestId === state.searchRequestId) renderMessage(searchRows, errorMessage(error, "Browse results could not be loaded."));
  }
}

function renderPersonResults(results: PersonMediaResult[]): void {
  searchRows.replaceChildren();
  const heading = document.createElement("h2");
  const grid = document.createElement("div");
  heading.className = "person-results-heading";
  heading.textContent = "Movies & Shows featuring this person";
  grid.className = "poster-grid-view person-results-grid";
  if (!results.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No movies or shows were found for this person.";
    searchRows.append(heading, empty);
    return;
  }
  for (const result of results) {
    const card = createMediaCard(result.item, "poster");
    if (result.appearanceCount) {
      const appearance = document.createElement("small");
      appearance.className = "person-appearance-count";
      appearance.textContent = `Appears in ${result.appearanceCount} episode${result.appearanceCount === 1 ? "" : "s"}`;
      card.querySelector(".media-copy")?.append(appearance);
    }
    grid.append(card);
  }
  searchRows.append(heading, grid);
}

async function openPersonBrowse(person: MediaPerson): Promise<void> {
  state.searchRequestId += 1;
  const requestId = state.searchRequestId;
  state.searchReturnRoute = state.currentRoute === "details" ? "home" : state.currentRoute;
  state.searchReturnScrollTop = contentScroller.scrollTop;
  searchTitle.textContent = person.name;
  setRoute("search");
  renderLoadingRows(searchRows);
  try {
    const results = await window.jellyfin.people.getResults({ itemId: person.id });
    if (requestId === state.searchRequestId) renderPersonResults(results);
  } catch (error) {
    if (requestId === state.searchRequestId) renderMessage(searchRows, errorMessage(error, "Person results could not be loaded."));
  }
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / (1024 ** index);
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function downloadForItem(itemId: string): DownloadSummary | undefined {
  return state.downloads.find((download) => download.itemId === itemId && download.state !== "missing");
}

function downloadButtonLabel(download: DownloadSummary | undefined): string {
  if (!download) return "Download";
  if (download.state === "downloading") return download.progressPercent === null ? "Downloading" : `${download.progressPercent}%`;
  return {
    queued: "Queued",
    paused: "Paused",
    downloaded: "Downloaded",
    failed: "Failed",
    missing: "Download",
  }[download.state];
}

function syncVisibleDownloadButtons(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-download-item]")) {
    const itemId = button.dataset.downloadItem || "";
    const label = downloadButtonLabel(downloadForItem(itemId));
    if (button === detailDownloadButton) detailDownloadLabel.textContent = label;
    else button.textContent = label;
  }
  for (const card of document.querySelectorAll<HTMLElement>("[data-media-item]")) {
    const downloaded = downloadForItem(card.dataset.mediaItem || "")?.state === "downloaded";
    card.querySelector(".local-availability-badge")?.classList.toggle("is-hidden", !downloaded);
  }
  updateEpisodeSelectionControls();
}

function openDownloads(): void {
  profileMenu.classList.add("is-hidden");
  profileButton.setAttribute("aria-expanded", "false");
  downloadsScrim.classList.remove("is-hidden");
  downloadsPanel.classList.remove("is-hidden");
  void refreshDownloadLocation().catch((error) => showToast(errorMessage(error, "The download location could not be loaded.")));
  void refreshDownloads().catch((error) => showToast(errorMessage(error, "Downloads could not be refreshed.")));
  closeDownloadsButton.focus();
}

function closeDownloads(): void {
  downloadsScrim.classList.add("is-hidden");
  downloadsPanel.classList.add("is-hidden");
}

function renderCompanion(status: CompanionSettingsState): void {
  renderCompanionNavStatus(status);
  companionEnabled.checked = status.enabled;
  companionStatus.textContent = status.message
    ? `${status.runtimeState}: ${status.message}`
    : `${status.runtimeState}${status.connectedDevices ? ` · ${status.connectedDevices} connected` : ""}`;
  const knownNetworks = new Set(Array.from(companionNetwork.options).map((option) => option.value));
  const currentNetworks = new Set(status.networks.map((network) => network.id));
  if (knownNetworks.size !== currentNetworks.size || [...currentNetworks].some((id) => !knownNetworks.has(id))) {
    companionNetwork.replaceChildren();
    companionNetwork.add(new Option("Select a trusted private network", ""));
    for (const network of status.networks) {
      companionNetwork.add(new Option(`${network.name} — ${network.address}${network.recommended ? " (recommended)" : ""}`, network.id));
    }
  }
  companionNetwork.value = status.selectedNetworkId ?? "";
  companionAddresses.replaceChildren();
  for (const address of status.addresses) {
    const line = document.createElement("p");
    line.textContent = address;
    companionAddresses.append(line);
  }
  companionPairButton.disabled = status.runtimeState !== "listening";
  companionCancelPairButton.disabled = !status.pairing;
  companionPairing.classList.toggle("is-hidden", !status.pairing);
  if (status.pairing) {
    companionPairingExpiresAt = Date.parse(status.pairing.expiresAt);
    companionQr.src = status.pairing.qrDataUrl;
    companionPairAddress.textContent = status.pairing.address;
    companionPairCode.textContent = status.pairing.code;
    updateCompanionPairingCountdown();
  } else {
    companionPairingExpiresAt = 0;
    companionQr.removeAttribute("src");
    companionPairAddress.textContent = "";
    companionPairCode.textContent = "";
    companionPairExpiry.textContent = "";
  }
  companionDevices.replaceChildren();
  if (!status.devices.length) companionDevices.textContent = "No phones paired.";
  for (const device of status.devices) {
    const row = document.createElement("article");
    row.className = "download-row";
    const summary = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = device.name;
    const details = document.createElement("small");
    details.textContent = `${device.connected ? "Connected" : "Offline"} · Paired ${new Date(device.pairedAt).toLocaleDateString()}${device.lastUsedAt ? ` · Last used ${new Date(device.lastUsedAt).toLocaleString()}` : ""}`;
    summary.append(title, details);
    const actions = document.createElement("div");
    const rename = document.createElement("button");
    rename.type = "button";
    rename.textContent = "Rename";
    rename.addEventListener("click", () => {
      const name = window.prompt("Device name", device.name);
      if (name) void window.jellyfin.companion.renameDevice({ deviceId: device.deviceId, name }).then(renderCompanion).catch((error) => showToast(errorMessage(error, "The device could not be renamed.")));
    });
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", () => {
      if (window.confirm(`Revoke ${device.name}? It will need to be paired again.`)) {
        void window.jellyfin.companion.revokeDevice({ deviceId: device.deviceId }).then(renderCompanion).catch((error) => showToast(errorMessage(error, "The device could not be revoked.")));
      }
    });
    actions.append(rename, revoke);
    row.append(summary, actions);
    companionDevices.append(row);
  }
}

function renderCompanionNavStatus(status: CompanionSettingsState): void {
  const connected = status.connectedDevices > 0;
  const presentation = connected
    ? { state: "is-connected", label: `${status.connectedDevices} connected` }
    : status.enabled
      ? { state: "is-ready", label: status.runtimeState === "listening" ? "Ready" : "Needs attention" }
      : { state: "is-off", label: "Off" };
  companionNavStatusDot.className = `companion-nav-status ${presentation.state}`;
  navCompanionButton.title = `Phone Remote · ${presentation.label}`;
  navCompanionButton.setAttribute("aria-label", `Phone Remote, ${presentation.label.toLowerCase()}`);
}

async function refreshCompanionNavStatus(): Promise<void> {
  try { renderCompanionNavStatus(await window.jellyfin.companion.getStatus()); }
  catch { /* The gray default remains when Companion settings are unavailable. */ }
}

function updateCompanionPairingCountdown(): void {
  if (!companionPairingExpiresAt) return;
  const seconds = Math.max(0, Math.ceil((companionPairingExpiresAt - Date.now()) / 1000));
  companionPairExpiry.textContent = seconds > 0
    ? `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
    : "Pairing code expired.";
}

async function openCompanion(): Promise<void> {
  profileMenu.classList.add("is-hidden");
  profileButton.setAttribute("aria-expanded", "false");
  companionScrim.classList.remove("is-hidden");
  companionPanel.classList.remove("is-hidden");
  closeCompanionButton.focus();
  try { renderCompanion(await window.jellyfin.companion.getStatus()); }
  catch (error) { showToast(errorMessage(error, "Companion Remote settings could not be loaded.")); }
}

function closeCompanion(): void {
  companionScrim.classList.add("is-hidden");
  companionPanel.classList.add("is-hidden");
}

async function refreshDownloads(isCurrent: () => boolean = () => true): Promise<void> {
  const [downloads, offlinePlayable, smartDownloads] = await Promise.all([
    window.jellyfin.downloads.list(),
    window.jellyfin.downloads.listOfflinePlayable(),
    window.jellyfin.smartDownloads.getState(),
  ]);
  if (!isCurrent()) return;
  state.downloads = downloads;
  state.offlinePlayable = offlinePlayable;
  state.smartDownloads = smartDownloads;
  syncDownloadedLibrary();
  renderDownloads();
  renderSmartDownloads();
  updateDetailSmartDownloadsButton();
  syncVisibleDownloadButtons();
}

function syncDownloadedLibrary(): void {
  const previousItems = state.libraryCache.get(DOWNLOADED_LIBRARY_ID);
  const items = groupMovieVersions(state.offlinePlayable.map((entry) => entry.item));
  const changed = previousItems
    ? !mediaItemsEqual(previousItems, items)
    : items.length > 0;
  const wasSelected = state.selectedLibraryId === DOWNLOADED_LIBRARY_ID;

  if (items.length) state.libraryCache.set(DOWNLOADED_LIBRARY_ID, items);
  else state.libraryCache.delete(DOWNLOADED_LIBRARY_ID);

  if (!changed && Boolean(previousItems?.length) === Boolean(items.length)) return;
  renderLibraryNavigation();
  if (!wasSelected || state.currentRoute !== "library") return;
  if (items.length) {
    state.selectedLibraryId = DOWNLOADED_LIBRARY_ID;
    libraryTitle.textContent = DOWNLOADED_LIBRARY.name;
    renderLibraryGrid(items);
    setRoute("library", { preserveScroll: true });
    return;
  }
  const fallback = supportedLibraries()[0];
  if (fallback) void openLibrary(fallback.id);
  else openHome();
}

function smartStatusLabel(status: SmartSeriesSummary["status"]): string {
  if (status === "checking") return "Checking";
  if (status === "offline") return "Offline";
  if (status === "attention") return "Needs attention";
  return "Ready";
}

function renderSmartDownloads(): void {
  smartDownloadsList.replaceChildren();
  if (!state.smartDownloads.series.length) {
    const empty = document.createElement("p");
    empty.className = "downloads-note";
    empty.textContent = "Follow a series from its details page to keep upcoming episodes ready.";
    smartDownloadsList.append(empty);
    checkSmartDownloadsButton.disabled = true;
    return;
  }
  checkSmartDownloadsButton.disabled = state.smartDownloads.series.some((series) => series.status === "checking");
  for (const series of state.smartDownloads.series) {
    const card = document.createElement("article");
    const heading = document.createElement("header");
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    const status = document.createElement("small");
    const controls = document.createElement("div");
    const limitLabel = document.createElement("label");
    const limit = document.createElement("select");
    const unfollow = document.createElement("button");
    card.className = "smart-series-card";
    title.textContent = series.name;
    status.textContent = smartStatusLabel(series.status);
    copy.append(title, status);
    heading.append(copy);
    controls.className = "smart-series-controls";
    for (let value = 1; value <= 5; value += 1) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = String(value);
      limit.append(option);
    }
    limit.value = String(series.episodeLimit);
    limit.setAttribute("aria-label", `Episodes to keep for ${series.name}`);
    limit.addEventListener("change", () => { void changeSmartDownloadLimit(series, limit); });
    limitLabel.append(document.createTextNode("Keep"), limit, document.createTextNode("episodes"));
    unfollow.type = "button";
    unfollow.textContent = "Unfollow";
    unfollow.addEventListener("click", () => { void unfollowSmartSeries(series, unfollow); });
    controls.append(limitLabel, unfollow);
    card.append(heading);
    if (series.lastSuccessfulCheck !== null) {
      const checked = document.createElement("small");
      checked.textContent = `Last checked ${new Date(series.lastSuccessfulCheck).toLocaleString()}`;
      card.append(checked);
    }
    if (series.error) {
      const error = document.createElement("p");
      error.className = "smart-series-error";
      error.textContent = series.error.message;
      card.append(error);
    }
    card.append(controls);
    smartDownloadsList.append(card);
  }
}

async function changeSmartDownloadLimit(series: SmartSeriesSummary, select: HTMLSelectElement): Promise<void> {
  select.disabled = true;
  try {
    state.smartDownloads = await window.jellyfin.smartDownloads.setLimit({
      seriesId: series.seriesId,
      episodeLimit: Number(select.value),
    });
    renderSmartDownloads();
    updateDetailSmartDownloadsButton();
  } catch (error) {
    select.value = String(series.episodeLimit);
    select.disabled = false;
    showToast(errorMessage(error, "The Smart Download limit could not be changed."));
  }
}

async function unfollowSmartSeries(series: SmartSeriesSummary, button: HTMLButtonElement): Promise<void> {
  smartUnfollowDialogDescription.textContent = `Choose what happens to existing ${series.name} copies.`;
  const disposition = await showDialog(smartUnfollowDialog);
  if (disposition !== "keep" && disposition !== "remove") return;
  button.disabled = true;
  try {
    const result = await window.jellyfin.smartDownloads.unfollow({ seriesId: series.seriesId, disposition });
    state.smartDownloads = result.state;
    await refreshDownloads();
    updateDetailSmartDownloadsButton();
    showToast(result.warning ?? `${series.name} is no longer followed.`);
  } catch (error) {
    button.disabled = false;
    showToast(errorMessage(error, "The series could not be unfollowed."));
  }
}

async function checkSmartDownloads(): Promise<void> {
  checkSmartDownloadsButton.disabled = true;
  try {
    state.smartDownloads = await window.jellyfin.smartDownloads.checkNow();
    renderSmartDownloads();
    if (!state.smartDownloads.notice) showToast("Smart Downloads are up to date.");
  } catch (error) {
    showToast(errorMessage(error, "Smart Downloads could not be checked."));
  } finally {
    renderSmartDownloads();
  }
}

function renderDownloadLocation(): void {
  downloadLocationLabel.textContent = state.downloadLocation?.label ?? "Loading download location...";
  defaultDownloadLocationButton.classList.toggle("is-hidden", state.downloadLocation?.mode !== "custom");
}

async function refreshDownloadLocation(): Promise<void> {
  state.downloadLocation = await window.jellyfin.downloads.getLocation();
  renderDownloadLocation();
}

async function chooseDownloadLocation(): Promise<void> {
  chooseDownloadLocationButton.disabled = true;
  try {
    const location = await window.jellyfin.downloads.chooseLocation();
    if (!location) return;
    state.downloadLocation = location;
    renderDownloadLocation();
    showToast("New downloads will use the selected location.");
  } catch (error) {
    showToast(errorMessage(error, "The download location could not be changed."));
  } finally {
    chooseDownloadLocationButton.disabled = false;
  }
}

async function useDefaultDownloadLocation(): Promise<void> {
  defaultDownloadLocationButton.disabled = true;
  try {
    state.downloadLocation = await window.jellyfin.downloads.useDefaultLocation();
    renderDownloadLocation();
    showToast("New downloads will use your Windows Videos folder.");
  } catch (error) {
    showToast(errorMessage(error, "The default download location could not be restored."));
  } finally {
    defaultDownloadLocationButton.disabled = false;
  }
}

async function openDownloadLocation(): Promise<void> {
  openDownloadLocationButton.disabled = true;
  try {
    await window.jellyfin.downloads.openLocation();
  } catch (error) {
    showToast(errorMessage(error, "The download folder could not be opened."));
  } finally {
    openDownloadLocationButton.disabled = false;
  }
}

async function startDownload(item: MediaItem, version: MediaVersion | null = null): Promise<void> {
  const targetItemId = version?.itemId ?? item.id;
  const existing = state.downloads.find((download) => download.itemId === targetItemId
    && (!version || download.mediaSourceId === version.mediaSourceId)
    && download.state !== "missing");
  if (existing) {
    openDownloads();
    return;
  }
  try {
    const download = await window.jellyfin.downloads.start({
      itemId: targetItemId,
      ...(version ? { preferredMediaSourceId: version.mediaSourceId } : {}),
    });
    state.downloads = [download, ...state.downloads.filter((entry) => entry.downloadId !== download.downloadId)];
    renderDownloads();
    syncVisibleDownloadButtons();
    openDownloads();
  } catch (error) {
    showToast(errorMessage(error, "The download could not be started."));
  }
}

async function performDownloadAction(download: DownloadSummary, action: "pause" | "resume" | "retry" | "cancel" | "delete"): Promise<void> {
  try {
    if (action === "pause") await window.jellyfin.downloads.pause({ downloadId: download.downloadId });
    else if (action === "resume") await window.jellyfin.downloads.resume({ downloadId: download.downloadId });
    else if (action === "retry") await window.jellyfin.downloads.retry({ downloadId: download.downloadId });
    else if (action === "cancel") await window.jellyfin.downloads.cancel({ downloadId: download.downloadId });
    else await window.jellyfin.downloads.delete({ downloadId: download.downloadId });
    await refreshDownloads();
  } catch (error) {
    showToast(errorMessage(error, `The download could not ${action}.`));
  }
}

async function skipSmartDownload(download: DownloadSummary): Promise<void> {
  try {
    state.smartDownloads = await window.jellyfin.smartDownloads.skip({ downloadId: download.downloadId });
    await refreshDownloads();
    showToast(`${download.name} will be skipped by Smart Downloads.`);
  } catch (error) {
    showToast(errorMessage(error, "The Smart Download could not be skipped."));
  }
}

function renderDownloads(): void {
  downloadsList.replaceChildren();
  if (!state.downloads.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No downloads yet. Choose Download on a movie or episode.";
    downloadsList.append(empty);
    return;
  }
  for (const download of state.downloads) {
    const card = document.createElement("article");
    const heading = document.createElement("div");
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    const type = document.createElement("span");
    const status = document.createElement("span");
    const size = document.createElement("span");
    const controls = document.createElement("div");
    card.className = "download-card";
    heading.className = "download-card-heading";
    title.textContent = download.name;
    type.textContent = [download.itemType, download.versionLabel, download.smartManaged ? "Smart download" : ""].filter(Boolean).join(" · ");
    type.classList.toggle("smart-download-badge", download.smartManaged);
    status.className = "download-status";
    status.textContent = download.state;
    copy.append(title, type);
    heading.append(copy, status);
    card.append(heading);

    if (download.expectedSize !== null) {
      const progress = document.createElement("progress");
      progress.className = "download-progress";
      progress.max = download.expectedSize;
      progress.value = Math.min(download.expectedSize, download.bytesDownloaded);
      progress.setAttribute("aria-label", `${download.progressPercent ?? 0} percent downloaded`);
      card.append(progress);
    }
    size.className = "download-size";
    size.textContent = download.expectedSize === null
      ? formatBytes(download.bytesDownloaded)
      : `${formatBytes(download.bytesDownloaded)} of ${formatBytes(download.expectedSize)}`;
    card.append(size);
    if (download.error) {
      const error = document.createElement("p");
      error.className = "download-error";
      error.textContent = download.error.message;
      card.append(error);
    }

    controls.className = "download-controls";
    const progressiveAttemptAvailable = (download.state === "downloading" || download.state === "paused")
      && download.expectedSize !== null
      && download.expectedSize > 0;
    if (download.state === "downloaded" || progressiveAttemptAvailable) {
      const play = document.createElement("button");
      play.type = "button";
      play.className = "primary";
      play.textContent = download.state === "downloaded" ? "Play" : "Watch now";
      play.addEventListener("click", () => { void playDownloadedItem(download); });
      controls.append(play);
      if (download.state !== "downloaded") {
        const availability = document.createElement("p");
        availability.className = "download-availability";
        availability.textContent = download.state === "paused"
          ? "Watch now checks the current buffer. Resume the download if more video is needed."
          : "Watch now checks whether enough video has buffered.";
        card.append(availability);
      }
    } else if (["queued", "downloading", "paused", "failed"].includes(download.state)) {
      const play = document.createElement("button");
      const availability = document.createElement("p");
      const explanation = download.state === "failed"
        ? "Retry the download before watching the partial copy."
        : download.expectedSize === null
          ? "Watch while downloading is unavailable because the total file size is unknown."
          : download.state === "queued"
            ? "Watch now becomes available after the download starts and buffers enough video."
            : "Buffering enough video to enable Watch now.";
      play.type = "button";
      play.disabled = true;
      play.textContent = "Watch now";
      play.title = explanation;
      availability.className = "download-availability";
      availability.textContent = explanation;
      card.append(availability);
      controls.append(play);
    }
    const action = (label: string, kind: "pause" | "resume" | "retry" | "cancel" | "delete"): void => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => { void performDownloadAction(download, kind); });
      controls.append(button);
    };
    if (download.canPause) action("Pause", "pause");
    if (download.canResume) action("Resume", "resume");
    if (download.canRetry) action("Retry", "retry");
    if (download.smartManaged && (download.canCancel || download.canDelete)) {
      const skip = document.createElement("button");
      skip.type = "button";
      skip.textContent = download.canDelete ? "Remove & skip" : "Skip episode";
      skip.addEventListener("click", () => { void skipSmartDownload(download); });
      controls.append(skip);
    } else {
      if (download.canCancel) action("Cancel", "cancel");
      if (download.canDelete) action("Delete copy", "delete");
    }

    const keep = document.createElement("label");
    const checkbox = document.createElement("input");
    keep.className = "download-keep";
    checkbox.type = "checkbox";
    checkbox.checked = download.keepDownloaded;
    checkbox.addEventListener("change", async () => {
      checkbox.disabled = true;
      try {
        await window.jellyfin.downloads.setKeep({ downloadId: download.downloadId, keepDownloaded: checkbox.checked });
        await refreshDownloads();
      } catch (error) {
        checkbox.checked = !checkbox.checked;
        checkbox.disabled = false;
        showToast(errorMessage(error, "Keep Downloaded could not be changed."));
      }
    });
    keep.append(checkbox, document.createTextNode("Keep downloaded"));
    controls.append(keep);
    card.append(controls);
    downloadsList.append(card);
  }
}

interface PlaybackPresentation {
  item: MediaItem | null;
  itemId: string;
  resumeMode: "resume" | "start-over";
  title: string;
  meta: string;
  failureMessage: string;
  liveChannelId?: string;
  progressiveOnly?: boolean;
  preferredMediaSourceId?: string;
  versionLabel?: string;
}

let playerViewportRevision = 0;
let playerViewportFrame: number | null = null;

async function syncPlayerViewport(
  visible = !playerView.classList.contains("is-hidden") && Boolean(state.playbackId || state.playbackItem),
): Promise<boolean> {
  const bounds = playerViewport.getBoundingClientRect();
  const scrollport = playerCenter.getBoundingClientRect();
  const fullyInsideScrollport = bounds.left >= scrollport.left
    && bounds.right <= scrollport.right
    && bounds.top >= scrollport.top
    && bounds.bottom <= scrollport.bottom;
  const result = await window.jellyfin.playback.setViewport({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    visible: visible && fullyInsideScrollport && bounds.width >= 16 && bounds.height >= 16,
    revision: ++playerViewportRevision,
    deviceScaleFactor: Math.max(0.5, Math.min(4, window.devicePixelRatio || 1)),
  }).catch(() => ({ embedded: false }));
  return result.embedded;
}

function schedulePlayerViewport(): void {
  if (playerViewportFrame !== null) return;
  playerViewportFrame = requestAnimationFrame(() => {
    playerViewportFrame = null;
    void syncPlayerViewport();
  });
}

function schedulePlayerViewportSettled(): void {
  schedulePlayerViewport();
  requestAnimationFrame(() => requestAnimationFrame(schedulePlayerViewport));
  setTimeout(() => void syncPlayerViewport(), 120);
}

function setTone(element: HTMLElement, tone: string): void {
  element.dataset.tone = tone;
}

function replacePlayPauseIcon(paused: boolean): void {
  playerPlayIcon.replaceChildren();
  if (paused) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "m8 5 11 7-11 7z");
    playerPlayIcon.append(path);
    return;
  }
  const left = document.createElementNS("http://www.w3.org/2000/svg", "path");
  const right = document.createElementNS("http://www.w3.org/2000/svg", "path");
  left.setAttribute("d", "M8 5v14");
  right.setAttribute("d", "M16 5v14");
  playerPlayIcon.append(left, right);
}

function playbackForPlayer(): PlaybackState | null {
  const playback = state.playbackState;
  if (!playback) return null;
  if (!state.playbackId || playback.playbackId === state.playbackId) return playback;
  if (playback.playbackId === null && ["ended", "stopped", "error", "disconnected"].includes(playback.phase)) return playback;
  return null;
}

function playbackSourceKind(): PlaybackSourceKind | null {
  return playbackForPlayer()?.diagnostics?.sourceKind || state.playbackSourceKind;
}

function renderTrackSelect(select: HTMLSelectElement, tracks: PlaybackTrack[], includeOff: boolean): void {
  const selected = tracks.find((track) => track.selected)?.id ?? null;
  select.replaceChildren();
  if (includeOff) {
    const off = document.createElement("option");
    off.value = "";
    off.textContent = "Off";
    select.append(off);
  }
  for (const track of tracks) {
    const option = document.createElement("option");
    option.value = String(track.id);
    option.textContent = trackLabel(track);
    option.selected = selected === track.id;
    select.append(option);
  }
  if (!includeOff && tracks.length === 0) {
    const fallback = document.createElement("option");
    fallback.value = "";
    fallback.textContent = "Default";
    select.append(fallback);
  }
  if (includeOff && selected === null) select.value = "";
  select.disabled = tracks.length === 0;
}

function renderRateSelect(select: HTMLSelectElement, rate: number, disabled: boolean): void {
  const value = String(rate);
  for (const transient of select.querySelectorAll<HTMLOptionElement>("option[data-transient-rate]")) transient.remove();
  if (!Array.from(select.options).some((option) => option.value === value)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = `${rate.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}×`;
    option.dataset.transientRate = "true";
    select.append(option);
  }
  select.value = value;
  select.disabled = disabled;
}

function trackStructure(tracks: PlaybackTrack[]): unknown[] {
  return tracks.map((track) => [
    track.id,
    track.type,
    track.title,
    track.language,
    track.codec,
    track.channels,
    track.selected,
    track.external,
    track.isForced,
    track.isDefault,
  ]);
}

function playerStructureKey(playback: PlaybackState | null): string {
  const diagnostics = playback?.diagnostics;
  const item = state.soloDiagnostics?.item || state.playbackItem;
  const next = state.soloDiagnostics?.nextUp || null;
  const connection = state.soloDiagnostics?.connection;
  const group = state.watchParties?.joinedGroup;
  return JSON.stringify({
    playback: playback ? {
      playbackId: playback.playbackId,
      itemId: playback.itemId,
      phase: playback.phase,
      source: playback.source,
      sourceKind: diagnostics?.sourceKind,
      rate: diagnostics?.playbackRate,
      bufferAheadTicks: diagnostics?.bufferAheadTicks,
      container: diagnostics?.container,
      resolution: diagnostics?.resolution,
      videoCodec: diagnostics?.videoCodec,
      audioCodec: diagnostics?.audioCodec,
      audioChannels: diagnostics?.audioChannels,
      bitrate: diagnostics?.bitrate,
      videoRange: diagnostics?.videoRange,
      transcodeReason: diagnostics?.transcodeReason,
      videoOutput: diagnostics?.videoOutput,
      videoOutputHealthy: diagnostics?.videoOutputHealthy,
      hardwareDecoding: diagnostics?.hardwareDecoding,
      renderFallbackUsed: diagnostics?.renderFallbackUsed,
      audioTracks: trackStructure(playback.audioTracks),
      subtitleTracks: trackStructure(playback.subtitleTracks),
    } : null,
    item: item ? [item.id, item.name, item.type, item.seriesName, item.indexNumber, item.parentIndexNumber, item.runTimeTicks, item.overview] : null,
    next: next ? [next.id, next.name, next.type, next.seriesName, next.indexNumber, next.parentIndexNumber, next.runTimeTicks] : null,
    connection: connection ? [connection.state, connection.serverName, connection.serverVersion, connection.requestLatencyMs] : null,
    panelView: state.sessionPanelView,
    group: group ? [group.groupId, group.name, group.playbackState, group.participantCount, group.participants, group.currentItemId, group.playlistItemId] : null,
    watchPartyAvailability: state.watchParties?.availability,
    watchPartyConnection: state.watchParties?.connection,
    watchPartyError: state.watchParties?.error,
  });
}

function renderPlayerStructure(playback: PlaybackState | null): void {
  renderTrackSelect(playerAudioSelect, playback?.audioTracks || [], false);
  renderTrackSelect(playerSubtitleSelect, playback?.subtitleTracks || [], true);
  renderTrackSelect(playerSettingsAudioSelect, playback?.audioTracks || [], false);
  renderTrackSelect(playerSettingsSubtitleSelect, playback?.subtitleTracks || [], true);
  if (!state.playbackId) {
    playerAudioSelect.disabled = true;
    playerSubtitleSelect.disabled = true;
    playerSettingsAudioSelect.disabled = true;
    playerSettingsSubtitleSelect.disabled = true;
  }
  renderPlayerMetadata();
  renderSessionPanel();
}

function currentPlayerEpisode(): MediaItem | null {
  const item = state.soloDiagnostics?.item || state.playbackItem;
  return item?.type === "Episode" && item.seriesId ? item : null;
}

function closePlayerEpisodeBrowser(restoreFocus = true): void {
  if (playerEpisodeBrowser.classList.contains("is-hidden")) return;
  state.playerEpisodeBrowserRequestId += 1;
  playerEpisodeBrowser.classList.add("is-hidden");
  playerEpisodeBrowserButton.setAttribute("aria-expanded", "false");
  if (restoreFocus) playerEpisodeBrowserButton.focus({ preventScroll: true });
  markPlayerActivity();
}

function renderPlayerEpisodeList(): void {
  const current = currentPlayerEpisode();
  const currentItemId = playbackForPlayer()?.itemId || current?.id || null;
  const episodes = state.playerEpisodeBrowserEpisodes;
  playerEpisodeList.replaceChildren();
  playerEpisodeBrowserStatus.textContent = episodes.length > 0
    ? `${episodes.length} ${episodes.length === 1 ? "episode" : "episodes"}`
    : "No episodes are available for this season.";

  for (const episode of episodes) {
    const isCurrent = episode.id === currentItemId;
    const playable = canPlay(episode);
    const entry = document.createElement("button");
    entry.type = "button";
    entry.className = "player-episode-entry";
    entry.disabled = isCurrent || !playable;
    entry.setAttribute("aria-current", isCurrent ? "true" : "false");

    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = [episodeCode(episode), episode.name].filter(Boolean).join(" · ");
    const details = document.createElement("small");
    const positionTicks = episode.userData.playbackPositionTicks || 0;
    const progress = episode.userData.played
      ? "Watched"
      : positionTicks > 0 ? `Resume at ${formatPlaybackTime(positionTicks)}` : runtime(episode);
    details.textContent = [progress].filter(Boolean).join(" · ");
    copy.append(title, details);

    const action = document.createElement("span");
    action.className = "player-episode-entry-action";
    action.textContent = isCurrent
      ? "Now playing"
      : !playable ? "Unavailable" : positionTicks > 0 ? "Resume" : "Play";
    entry.append(copy, action);
    entry.addEventListener("click", () => {
      closePlayerEpisodeBrowser(false);
      void playItem(episode);
    });
    playerEpisodeList.append(entry);
  }
}

async function loadPlayerEpisodeSeason(seriesId: string, seasonId: string): Promise<void> {
  const requestId = ++state.playerEpisodeBrowserRequestId;
  state.playerEpisodeBrowserSeasonId = seasonId;
  state.playerEpisodeBrowserEpisodes = [];
  playerEpisodeList.replaceChildren();
  playerEpisodeBrowserStatus.textContent = "Loading episodes…";
  try {
    const episodes = await window.jellyfin.shows.getEpisodes({ seriesId, seasonId });
    if (requestId !== state.playerEpisodeBrowserRequestId
      || playerEpisodeBrowser.classList.contains("is-hidden")
      || state.playerEpisodeBrowserSeriesId !== seriesId) return;
    state.playerEpisodeBrowserEpisodes = episodes;
    renderPlayerEpisodeList();
  } catch (error) {
    if (requestId !== state.playerEpisodeBrowserRequestId) return;
    playerEpisodeBrowserStatus.textContent = errorMessage(error, "Episodes could not be loaded.");
  }
}

async function refreshPlayerEpisodeBrowser(): Promise<void> {
  const current = currentPlayerEpisode();
  if (!current?.seriesId || playerAdapterPreference?.active !== "libmpv") {
    closePlayerEpisodeBrowser(false);
    return;
  }

  const seriesId = current.seriesId;
  const requestId = ++state.playerEpisodeBrowserRequestId;
  state.playerEpisodeBrowserSeriesId = seriesId;
  state.playerEpisodeBrowserSeasonId = null;
  state.playerEpisodeBrowserSeasons = [];
  state.playerEpisodeBrowserEpisodes = [];
  playerEpisodeBrowserTitle.textContent = current.seriesName || "Episodes";
  playerEpisodeSeasonSelect.disabled = true;
  playerEpisodeSeasonSelect.replaceChildren(new Option("Loading…", ""));
  playerEpisodeList.replaceChildren();
  playerEpisodeBrowserStatus.textContent = "Loading seasons…";

  try {
    const seasons = await window.jellyfin.shows.getSeasons({ itemId: seriesId });
    if (requestId !== state.playerEpisodeBrowserRequestId
      || playerEpisodeBrowser.classList.contains("is-hidden")
      || state.playerEpisodeBrowserSeriesId !== seriesId) return;

    state.playerEpisodeBrowserSeasons = seasons;
    playerEpisodeSeasonSelect.replaceChildren();
    for (const season of seasons) {
      playerEpisodeSeasonSelect.append(new Option(
        season.name || (season.indexNumber == null ? "Season" : `Season ${season.indexNumber}`),
        season.id,
      ));
    }
    const selectedSeason = seasons.find((season) => season.id === current.seasonId)
      || seasons.find((season) => season.indexNumber === current.parentIndexNumber)
      || seasons[0];
    if (!selectedSeason) {
      playerEpisodeBrowserStatus.textContent = "No seasons are available for this show.";
      return;
    }
    state.playerEpisodeBrowserSeasonId = selectedSeason.id;
    playerEpisodeSeasonSelect.value = selectedSeason.id;
    playerEpisodeSeasonSelect.disabled = false;
    await loadPlayerEpisodeSeason(seriesId, selectedSeason.id);
  } catch (error) {
    if (requestId !== state.playerEpisodeBrowserRequestId) return;
    playerEpisodeBrowserStatus.textContent = errorMessage(error, "Seasons could not be loaded.");
  }
}

function openPlayerEpisodeBrowser(): void {
  if (!currentPlayerEpisode() || playerAdapterPreference?.active !== "libmpv") return;
  const scrollLeft = playerCenter.scrollLeft;
  const scrollTop = playerCenter.scrollTop;
  closePlayerSettings(false);
  playerEpisodeBrowser.classList.remove("is-hidden");
  playerEpisodeBrowserButton.setAttribute("aria-expanded", "true");
  keepPlayerControlsVisible();
  closePlayerEpisodeBrowserButton.focus({ preventScroll: true });
  if (playerCenter.scrollLeft !== scrollLeft) playerCenter.scrollLeft = scrollLeft;
  if (playerCenter.scrollTop !== scrollTop) playerCenter.scrollTop = scrollTop;
  void refreshPlayerEpisodeBrowser();
}

function renderPlayerMetadata(): void {
  const playback = playbackForPlayer();
  const item = state.soloDiagnostics?.item || state.playbackItem;
  const diagnostics = playback?.diagnostics;
  playerMetadataTitle.textContent = item?.name || playerTitle.textContent || "Now Playing";
  playerEyebrow.textContent = item?.type === "Episode"
    ? [item.seriesName, episodeCode(item)].filter(Boolean).join(" · ")
    : item?.type || "";
  playerOverview.textContent = item?.overview || "";
  playerOverview.classList.toggle("is-hidden", !item?.overview);

  const pills = [
    item && itemYear(item) ? String(itemYear(item)) : null,
    item ? runtime(item) : null,
    diagnostics?.versionLabel,
    diagnostics?.resolution,
    diagnostics?.container?.toUpperCase() || null,
    diagnostics?.videoCodec?.toUpperCase() || null,
    diagnostics?.audioCodec?.toUpperCase() || null,
    diagnostics?.audioChannels,
    diagnostics?.videoRange,
  ].filter((value): value is string => Boolean(value));
  playerMediaPills.replaceChildren();
  for (const value of pills) {
    const pill = document.createElement("span");
    pill.textContent = value;
    playerMediaPills.append(pill);
  }
  playerMediaPills.classList.toggle("is-hidden", pills.length === 0);

  const episodeBrowserAvailable = playerAdapterPreference?.active === "libmpv"
    && item?.type === "Episode"
    && Boolean(item.seriesId);
  playerEpisodeBrowserButton.classList.toggle("is-hidden", !episodeBrowserAvailable);
  playerEpisodeBrowserButton.disabled = !episodeBrowserAvailable;
  if (!episodeBrowserAvailable) closePlayerEpisodeBrowser(false);

  const next = state.soloDiagnostics?.nextUp || null;
  playerNextCard.classList.toggle("is-hidden", !next);
  playerNextButton.disabled = !next || !canPlay(next);
  if (next) {
    playerNextTitle.textContent = next.name;
    playerNextMeta.textContent = [episodeCode(next), next.seriesName, runtime(next)].filter(Boolean).join(" · ");
    playerNextCardButton.disabled = !canPlay(next);
  } else {
    playerNextTitle.textContent = "";
    playerNextMeta.textContent = "";
    playerNextCardButton.disabled = true;
  }
}

function renderNextEpisodeCountdown(playback: PlaybackState | null): void {
  const countdown = playback?.nextEpisodeCountdown;
  nextEpisodeCountdown.classList.toggle("is-hidden", !countdown);
  if (!countdown) {
    nextEpisodeCountdownTitle.textContent = "Next episode";
    nextEpisodeCountdownMeta.textContent = "";
    nextEpisodeCountdownLabel.textContent = "";
    nextEpisodeCountdownProgress.value = 0;
    return;
  }
  const episode = countdown.seasonNumber !== null && countdown.episodeNumber !== null
    ? `S${countdown.seasonNumber} E${countdown.episodeNumber}`
    : null;
  const seconds = Math.max(0, countdown.remainingSeconds);
  nextEpisodeCountdownTitle.textContent = countdown.title;
  nextEpisodeCountdownMeta.textContent = [countdown.seriesName, episode].filter(Boolean).join(" · ");
  nextEpisodeCountdownLabel.textContent = `Playing in ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  nextEpisodeCountdownProgress.max = Math.max(1, countdown.totalSeconds);
  nextEpisodeCountdownProgress.value = Math.min(nextEpisodeCountdownProgress.max, seconds);
  nextEpisodePlayNowButton.disabled = false;
  nextEpisodeCancelButton.disabled = false;
}

function clearPlaybackFeatures(): void {
  playbackFeatureRequestId += 1;
  playbackSegments = [];
  trickplayManifest = null;
  trickplaySpriteUrls.clear();
  previewPendingUrl = "";
  trickplaySpriteRequestId += 1;
  if (trickplaySpriteTimer) clearTimeout(trickplaySpriteTimer);
  trickplaySpriteTimer = null;
  playerSegmentSkipButton.classList.add("is-hidden");
  playerSegmentSkipButton.disabled = false;
  playerSegmentSkipButton.removeAttribute("aria-describedby");
  playerTimelinePreview.classList.add("is-hidden");
  playerTimelinePreviewImage.classList.add("is-hidden");
  playerTimelinePreviewImg.removeAttribute("src");
}

async function loadPlaybackFeatures(playback: PlaybackState): Promise<void> {
  if (!playback.playbackId || !playback.itemId || playback.contentKind === "live-tv") return;
  const requestId = ++playbackFeatureRequestId;
  const playbackId = playback.playbackId;
  const itemId = playback.itemId;
  void window.jellyfin.playbackFeatures.getMediaSegments({ playbackId }).then((result) => {
    if (requestId !== playbackFeatureRequestId || state.playbackId !== playbackId || playbackForPlayer()?.itemId !== itemId || result.itemId !== itemId) return;
    playbackSegments = result.segments;
    renderPlayerState();
  }).catch(() => undefined);
  void window.jellyfin.playbackFeatures.getTrickplayManifest({ playbackId }).then((manifest) => {
    if (requestId !== playbackFeatureRequestId || state.playbackId !== playbackId || playbackForPlayer()?.itemId !== itemId) return;
    trickplayManifest = manifest?.itemId === itemId ? manifest : null;
    if (previewHovering || previewFocused || playerTimeline.dataset.scrubbing === "true") scheduleTrickplaySprite();
  }).catch(() => undefined);
}

function renderSegmentSkip(playback: PlaybackState | null): void {
  const segment = playback && playback.contentKind !== "live-tv"
    ? activeMediaSegment(playbackSegments, playback.positionTicks)
    : null;
  const visible = Boolean(segment && state.playbackId === playback?.playbackId);
  const enabled = Boolean(segment && playback?.seekable && canSkipSegment(segment, playback.seekableUntilTicks));
  const focused = document.activeElement === playerSegmentSkipButton;
  playerSegmentSkipButton.classList.toggle("is-hidden", !visible);
  if (!segment) {
    playerSegmentSkipButton.disabled = false;
    if (focused) (playerTimeline.disabled ? playerPlayPauseButton : playerTimeline).focus({ preventScroll: true });
    return;
  }
  playerSegmentSkipButton.textContent = segmentLabel(segment.type);
  playerSegmentSkipButton.disabled = !enabled;
  playerSegmentSkipButton.title = enabled ? segmentLabel(segment.type) : `${segmentLabel(segment.type)} is unavailable until more of the download is ready.`;
  playerSegmentSkipButton.setAttribute("aria-label", playerSegmentSkipButton.title);
  if (!enabled && focused) (playerTimeline.disabled ? playerPlayPauseButton : playerTimeline).focus({ preventScroll: true });
}

function hideTimelinePreviewIfInactive(): void {
  if (previewHovering || previewFocused || playerTimeline.dataset.scrubbing === "true") return;
  playerTimelinePreview.classList.add("is-hidden");
  playerTimelinePreviewImage.classList.add("is-hidden");
}

function presentTimelinePreview(targetTicks: number, pointerX?: number): void {
  const playback = playbackForPlayer();
  if (!playback || playback.durationTicks <= 0 || playback.contentKind === "live-tv") return;
  previewTargetTicks = Math.max(0, Math.min(playback.durationTicks, targetTicks));
  const bounds = playerTimelineTrack.getBoundingClientRect();
  const localX = pointerX === undefined
    ? bounds.width * (previewTargetTicks / playback.durationTicks)
    : Math.max(0, Math.min(bounds.width, pointerX - bounds.left));
  playerTimelinePreview.style.setProperty("--preview-left", `${clampedPreviewLeft(localX, bounds.width, 180)}px`);
  playerTimelinePreviewTime.textContent = formatPlaybackTime(previewTargetTicks);
  playerTimelinePreview.classList.remove("is-hidden");
  scheduleTrickplaySprite();
}

function scheduleTrickplaySprite(): void {
  if (trickplaySpriteTimer) clearTimeout(trickplaySpriteTimer);
  const playback = playbackForPlayer();
  const manifest = trickplayManifest;
  if (!playback || !manifest || manifest.playbackId !== playback.playbackId || manifest.itemId !== playback.itemId) {
    playerTimelinePreviewImage.classList.add("is-hidden");
    return;
  }
  const frame = trickplayFrame(manifest, previewTargetTicks, playback.durationTicks);
  previewPendingUrl = "";
  playerTimelinePreviewImage.classList.add("is-hidden");
  const applySprite = (url: string): void => {
    previewPendingUrl = url;
    playerTimelinePreviewImage.style.setProperty("--preview-x", `${frame.x}px`);
    playerTimelinePreviewImage.style.setProperty("--preview-y", `${frame.y}px`);
    if (playerTimelinePreviewImg.src === url && playerTimelinePreviewImg.complete && playerTimelinePreviewImg.naturalWidth > 0) {
      playerTimelinePreviewImage.classList.remove("is-hidden");
      return;
    }
    playerTimelinePreviewImg.src = url;
  };
  const cached = trickplaySpriteUrls.get(frame.spriteIndex);
  if (cached) {
    trickplaySpriteUrls.delete(frame.spriteIndex);
    trickplaySpriteUrls.set(frame.spriteIndex, cached);
    applySprite(cached);
    return;
  }
  const requestId = ++trickplaySpriteRequestId;
  trickplaySpriteTimer = setTimeout(() => {
    void window.jellyfin.playbackFeatures.getTrickplaySpriteUrl({
      playbackId: manifest.playbackId,
      manifestId: manifest.manifestId,
      spriteIndex: frame.spriteIndex,
    }).then((url) => {
      if (requestId !== trickplaySpriteRequestId || trickplayManifest?.manifestId !== manifest.manifestId) return;
      trickplaySpriteUrls.set(frame.spriteIndex, url);
      while (trickplaySpriteUrls.size > 3) trickplaySpriteUrls.delete(trickplaySpriteUrls.keys().next().value as number);
      applySprite(url);
    }).catch(() => {
      if (requestId === trickplaySpriteRequestId) playerTimelinePreviewImage.classList.add("is-hidden");
    });
  }, 100);
}

playerTimelinePreviewImg.addEventListener("load", () => {
  if (playerTimelinePreviewImg.currentSrc === previewPendingUrl || playerTimelinePreviewImg.src === previewPendingUrl) playerTimelinePreviewImage.classList.remove("is-hidden");
});
playerTimelinePreviewImg.addEventListener("error", () => playerTimelinePreviewImage.classList.add("is-hidden"));

function renderPlayerState(forceStructure = false): void {
  const playback = playbackForPlayer();
  renderNextEpisodeCountdown(playback);
  renderSegmentSkip(playback);
  const phase = playbackPhasePresentation(playback);
  const replayAvailable = !state.playbackId
    && Boolean(state.playbackItem)
    && Boolean(playback && ["stopped", "disconnected", "error", "ended"].includes(playback.phase));
  const sourceKind = playbackSourceKind();
  const connection = connectionStatePresentation(state.soloDiagnostics?.connection.state || "unknown");
  const joinedParty = state.watchParties?.joinedGroup || null;
  const preparation = state.watchParties?.preparation;
  const showPreparation = Boolean(
    joinedParty
    && preparation
    && ["waiting-for-participant", "preparing", "ready", "starting", "error"].includes(preparation.phase),
  );
  watchPartyStartCue.classList.toggle("is-hidden", !showPreparation);
  if (showPreparation && preparation) watchPartyStartCue.textContent = watchPartyPreparationLabel(preparation.phase);

  playerPhaseLabel.textContent = replayAvailable ? `${phase.label} — Replay available` : phase.label;
  setTone(playerFrameStatus, phase.tone);
  playerFrameStatus.classList.toggle("is-active", phase.active);

  const livePlayback = state.playbackItem?.type === "TvChannel" || playback?.contentKind === "live-tv";
  playerSourceBadge.textContent = livePlayback ? "LIVE" : sourceKindLabel(sourceKind);
  setTone(playerSourceBadge, sourceKind === "transcode" ? "amber" : sourceKind === "offline-local" ? "amber" : "violet");
  playerConnectionBadge.textContent = connection.label;
  setTone(playerConnectionBadge, connection.tone);
  playerSyncBadge.textContent = joinedParty ? `${joinedParty.name} · ${joinedParty.participantCount}` : "Solo";
  setTone(playerSyncBadge, joinedParty ? "blue" : "neutral");

  const positionTicks = playback?.positionTicks || 0;
  const durationTicks = playback?.durationTicks || 0;
  const seekableUntilTicks = playback?.seekableUntilTicks ?? durationTicks;
  const seekablePercent = durationTicks > 0 ? Math.max(0, Math.min(100, seekableUntilTicks / durationTicks * 100)) : 0;
  if (playerTimeline.dataset.scrubbing !== "true") playerTimeline.value = String(safeTimelineValue(positionTicks, durationTicks));
  playerTimeline.disabled = !playback?.seekable || durationTicks <= 0;
  playerTimeline.style.setProperty("--seekable-percent", `${seekablePercent}%`);
  playerTimeline.setAttribute("aria-valuetext", playback?.seekableUntilTicks === null || playback?.seekableUntilTicks === undefined
    ? formatPlaybackTime(positionTicks)
    : `${formatPlaybackTime(positionTicks)}; available through ${formatPlaybackTime(seekableUntilTicks)}`);
  playerTimeline.closest(".player-timeline-row")?.classList.toggle("is-hidden", livePlayback);
  playerLiveControls.classList.toggle("is-hidden", !livePlayback);
  document.querySelector(".player-rate-control")?.classList.toggle("is-hidden", livePlayback);
  playerCurrentTime.textContent = formatPlaybackTime(positionTicks);
  playerDuration.textContent = playback?.fullscreen
    ? `-${formatPlaybackTime(Math.max(0, durationTicks - positionTicks))}`
    : formatPlaybackTime(durationTicks);

  const paused = replayAvailable || playback?.paused !== false;
  replacePlayPauseIcon(paused);
  playerPlayPauseButton.setAttribute("aria-label", replayAvailable ? "Replay" : paused ? "Play" : "Pause");
  playerPlayPauseButton.title = replayAvailable ? "Replay" : paused ? "Play (Space or K)" : "Pause (Space or K)";
  playerPlayPauseButton.disabled = !replayAvailable
    && (!state.playbackId || !playback || ["resolving", "loading", "ended", "stopped", "error", "disconnected"].includes(playback.phase));
  playerBack10Button.disabled = !state.playbackId || !playback?.seekable;
  playerForward10Button.disabled = !state.playbackId || !playback?.seekable
    || (playback.seekableUntilTicks !== null && playback.positionTicks + 10 * TICKS_PER_SECOND > playback.seekableUntilTicks);
  playerBack10Button.classList.toggle("is-hidden", livePlayback);
  playerForward10Button.classList.toggle("is-hidden", livePlayback);

  const volume = Math.max(0, Math.min(100, Math.round(playback?.volume ?? (Number(playerVolume.value) || 100))));
  if (volume > 0) lastAudibleVolume = volume;
  playerVolume.value = String(volume);
  playerMuteButton.setAttribute("aria-label", volume === 0 ? "Unmute" : "Mute");
  playerMuteButton.title = volume === 0 ? "Unmute (M)" : "Mute (M)";
  const playbackRate = playback?.diagnostics?.playbackRate || 1;
  renderRateSelect(playerRateSelect, playbackRate, !state.playbackId);
  renderRateSelect(playerSettingsRateSelect, playbackRate, !state.playbackId);
  playerVolume.disabled = !state.playbackId;
  playerMuteButton.disabled = !state.playbackId;
  playerFullscreenButton.disabled = !state.playbackId;
  playerFullscreenButton.setAttribute("aria-label", playback?.fullscreen ? "Exit fullscreen" : "Enter fullscreen");
  playerFullscreenButton.title = playback?.fullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)";
  const wasFullscreen = playerView.dataset.fullscreen === "true";
  const isFullscreen = Boolean(playback?.fullscreen);
  playerView.dataset.fullscreen = String(isFullscreen);
  syncPlayerControlsPlacement(isFullscreen);
  if (wasFullscreen !== isFullscreen) {
    closePlayerSettings(false);
    setPlayerControlsIdle(false);
    schedulePlayerViewportSettled();
    if (isFullscreen) markPlayerActivity();
  }
  if (isFullscreen) {
    if (paused || playback?.phase !== "playing") keepPlayerControlsVisible();
    else if (!playerControlsTimer && !playerView.classList.contains("is-controls-idle")) armPlayerControlsTimer();
  }
  const structureKey = playerStructureKey(playback);
  if (forceStructure || structureKey !== playerStructuralRenderKey) {
    playerStructuralRenderKey = structureKey;
    renderPlayerStructure(playback);
  }
}

type SessionRow = { label: string; value: string; tone?: string };

function appendSessionSection(title: string, rows: SessionRow[]): void {
  if (rows.length === 0) return;
  const section = document.createElement("section");
  const heading = document.createElement("h3");
  heading.textContent = title;
  section.className = "session-section";
  section.append(heading);
  for (const row of rows) {
    const element = document.createElement("div");
    const label = document.createElement("span");
    const value = document.createElement("span");
    element.className = "session-row";
    if (row.tone) element.dataset.tone = row.tone;
    label.textContent = row.label;
    value.textContent = row.value;
    element.append(label, value);
    section.append(element);
  }
  sessionPanelContent.append(section);
}

function renderSoloSessionPanel(): void {
  sessionPanelContent.replaceChildren();
  const snapshot = state.soloDiagnostics;
  const playback = playbackForPlayer();
  const diagnostics = playback?.diagnostics;
  const connection = connectionStatePresentation(snapshot?.connection.state || "unknown");

  appendSessionSection("Connection", [
    { label: "Status", value: connection.label, tone: connection.tone },
    ...(snapshot?.connection.serverName ? [{ label: "Server", value: snapshot.connection.serverName }] : []),
    ...(snapshot?.connection.requestLatencyMs !== null && snapshot?.connection.requestLatencyMs !== undefined
      ? [{ label: "Request", value: `${Math.round(snapshot.connection.requestLatencyMs)} ms`, tone: "blue" }]
      : []),
  ]);

  appendSessionSection("Playback", [
    ...(playbackSourceKind() ? [{ label: "Source", value: sourceKindLabel(playbackSourceKind()) }] : []),
    ...(playback ? [{ label: "State", value: playbackPhasePresentation(playback).label }] : []),
    ...(formatBufferAhead(diagnostics?.bufferAheadTicks) ? [{ label: "Buffer ahead", value: formatBufferAhead(diagnostics?.bufferAheadTicks) as string }] : []),
  ]);

  appendSessionSection("Media", [
    ...(diagnostics?.versionLabel ? [{ label: "Version", value: diagnostics.versionLabel }] : []),
    ...(diagnostics?.container ? [{ label: "Container", value: diagnostics.container.toUpperCase() }] : []),
    ...(diagnostics?.resolution ? [{ label: "Resolution", value: diagnostics.resolution }] : []),
    ...(diagnostics?.videoCodec ? [{ label: "Video", value: diagnostics.videoCodec.toUpperCase() }] : []),
    ...(diagnostics?.audioCodec ? [{ label: "Audio", value: diagnostics.audioCodec.toUpperCase() }] : []),
    ...(diagnostics?.audioChannels ? [{ label: "Channels", value: diagnostics.audioChannels }] : []),
    ...(formatBitrate(diagnostics?.bitrate) ? [{ label: "Bitrate", value: formatBitrate(diagnostics?.bitrate) as string }] : []),
    ...(diagnostics?.videoRange ? [{ label: "Range", value: diagnostics.videoRange }] : []),
  ]);

  const audio = playback?.audioTracks.find((track) => track.selected);
  const subtitles = playback?.subtitleTracks.find((track) => track.selected);
  appendSessionSection("Selected tracks", [
    ...(audio ? [{ label: "Audio", value: trackLabel(audio) }] : []),
    ...(subtitles ? [{ label: "Subtitles", value: trackLabel(subtitles) }] : []),
  ]);

  const advanced: SessionRow[] = [
    ...(snapshot?.connection.serverVersion ? [{ label: "Server version", value: snapshot.connection.serverVersion }] : []),
    ...(formatPlaybackRate(diagnostics?.playbackRate) ? [{ label: "Playback rate", value: formatPlaybackRate(diagnostics?.playbackRate) as string }] : []),
    ...(diagnostics?.transcodeReason ? [{ label: "Transcode reason", value: diagnostics.transcodeReason, tone: "amber" }] : []),
    ...(diagnostics?.videoOutput ? [{ label: "Video output", value: diagnostics.videoOutput === "d3d11" ? "D3D11" : "Software OpenGL" }] : []),
    ...(diagnostics?.videoOutputHealthy !== undefined && diagnostics.videoOutputHealthy !== null
      ? [{ label: "Video output health", value: diagnostics.videoOutputHealthy ? "Ready" : "Unavailable", tone: diagnostics.videoOutputHealthy ? "green" : "amber" }]
      : []),
    ...(diagnostics?.hardwareDecoding !== undefined && diagnostics.hardwareDecoding !== null
      ? [{ label: "Hardware decoding", value: diagnostics.hardwareDecoding ? "Active" : "Off" }]
      : []),
    ...(diagnostics?.renderFallbackUsed ? [{ label: "Render fallback", value: "Software rendering", tone: "amber" }] : []),
  ];
  if (advanced.length > 0) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const body = document.createElement("div");
    details.className = "session-details";
    summary.textContent = "Advanced diagnostics";
    summary.dataset.sessionAction = "advanced-diagnostics";
    details.append(summary);
    for (const row of advanced) {
      const element = document.createElement("div");
      const label = document.createElement("span");
      const value = document.createElement("span");
      element.className = "session-row";
      if (row.tone) element.dataset.tone = row.tone;
      label.textContent = row.label;
      value.textContent = row.value;
      element.append(label, value);
      body.append(element);
    }
    details.append(body);
    sessionPanelContent.append(details);
  }

  const next = snapshot?.nextUp || null;
  if (next) {
    const section = document.createElement("section");
    const heading = document.createElement("h3");
    const card = document.createElement("div");
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    const button = document.createElement("button");
    section.className = "session-section";
    heading.textContent = "Next Up";
    card.className = "session-next-card";
    title.textContent = next.name;
    meta.textContent = [episodeCode(next), next.seriesName, runtime(next)].filter(Boolean).join(" · ");
    button.type = "button";
    button.textContent = "Play next";
    button.dataset.sessionAction = "play-next";
    button.disabled = !canPlay(next);
    button.addEventListener("click", () => { void playItem(next); });
    card.append(title, meta, button);
    section.append(heading, card);
    sessionPanelContent.append(section);
  }

  if (!snapshot && !playback) {
    const empty = document.createElement("p");
    empty.className = "session-empty";
    empty.textContent = "Playback diagnostics will appear when the player is ready.";
    sessionPanelContent.append(empty);
  }
}

function renderWatchpartySessionPanel(): void {
  sessionPanelContent.replaceChildren();
  const value = state.watchParties;
  const group = value?.joinedGroup || null;
  if (!value || !group) {
    const empty = document.createElement("p");
    const open = document.createElement("button");
    empty.className = "session-empty";
    empty.textContent = value?.error?.message || "Join a Jellyfin watch party to share playback controls.";
    open.type = "button";
    open.textContent = "Open Watch Parties";
    open.dataset.sessionAction = "open-watch-parties";
    open.addEventListener("click", async () => {
      await closePlayer();
      await openWatchParties();
    });
    sessionPanelContent.append(empty, open);
    return;
  }

  appendSessionSection("Jellyfin SyncPlay", [
    { label: "Group", value: group.name },
    { label: "State", value: watchPartyStateLabel(group.playbackState), tone: group.playbackState === "Playing" ? "green" : "blue" },
    { label: "Participants", value: String(group.participantCount) },
    ...(value.sync.serverLatencyMs !== null ? [{ label: "Server latency", value: `${Math.round(value.sync.serverLatencyMs)} ms`, tone: "blue" as const }] : []),
    ...(value.sync.localDriftTicks !== null ? [{ label: "Local drift", value: `${Math.round(value.sync.localDriftTicks / 10_000)} ms` }] : []),
  ]);
  appendSessionSection("Participants", group.participants.map((name) => ({ label: name, value: "Jellyfin member" })));
  const timing = document.createElement("section");
  const timingTitle = document.createElement("h3");
  const timingState = document.createElement("p");
  const timingValue = document.createElement("strong");
  const timingHelp = document.createElement("p");
  const timingActions = document.createElement("div");
  const earlier = document.createElement("button");
  const later = document.createElement("button");
  const reset = document.createElement("button");
  const offset = value.preparation.localSyncOffsetMilliseconds;
  timing.className = "session-sync-adjustment";
  timingTitle.textContent = "This computer’s timing";
  timingState.textContent = watchPartyPreparationLabel(value.preparation.phase);
  timingState.setAttribute("role", "status");
  timingValue.textContent = watchPartyOffsetLabel(offset);
  timingHelp.textContent = "If this computer sounds late, choose Earlier.";
  earlier.textContent = "Earlier 100 ms";
  earlier.disabled = offset >= 2000;
  earlier.dataset.sessionAction = "sync-earlier";
  earlier.addEventListener("click", () => { void setWatchPartySyncOffset(Math.min(2000, offset + 100), earlier); });
  later.textContent = "Later 100 ms";
  later.disabled = offset <= -2000;
  later.dataset.sessionAction = "sync-later";
  later.addEventListener("click", () => { void setWatchPartySyncOffset(Math.max(-2000, offset - 100), later); });
  reset.textContent = "Reset";
  reset.disabled = offset === 0;
  reset.dataset.sessionAction = "sync-reset";
  reset.addEventListener("click", () => { void setWatchPartySyncOffset(0, reset); });
  timingActions.className = "session-sync-actions";
  timingActions.append(earlier, later, reset);
  timing.append(timingTitle, timingState, timingValue, timingHelp, timingActions);
  sessionPanelContent.append(timing);
  if (value.telemetry.availability === "available" && value.telemetry.participants.length > 0) {
    // Keep server-verified sessions separate from Jellyfin's display-name-only
    // group list; names are not stable identifiers and may be duplicated.
    appendSessionSection("Verified participant status", value.telemetry.participants.map((participant) => {
      const stateLabel = participant.freshness === "stale" ? `${participant.state} · stale` : participant.state;
      return {
        label: participant.displayName,
        value: stateLabel.replace(/^./, (character) => character.toLocaleUpperCase()),
        tone: participant.state === "buffering" || participant.state === "stalled" ? "amber" as const
          : participant.state === "disconnected" ? "rose" as const : "green" as const,
      };
    }));
  }

  const enhanced = document.createElement("p");
  enhanced.className = "session-empty";
  enhanced.textContent = value.telemetry.availability === "available"
    ? "Enhanced participant status is authenticated and group-verified."
    : value.telemetry.reason || "Enhanced participant diagnostics are unavailable. Standard Jellyfin SyncPlay remains active.";
  if (value.telemetry.incident) {
    const incident = document.createElement("div");
    incident.className = "session-buffering-incident";
    incident.setAttribute("role", "status");
    incident.textContent = value.telemetry.incident.status === "grace"
      ? `${value.telemetry.incident.participantName} is ${value.telemetry.incident.state}. Waiting briefly before pausing.`
      : value.telemetry.incident.status === "suppressed"
        ? `${value.telemetry.incident.participantName} is still ${value.telemetry.incident.state}. Automatic waiting is suppressed for this incident.`
        : `${value.telemetry.incident.participantName} is ${value.telemetry.incident.state}. The party is waiting.`;
    sessionPanelContent.append(incident);
  }
  const actions = document.createElement("div");
  const wait = document.createElement("button");
  const continueButton = document.createElement("button");
  const resync = document.createElement("button");
  const leave = document.createElement("button");
  actions.className = "session-party-actions";
  wait.type = "button";
  wait.textContent = "Wait";
  wait.title = "Pause the party through Jellyfin SyncPlay";
  wait.dataset.sessionAction = "wait-party";
  wait.addEventListener("click", () => { void waitForWatchParty(wait); });
  continueButton.type = "button";
  continueButton.textContent = "Continue";
  continueButton.title = "Resume the party and suppress waiting for this buffering incident";
  continueButton.dataset.sessionAction = "continue-party";
  continueButton.addEventListener("click", () => { void continueWatchParty(continueButton); });
  resync.type = "button";
  resync.textContent = "Resync";
  resync.title = "Correct the group to the authoritative Jellyfin timeline";
  resync.dataset.sessionAction = "resync";
  resync.addEventListener("click", () => { void resyncWatchParty(resync); });
  leave.type = "button";
  leave.textContent = "Leave Party";
  leave.dataset.sessionAction = "leave-party";
  leave.addEventListener("click", () => { void leaveWatchParty(leave); });
  actions.append(wait, continueButton, resync, leave);
  sessionPanelContent.append(enhanced, actions);

  const details = document.createElement("details");
  const summary = document.createElement("summary");
  const policyLabel = document.createElement("label");
  const policySelect = document.createElement("select");
  details.className = "session-details";
  summary.textContent = "Session details";
  summary.dataset.sessionAction = "advanced-diagnostics";
  policyLabel.textContent = "When someone buffers";
  policySelect.setAttribute("aria-label", "When someone buffers");
  policySelect.dataset.sessionAction = "buffering-policy";
  for (const [mode, label] of [["wait-for-all", "Wait for everyone"], ["continue", "Keep playing"]] as const) {
    const option = document.createElement("option");
    option.value = mode;
    option.textContent = label;
    option.selected = value.telemetry.policy.mode === mode;
    policySelect.append(option);
  }
  policySelect.addEventListener("change", () => { void updateBufferingPolicy(policySelect.value as "wait-for-all" | "continue", policySelect); });
  policyLabel.append(policySelect);
  details.append(summary, policyLabel);
  sessionPanelContent.append(details);
}

function renderSessionPanel(): void {
  const scrollTop = sessionPanelContent.scrollTop;
  const activeElement = document.activeElement instanceof HTMLElement && sessionPanelContent.contains(document.activeElement)
    ? document.activeElement
    : null;
  const activeAction = activeElement?.dataset.sessionAction || null;
  const advancedOpen = Boolean(sessionPanelContent.querySelector<HTMLDetailsElement>(".session-details")?.open);
  const soloSelected = state.sessionPanelView === "solo";
  sessionSoloTab.setAttribute("aria-selected", String(soloSelected));
  sessionSoloTab.tabIndex = soloSelected ? 0 : -1;
  sessionWatchpartyTab.setAttribute("aria-selected", String(!soloSelected));
  sessionWatchpartyTab.tabIndex = soloSelected ? -1 : 0;
  sessionPanelContent.setAttribute("aria-labelledby", soloSelected ? "sessionSoloTab" : "sessionWatchpartyTab");
  if (state.sessionPanelView === "watchparty") renderWatchpartySessionPanel();
  else renderSoloSessionPanel();
  const advanced = sessionPanelContent.querySelector<HTMLDetailsElement>(".session-details");
  if (advanced && advancedOpen) advanced.open = true;
  sessionPanelContent.scrollTop = scrollTop;
  if (activeAction) {
    const replacement = Array.from(sessionPanelContent.querySelectorAll<HTMLElement>("[data-session-action]"))
      .find((element) => element.dataset.sessionAction === activeAction);
    replacement?.focus();
  }
}

function setSessionPanelView(view: SessionPanelView): void {
  if (view === "chat") return;
  state.sessionPanelView = view;
  playerStructuralRenderKey = "";
  renderPlayerState(true);
}

function setSessionPanelCollapsed(collapsed: boolean): void {
  state.sessionPanelCollapsed = collapsed;
  playerView.classList.toggle("is-panel-collapsed", collapsed);
  toggleSessionPanelButton.setAttribute("aria-label", collapsed ? "Open Session Panel" : "Collapse Session Panel");
  toggleSessionPanelButton.setAttribute("aria-expanded", String(!collapsed));
  toggleSessionPanelButton.title = collapsed ? "Open Session Panel" : "Collapse Session Panel";
  openSessionPanelButton.setAttribute("aria-expanded", String(!collapsed));
  const drawerMode = window.matchMedia("(max-width: 1120px)").matches;
  sessionPanelScrim.classList.toggle("is-hidden", collapsed || !drawerMode);
  sessionPanel.setAttribute("aria-hidden", String(collapsed));
  requestAnimationFrame(() => requestAnimationFrame(schedulePlayerViewport));
}

function closePlayerSettings(restoreFocus = true): void {
  if (playerSettingsMenu.classList.contains("is-hidden")) return;
  playerSettingsMenu.classList.add("is-hidden");
  playerSettingsButton.setAttribute("aria-expanded", "false");
  if (restoreFocus) (playerSettingsLastFocus || playerSettingsButton).focus();
  playerSettingsLastFocus = null;
}

function openPlayerSettings(): void {
  closePlayerEpisodeBrowser(false);
  playerSettingsLastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : playerSettingsButton;
  playerSettingsMenu.classList.remove("is-hidden");
  playerSettingsButton.setAttribute("aria-expanded", "true");
  const firstControl = playerSettingsMenu.querySelector<HTMLElement>("select:not(:disabled), button:not(:disabled)");
  firstControl?.focus();
  markPlayerActivity();
}

function renderPlayerAdapterPreference(): void {
  const preference = playerAdapterPreference;
  if (!preference) {
    delete playerView.dataset.activeAdapter;
    syncPlayerControlsPlacement();
    playerAdapterSelect.disabled = true;
    profileAdapterSelect.disabled = true;
    playerAdapterStatus.textContent = "Player engine status is unavailable.";
    profileAdapterStatus.textContent = "Player engine status is unavailable.";
    playerAdapterStatus.dataset.tone = "amber";
    profileAdapterStatus.dataset.tone = "amber";
    playerAdapterSelectSetting.classList.add("is-hidden");
    profileAdapterSelectSetting.classList.add("is-hidden");
    playerAdapterFixed.classList.remove("is-hidden");
    profileAdapterFixed.classList.remove("is-hidden");
    playerFallbackNotice.classList.add("is-hidden");
    return;
  }
  const selectionAvailable = preference.adapterSelectionAvailable;
  playerAdapterSelectSetting.classList.toggle("is-hidden", !selectionAvailable);
  profileAdapterSelectSetting.classList.toggle("is-hidden", !selectionAvailable);
  playerAdapterFixed.classList.toggle("is-hidden", selectionAvailable);
  profileAdapterFixed.classList.toggle("is-hidden", selectionAvailable);
  playerView.dataset.activeAdapter = preference.active;
  syncPlayerControlsPlacement();
  playerAdapterSelect.disabled = !selectionAvailable;
  profileAdapterSelect.disabled = !selectionAvailable;
  playerAdapterSelect.value = preference.selected;
  profileAdapterSelect.value = preference.selected;
  const embeddedOption = playerAdapterSelect.querySelector<HTMLOptionElement>('option[value="embedded"]');
  if (embeddedOption) embeddedOption.disabled = !preference.embeddedAvailable;
  const profileEmbeddedOption = profileAdapterSelect.querySelector<HTMLOptionElement>('option[value="embedded"]');
  if (profileEmbeddedOption) profileEmbeddedOption.disabled = !preference.embeddedAvailable;
  const activeLabel = preference.active === "libmpv"
    ? "Libmpv player"
    : preference.active === "embedded" ? "Embedded player" : "Legacy external player";
  const fallbackReasons: Record<NonNullable<PlaybackAdapterPreference["fallbackReason"]>, string> = {
    "manifest-invalid": "its runtime manifest is invalid",
    "library-not-configured": "a verified libmpv runtime has not been built",
    "library-missing": "the verified libmpv library is missing",
    "library-hash-mismatch": "a native artifact failed integrity verification",
    "companion-missing": "a required runtime library is missing",
    "companion-hash-mismatch": "a required runtime library failed integrity verification",
    "client-abi-incompatible": "the libmpv client ABI is incompatible",
    "required-symbol-missing": "the libmpv runtime lacks a required API symbol",
    "native-addon-unavailable": "the native rendering bridge is unavailable",
    "graphics-capability-unavailable": "the required GPU composition path is unavailable",
    "render-gate-not-passed": "the libmpv video-rendering gate has not passed",
    "controller-integration-unavailable": "the libmpv controller integration has not passed",
    "initialization-failed": "libmpv initialization failed",
    "embedded-initialization-failed": "the embedded fallback could not initialize",
  };
  if (preference.restartRequired) {
    playerAdapterStatus.textContent = `${activeLabel} is active. Restart Seeing Stone to apply this change.`;
    profileAdapterStatus.textContent = `${activeLabel} is active. Restart Seeing Stone to apply this change.`;
    playerAdapterStatus.dataset.tone = "amber";
    profileAdapterStatus.dataset.tone = "amber";
  } else if (!preference.libmpvAvailable && preference.active === "libmpv" && preference.fallbackReason) {
    const message = `Playback is unavailable because ${fallbackReasons[preference.fallbackReason]}. No legacy player was started.`;
    playerAdapterStatus.textContent = message;
    profileAdapterStatus.textContent = message;
    playerAdapterStatus.dataset.tone = "amber";
    profileAdapterStatus.dataset.tone = "amber";
    playerFallbackNoticeMessage.textContent = message;
    playerFallbackNotice.classList.remove("is-hidden");
  } else if (preference.fallbackActive && preference.fallbackReason) {
    const message = `Libmpv remains selected, but ${activeLabel} is active because ${fallbackReasons[preference.fallbackReason]}.`;
    playerAdapterStatus.textContent = message;
    profileAdapterStatus.textContent = message;
    playerAdapterStatus.dataset.tone = "amber";
    profileAdapterStatus.dataset.tone = "amber";
    playerFallbackNoticeMessage.textContent = `${activeLabel} is being used because ${fallbackReasons[preference.fallbackReason]}.`;
    playerFallbackNotice.classList.remove("is-hidden");
  } else {
    playerAdapterStatus.textContent = `${activeLabel} is active.`;
    profileAdapterStatus.textContent = `${activeLabel} is active.`;
    playerAdapterStatus.dataset.tone = "green";
    profileAdapterStatus.dataset.tone = "green";
    playerFallbackNotice.classList.add("is-hidden");
  }
}

async function refreshPlayerAdapterPreference(): Promise<void> {
  try {
    playerAdapterPreference = await window.jellyfin.playback.getAdapterPreference();
  } catch {
    playerAdapterPreference = null;
  }
  renderPlayerAdapterPreference();
}

function togglePlayerSettings(): void {
  if (playerSettingsMenu.classList.contains("is-hidden")) openPlayerSettings();
  else closePlayerSettings();
}

function setPlayerControlsIdle(idle: boolean): void {
  const changed = playerView.classList.contains("is-controls-idle") !== idle;
  playerView.classList.toggle("is-controls-idle", idle);
  if (changed) schedulePlayerViewportSettled();
}

function keepPlayerControlsVisible(): void {
  if (playerControlsTimer) clearTimeout(playerControlsTimer);
  playerControlsTimer = null;
  setPlayerControlsIdle(false);
}

function armPlayerControlsTimer(): void {
  if (playerControlsTimer) clearTimeout(playerControlsTimer);
  playerControlsTimer = setTimeout(() => {
    playerControlsTimer = null;
    const playback = playbackForPlayer();
    if (playback?.fullscreen && playback.phase === "playing" && playback.paused === false
      && !playerControls.contains(document.activeElement)
      && document.activeElement !== playerSegmentSkipButton
      && playerEpisodeBrowser.classList.contains("is-hidden")) {
      setPlayerControlsIdle(true);
    }
  }, 2600);
}

function markPlayerActivity(): void {
  setPlayerControlsIdle(false);
  const playback = playbackForPlayer();
  if (!playback?.fullscreen || playback.phase !== "playing" || playback.paused !== false) {
    keepPlayerControlsVisible();
    return;
  }
  armPlayerControlsTimer();
}

function applySoloDiagnostics(snapshot: SoloSessionDiagnostics, expectedPlaybackId = state.playbackId): void {
  if (!expectedPlaybackId || snapshot.playback.playbackId !== expectedPlaybackId || expectedPlaybackId !== state.playbackId) return;
  state.soloDiagnostics = snapshot;
  state.playbackState = snapshot.playback;
  state.playbackSource = snapshot.playback.source;
  state.playbackSourceKind = snapshot.playback.diagnostics?.sourceKind || state.playbackSourceKind;
  if (snapshot.item) {
    state.playbackItem = snapshot.item;
    playerTitle.textContent = snapshot.item.type === "Episode" && snapshot.item.seriesName
      ? snapshot.item.seriesName
      : snapshot.item.name || "Now Playing";
    playerMeta.textContent = snapshot.item.type === "Episode"
      ? [episodeCode(snapshot.item), snapshot.item.name].filter(Boolean).join(" - ")
      : metadataParts(snapshot.item).join(" - ");
  }
  renderPlayerState();
}

async function refreshSoloDiagnostics(force = false): Promise<void> {
  const expectedPlaybackId = state.playbackId;
  if (!expectedPlaybackId) return;
  const now = Date.now();
  if (!force && now - soloDiagnosticsRefreshedAt < 30_000) return;
  soloDiagnosticsRefreshedAt = now;
  const requestId = ++state.soloDiagnosticsRequestId;
  try {
    const snapshot = await window.jellyfin.sessionPanel.getSolo();
    if (requestId !== state.soloDiagnosticsRequestId || expectedPlaybackId !== state.playbackId) return;
    applySoloDiagnostics(snapshot, expectedPlaybackId);
  } catch {
    if (requestId === state.soloDiagnosticsRequestId) renderPlayerState();
  }
}

async function applyPlaybackCommand(command: () => Promise<PlaybackState>, fallback: string): Promise<void> {
  try {
    const playback = await command();
    if (state.playbackId && playback.playbackId === state.playbackId) {
      state.playbackState = playback;
      state.playbackSource = playback.source;
      state.playbackSourceKind = playback.diagnostics?.sourceKind || state.playbackSourceKind;
      renderPlayerState();
    }
  } catch (error) {
    showToast(errorMessage(error, fallback));
  }
}

async function togglePlayerPaused(): Promise<void> {
  const playback = playbackForPlayer();
  if (!state.playbackId) {
    if (state.playbackItem && playback && ["stopped", "disconnected", "error", "ended"].includes(playback.phase)) {
      await playItem(state.playbackItem);
    }
    return;
  }
  if (!playback) return;
  await applyPlaybackCommand(
    () => window.jellyfin.playback.setPaused({ playbackId: state.playbackId as string, paused: !playback.paused }),
    "Playback could not be changed.",
  );
}

async function seekPlayerBy(seconds: number): Promise<void> {
  const playback = playbackForPlayer();
  if (!state.playbackId || !playback?.seekable) return;
  const maximum = playback.seekableUntilTicks ?? (playback.durationTicks || Number.MAX_SAFE_INTEGER);
  const positionTicks = Math.max(0, Math.min(maximum, playback.positionTicks + seconds * TICKS_PER_SECOND));
  await applyPlaybackCommand(
    () => window.jellyfin.playback.seek({ playbackId: state.playbackId as string, positionTicks }),
    "Playback could not be seeked.",
  );
}

async function startPresentedPlayback(presentation: PlaybackPresentation): Promise<void> {
  const requestId = ++state.playbackRequestId;
  if (playerView.classList.contains("is-hidden")) {
    state.lastFocusElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  state.playbackItem = presentation.item;
  state.playbackId = null;
  state.playbackSource = null;
  state.playbackSourceKind = null;
  state.playbackState = null;
  clearPlaybackFeatures();
  state.soloDiagnostics = null;
  state.soloDiagnosticsRequestId += 1;
  playerStructuralRenderKey = "";
  closePlayerSettings(false);
  closePlayerEpisodeBrowser(false);
  soloDiagnosticsRefreshedAt = 0;
  playerTitle.textContent = presentation.title;
  playerMeta.textContent = presentation.meta;
  playerMetadataTitle.textContent = presentation.item?.name || presentation.title;
  playerEyebrow.textContent = presentation.item?.type === "Episode"
    ? [presentation.item.seriesName, episodeCode(presentation.item)].filter(Boolean).join(" · ")
    : presentation.item?.type || "";
  playerOverview.textContent = presentation.item?.overview || "";
  playerView.classList.remove("is-hidden");
  document.body.classList.add("is-playing");
  setSessionPanelCollapsed(window.matchMedia("(max-width: 1120px)").matches);
  renderPlayerState();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await syncPlayerViewport(true);

  let resolved;
  try {
    resolved = presentation.liveChannelId
      ? await window.jellyfin.playback.startLive({ channelId: presentation.liveChannelId })
      : await window.jellyfin.playback.start({
        itemId: presentation.itemId,
        resumeMode: presentation.resumeMode,
        ...(presentation.preferredMediaSourceId ? { preferredMediaSourceId: presentation.preferredMediaSourceId } : {}),
        ...(presentation.progressiveOnly ? { progressiveOnly: true } : {}),
      });
    await refreshPlayerAdapterPreference();
  } catch (error) {
    await refreshPlayerAdapterPreference();
    if (requestId !== state.playbackRequestId) return;
    await closePlayer();
    showToast(errorMessage(error, presentation.failureMessage));
    return;
  }
  if (requestId !== state.playbackRequestId) {
    await window.jellyfin.playback.stop({ playbackId: resolved.playbackId }).catch(() => undefined);
    return;
  }
  state.playbackId = resolved.playbackId;
  state.playbackSource = resolved.source;
  state.playbackSourceKind = resolved.sourceKind;
  if (resolved.mediaVersion?.label || presentation.versionLabel) {
    playerMeta.textContent = [presentation.meta, resolved.mediaVersion?.label ?? presentation.versionLabel].filter(Boolean).join(" • ");
  }
    state.playbackState = await window.jellyfin.playback.getState().catch(() => null);
  if (resolved.notice) showToast(resolved.notice);
  renderPlayerState();
  void refreshSoloDiagnostics(true);
  playerPlayPauseButton.focus();
  markPlayerActivity();
  if (state.currentRoute === "watch-parties") renderWatchParties();
}

async function presentExternallyStartedPlayback(playback: PlaybackState): Promise<void> {
  if (!playback.playbackId || playback.playbackId === dismissedPlaybackId
    || !playerView.classList.contains("is-hidden")) return;
  const expectedPlaybackId = playback.playbackId;
  const requestId = ++state.playbackRequestId;
  state.lastFocusElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.playbackItem = null;
  state.playbackId = expectedPlaybackId;
  state.playbackSource = playback.source;
  state.playbackSourceKind = playback.diagnostics?.sourceKind ?? null;
  state.playbackState = playback;
  clearPlaybackFeatures();
  state.soloDiagnostics = null;
  state.soloDiagnosticsRequestId += 1;
  playerStructuralRenderKey = "";
  closePlayerSettings(false);
  closePlayerEpisodeBrowser(false);
  soloDiagnosticsRefreshedAt = 0;
  playerTitle.textContent = "Now Playing";
  playerMeta.textContent = "Started from Companion Remote";
  playerMetadataTitle.textContent = "Now Playing";
  playerEyebrow.textContent = "";
  playerOverview.textContent = "";
  playerView.classList.remove("is-hidden");
  document.body.classList.add("is-playing");
  setSessionPanelCollapsed(window.matchMedia("(max-width: 1120px)").matches);
  renderPlayerState();
  void loadPlaybackFeatures(playback);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  if (requestId !== state.playbackRequestId || state.playbackId !== expectedPlaybackId) return;
  await Promise.all([
    syncPlayerViewport(true),
    refreshPlayerAdapterPreference(),
  ]);
  if (playback.itemId) {
    try {
      const item = await window.jellyfin.items.getDetails({ itemId: playback.itemId });
      if (requestId !== state.playbackRequestId || state.playbackId !== expectedPlaybackId) return;
      state.playbackItem = item;
      playerTitle.textContent = item.type === "Episode" && item.seriesName
        ? item.seriesName
        : item.name || "Now Playing";
      playerMeta.textContent = item.type === "Episode"
        ? [episodeCode(item), item.name].filter(Boolean).join(" - ")
        : metadataParts(item).join(" - ");
      playerMetadataTitle.textContent = item.name || "Now Playing";
      playerEyebrow.textContent = item.type === "Episode"
        ? [item.seriesName, episodeCode(item)].filter(Boolean).join(" · ")
        : item.type || "";
      playerOverview.textContent = item.overview || "";
      renderPlayerState(true);
    } catch {
      // Playback remains usable when metadata refresh is temporarily unavailable.
    }
  }
  if (requestId !== state.playbackRequestId || state.playbackId !== expectedPlaybackId) return;
  void refreshSoloDiagnostics(true);
  playerPlayPauseButton.focus();
  markPlayerActivity();
}

async function playDownloadedItem(download: DownloadSummary): Promise<void> {
  let selected = download;
  if (selected.state !== "downloaded") {
    try {
      const downloads = await window.jellyfin.downloads.list();
      state.downloads = downloads;
      renderDownloads();
      syncVisibleDownloadButtons();
      selected = downloads.find((entry) => entry.downloadId === download.downloadId) ?? selected;
    } catch (error) {
      showToast(errorMessage(error, "Download readiness could not be checked."));
      return;
    }
    if (selected.state !== "downloaded" && !selected.canWatchWhileDownloading) {
      showToast(selected.state === "paused"
        ? "Still buffering. Resume the download, then try Watch now again shortly."
        : selected.state === "failed"
          ? "Retry the download before watching the partial copy."
          : "Still buffering. Try Watch now again shortly.");
      return;
    }
  }
  const progressiveOnly = selected.state !== "downloaded";
  await startPresentedPlayback({
    item: selected.item,
    itemId: selected.itemId,
    resumeMode: "resume",
    title: selected.name,
    meta: `${selected.itemType} - ${selected.state === "downloaded" ? "Downloaded" : "Downloading"}`,
    failureMessage: selected.state === "downloaded"
      ? "The downloaded media could not be played."
      : "The partial download could not be played.",
    progressiveOnly,
  });
}

async function playOfflineItem(entry: OfflinePlayableSummary): Promise<void> {
  await startPresentedPlayback({
    item: entry.item,
    itemId: entry.item.id,
    resumeMode: "resume",
    title: entry.item.type === "Episode" && entry.item.seriesName ? entry.item.seriesName : entry.item.name,
    meta: entry.item.type === "Episode"
      ? [episodeCode(entry.item), entry.item.name, "Offline Local"].filter(Boolean).join(" - ")
      : `${entry.item.type} - Offline Local`,
    failureMessage: "The verified local media could not be played.",
  });
}

async function playItem(item: MediaItem, version: MediaVersion | null = null): Promise<void> {
  if (!canPlay(item)) return;
  const targetItemId = version?.itemId ?? item.id;
  await startPresentedPlayback({
    item,
    itemId: targetItemId,
    // An alternate item ID owns its own Jellyfin progress. Let the main-side
    // details lookup resolve that selected item's resume position.
    resumeMode: version ? "resume" : item.userData.playbackPositionTicks > 0 ? "resume" : "start-over",
    title: item.type === "Episode" && item.seriesName ? item.seriesName : item.name || "Now Playing",
    meta: item.type === "Episode"
      ? [episodeCode(item), item.name].filter(Boolean).join(" - ")
      : metadataParts(item).join(" - "),
    failureMessage: "Playback could not be started.",
    ...(version ? { preferredMediaSourceId: version.mediaSourceId, versionLabel: version.label } : {}),
  });
}

async function closePlayer(): Promise<void> {
  state.playbackRequestId += 1;
  state.soloDiagnosticsRequestId += 1;
  const playbackId = state.playbackId;
  dismissedPlaybackId = playbackId;
  // Start native shutdown before any renderer layout or viewport cleanup.
  // This keeps audio termination independent from a stalled GPU presenter.
  const stopPromise = playbackId
    ? window.jellyfin.playback.stop({ playbackId }).catch(() => undefined)
    : Promise.resolve();
  playerView.classList.add("is-hidden");
  document.body.classList.remove("is-playing");
  state.playbackItem = null;
  state.playbackId = null;
  state.playbackSource = null;
  state.playbackSourceKind = null;
  state.playbackState = null;
  clearPlaybackFeatures();
  state.soloDiagnostics = null;
  playerStructuralRenderKey = "";
  closePlayerSettings(false);
  closePlayerEpisodeBrowser(false);
  closePlayerMiniGuide(false);
  playerView.classList.remove("is-controls-idle");
  if (playerControlsTimer) clearTimeout(playerControlsTimer);
  playerControlsTimer = null;
  if (playerViewportClickTimer) clearTimeout(playerViewportClickTimer);
  playerViewportClickTimer = null;
  state.lastFocusElement?.focus?.();
  const viewportPromise = syncPlayerViewport(false);
  await stopPromise;
  await viewportPromise;
  void refreshVisibleCatalog();
}

window.jellyfin.playback.subscribe((playback) => {
  const previousPlaybackId = state.playbackState?.playbackId;
  const previousItemId = state.playbackState?.itemId;
  const playerVisible = !playerView.classList.contains("is-hidden");
  if (dismissedPlaybackId && playback.playbackId !== dismissedPlaybackId) dismissedPlaybackId = null;
  const externallyStarted = !playerVisible && Boolean(playback.playbackId)
    && playback.playbackId !== dismissedPlaybackId;
  const lostActivePlayback = playerVisible && Boolean(state.playbackId) && playback.playbackId === null;
  const itemChanged = Boolean(playback.playbackId && (playback.playbackId !== previousPlaybackId || playback.itemId !== previousItemId));
  if (playerVisible && playback.playbackId && playback.playbackId !== state.playbackId) {
    state.playbackId = playback.playbackId;
  }
  if (playerVisible && itemChanged) {
    clearPlaybackFeatures();
    closePlayerEpisodeBrowser(false);
    state.playbackItem = null;
    state.soloDiagnostics = null;
    state.soloDiagnosticsRequestId += 1;
    soloDiagnosticsRefreshedAt = 0;
  }
  if (lostActivePlayback) state.playbackId = null;
  state.playbackState = playback;
  state.playbackSource = playback.source;
  state.playbackSourceKind = playback.diagnostics?.sourceKind || state.playbackSourceKind;
  renderPlayerState();
  if (itemChanged && !externallyStarted) void loadPlaybackFeatures(playback);
  if (externallyStarted) void presentExternallyStartedPlayback(playback);
  if (playback.playbackId && playback.playbackId === state.playbackId && (itemChanged || Date.now() - soloDiagnosticsRefreshedAt >= 30_000)) {
    void refreshSoloDiagnostics(itemChanged);
  }
  if (state.currentRoute === "watch-parties") renderWatchParties();
  if (!lostActivePlayback) return;
  void syncPlayerViewport(false);
  if (playback.phase === "disconnected") showToast("Playback disconnected. The external player remains available in developer settings.");
  else if (playback.phase === "error") showToast("Playback stopped because the player reported an error.");
});

window.jellyfin.sessionPanel.subscribeSolo((snapshot) => {
  applySoloDiagnostics(snapshot);
});

new ResizeObserver(schedulePlayerViewport).observe(playerViewport);
playerCenter.addEventListener("scroll", schedulePlayerViewport, { passive: true });
window.addEventListener("resize", () => {
  schedulePlayerViewport();
  const nextDrawerMode = window.matchMedia("(max-width: 1120px)").matches;
  if (nextDrawerMode !== playerDrawerMode) setSessionPanelCollapsed(nextDrawerMode);
  playerDrawerMode = nextDrawerMode;
});

function licenseStatusLabel(status: string): string {
  if (status === "source-and-binary") return "Source and binary";
  if (status === "source-only") return "Source only";
  return "Internal only — provenance incomplete";
}

function renderLicenses(): void {
  licensesList.replaceChildren();
  const inventory = state.licenseInventory;
  const query = licensesSearchInput.value.trim().toLocaleLowerCase();
  if (!inventory) {
    licensesSummary.textContent = "Loading license inventory…";
    return;
  }
  const entries = inventory.entries.filter((entry) => {
    const searchable = [entry.name, entry.version, entry.license, entry.category].join(" ").toLocaleLowerCase();
    return !query || searchable.includes(query);
  });
  licensesSummary.textContent = `${entries.length} of ${inventory.entries.length} components · ${inventory.projectLicense}`;
  for (const entry of entries) {
    const card = document.createElement("article");
    const identity = document.createElement("div");
    const name = document.createElement("strong");
    const version = document.createElement("small");
    const license = document.createElement("span");
    const status = document.createElement("span");
    card.className = "license-entry";
    name.textContent = entry.name;
    version.textContent = [entry.version, entry.category].filter(Boolean).join(" · ");
    if (entry.projectUrl) {
      try {
        version.textContent += ` · ${new URL(entry.projectUrl).hostname}`;
      } catch { /* The generated inventory validates URLs before this view is built. */ }
    }
    license.textContent = entry.license;
    status.className = "license-status";
    status.dataset.status = entry.redistributionStatus;
    status.textContent = licenseStatusLabel(entry.redistributionStatus);
    identity.append(name, version);
    card.append(identity, license, status);
    licensesList.append(card);
  }
  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "session-empty";
    empty.textContent = "No components match this filter.";
    licensesList.append(empty);
  }
}

async function openLicenses(): Promise<void> {
  licensesLastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  profileMenu.classList.add("is-hidden");
  profileButton.setAttribute("aria-expanded", "false");
  licensesScrim.classList.remove("is-hidden");
  licensesPanel.classList.remove("is-hidden");
  licensesSearchInput.value = "";
  renderLicenses();
  closeLicensesButton.focus();
  if (state.licenseInventory) return;
  try {
    state.licenseInventory = await window.jellyfin.licenses.list();
    renderLicenses();
  } catch (error) {
    licensesSummary.textContent = errorMessage(error, "The license inventory could not be loaded.");
  }
}

function closeLicenses(): void {
  if (licensesPanel.classList.contains("is-hidden")) return;
  licensesScrim.classList.add("is-hidden");
  licensesPanel.classList.add("is-hidden");
  licensesLastFocus?.focus?.();
  licensesLastFocus = null;
}

function renderCleanMachineDiagnostics(error?: string): void {
  cleanMachineDiagnosticsChecks.replaceChildren();
  cleanMachineDiagnosticsMetadata.replaceChildren();
  const snapshot = state.cleanMachineDiagnostics;
  if (!snapshot) {
    delete cleanMachineDiagnosticsSummary.dataset.status;
    cleanMachineDiagnosticsSummary.textContent = error ?? "Running clean-machine checks…";
    return;
  }

  cleanMachineDiagnosticsSummary.dataset.status = snapshot.overall;
  cleanMachineDiagnosticsSummary.textContent = snapshot.overall === "ready"
    ? "Ready: all required libmpv checks passed on this machine."
    : snapshot.overall === "warning"
      ? "Usable with warnings: review the checks below."
      : "Blocked: one or more required libmpv checks failed.";

  for (const value of [
    `Seeing Stone ${snapshot.applicationVersion}`,
    snapshot.build.replaceAll("-", " "),
    `${snapshot.platform} ${snapshot.architecture}`,
    `Electron ${snapshot.electronVersion}`,
    `Selected: ${snapshot.selectedEngine}`,
    `Active: ${snapshot.activeEngine}`,
  ]) {
    const item = document.createElement("span");
    item.textContent = value;
    cleanMachineDiagnosticsMetadata.append(item);
  }

  for (const diagnostic of snapshot.checks) {
    const item = document.createElement("article");
    item.className = "clean-machine-diagnostic-check";
    item.dataset.status = diagnostic.status;
    const header = document.createElement("header");
    const label = document.createElement("strong");
    label.textContent = diagnostic.label;
    const status = document.createElement("code");
    status.textContent = diagnostic.status.replace("-", " ");
    const detail = document.createElement("span");
    detail.textContent = diagnostic.detail;
    header.append(label, status);
    item.append(header, detail);
    cleanMachineDiagnosticsChecks.append(item);
  }
}

async function runCleanMachineDiagnostics(): Promise<void> {
  state.cleanMachineDiagnostics = null;
  renderCleanMachineDiagnostics();
  for (const button of [
    rerunCleanMachineDiagnosticsButton,
    copyCleanMachineDiagnosticsButton,
    saveCleanMachineDiagnosticsButton,
  ]) button.disabled = true;
  try {
    state.cleanMachineDiagnostics = await window.jellyfin.diagnostics.getCleanMachine();
    renderCleanMachineDiagnostics();
  } catch (error) {
    renderCleanMachineDiagnostics(errorMessage(error, "Clean-machine diagnostics could not be run."));
  } finally {
    for (const button of [
      rerunCleanMachineDiagnosticsButton,
      copyCleanMachineDiagnosticsButton,
      saveCleanMachineDiagnosticsButton,
    ]) button.disabled = false;
  }
}

function openCleanMachineDiagnostics(): void {
  cleanMachineDiagnosticsLastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  profileMenu.classList.add("is-hidden");
  profileButton.setAttribute("aria-expanded", "false");
  cleanMachineDiagnosticsScrim.classList.remove("is-hidden");
  cleanMachineDiagnosticsPanel.classList.remove("is-hidden");
  closeCleanMachineDiagnosticsButton.focus();
  void runCleanMachineDiagnostics();
}

function closeCleanMachineDiagnostics(): void {
  if (cleanMachineDiagnosticsPanel.classList.contains("is-hidden")) return;
  cleanMachineDiagnosticsScrim.classList.add("is-hidden");
  cleanMachineDiagnosticsPanel.classList.add("is-hidden");
  cleanMachineDiagnosticsLastFocus?.focus?.();
  cleanMachineDiagnosticsLastFocus = null;
}

function resetSignedInState(): void {
  if (smartDownloadDialog.open) smartDownloadDialog.close("cancel");
  if (smartUnfollowDialog.open) smartUnfollowDialog.close("cancel");
  liveTvArtworkUrls.clear();
  miniGuideSelection = { channelId: "", programIndex: 0 };
  if (state.searchTimer) clearTimeout(state.searchTimer);
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.searchTimer = null;
  state.toastTimer = null;
  visibleCatalogRefreshQueued = false;
  state.detailsRequestId += 1;
  state.searchRequestId += 1;
  state.playbackRequestId += 1;
  state.libraries = [];
  state.homeRows = [];
  state.homeRequestId += 1;
  state.resumeItems = [];
  state.nextUpItems = [];
  state.featureItem = null;
  state.liveTvGuide = null;
  state.liveTvRecordings = [];
  state.liveTvTimers = [];
  state.liveTvSeriesTimers = [];
  state.liveTvRequestId += 1;
  state.liveTvProgramSearch = null;
  state.liveTvProgramSearchRequestId += 1;
  liveTvRecordedProgramIds.clear();
  state.currentRoute = "home";
  state.returnRoute = "home";
  state.returnScrollTop = 0;
  state.searchReturnRoute = "home";
  state.searchReturnScrollTop = 0;
  state.selectedLibraryId = null;
  state.libraryFilter = "all";
  state.librarySort = "title-ascending";
  state.libraryCache.clear();
  state.libraryRequestIds.clear();
  state.downloadedSelectionMode = false;
  state.selectedDownloadIds.clear();
  state.detailItem = null;
  state.detailPlayItem = null;
  detailSeriesButton.classList.add("is-hidden");
  detailSeriesButton.disabled = true;
  detailSeriesButton.onclick = null;
  detailSmartDownloadsButton.classList.add("is-hidden");
  detailSmartDownloadsButton.disabled = true;
  detailSmartDownloadsButton.onclick = null;
  state.seasons = [];
  state.episodes = [];
  state.selectedEpisodeIds.clear();
  state.playbackItem = null;
  state.playbackId = null;
  state.playbackSource = null;
  state.playbackSourceKind = null;
  state.playbackState = null;
  state.soloDiagnostics = null;
  state.soloDiagnosticsRequestId += 1;
  state.playerEpisodeBrowserSeriesId = null;
  state.playerEpisodeBrowserSeasonId = null;
  state.playerEpisodeBrowserSeasons = [];
  state.playerEpisodeBrowserEpisodes = [];
  state.playerEpisodeBrowserRequestId += 1;
  closePlayerEpisodeBrowser(false);
  state.sessionPanelView = "solo";
  state.sessionPanelCollapsed = false;
  state.lastFocusElement = null;
  state.watchParties = null;
  state.downloads = [];
  state.offlinePlayable = [];
  state.smartDownloads = { series: [], notice: null };

  clearImage(featureImage);
  clearImage(detailBackdrop);
  clearImage(detailPoster, detailPosterFallback);
  renderFeature(null);
  homeRows.replaceChildren();
  mainLibraryNavigation.replaceChildren();
  playerLibraryNavigation.replaceChildren();
  libraryGrid.replaceChildren();
  searchRows.replaceChildren();
  episodeList.replaceChildren();
  smartDownloadsList.replaceChildren();
  seasonSelect.replaceChildren();
  seasonSelect.disabled = true;
  selectSeasonEpisodes.checked = false;
  selectSeasonEpisodes.indeterminate = false;
  selectSeasonEpisodes.disabled = true;
  downloadSelectedEpisodes.disabled = true;
  downloadSelectedEpisodes.textContent = "Download selected";
  episodeSection.classList.add("is-hidden");

  libraryTitle.textContent = "Library";
  libraryFilter.value = "all";
  librarySort.value = "title-ascending";
  searchTitle.textContent = "Search";
  detailEyebrow.textContent = "";
  detailTitle.textContent = "";
  detailMeta.replaceChildren();
  detailOverview.textContent = "";
  detailGenres.replaceChildren();
  detailPeople.replaceChildren();
  detailCast.classList.add("is-hidden");
  detailHero.classList.add("has-no-poster");
  detailPosterFrame.classList.add("is-hidden");
  detailPosterFallback.textContent = "";
  detailPlayButton.disabled = true;
  detailPlayButton.onclick = null;
  detailPlayLabel.textContent = "Play";
  detailDownloadButton.disabled = true;
  detailDownloadButton.dataset.downloadItem = "";
  detailDownloadButton.onclick = null;
  detailDownloadLabel.textContent = "Download";
  detailTrailerButton.disabled = true;
  detailTrailerButton.onclick = null;
  detailWatchedButton.classList.add("is-hidden");
  detailWatchedButton.disabled = true;
  detailWatchedButton.onclick = null;
  detailWatchedLabel.textContent = "Mark Watched";

  playerView.classList.add("is-hidden");
  document.body.classList.remove("is-playing");
  playerTitle.textContent = "";
  playerMeta.textContent = "";
  playerSourceBadge.textContent = "";
  playerConnectionBadge.textContent = "Connection unknown";
  playerSyncBadge.textContent = "Solo";
  playerMetadataTitle.textContent = "Now Playing";
  playerEyebrow.textContent = "";
  playerOverview.textContent = "";
  playerMediaPills.replaceChildren();
  playerNextCard.classList.add("is-hidden");
  playerTimeline.value = "0";
  playerTimeline.disabled = true;
  playerTimeline.removeAttribute("aria-valuetext");
  playerCurrentTime.textContent = "0:00";
  playerDuration.textContent = "0:00";
  sessionPanelContent.replaceChildren();
  setSessionPanelCollapsed(false);

  searchInput.value = "";
  userLabel.textContent = "";
  serverLabel.textContent = "";
  profileInitial.textContent = "J";
  profileMenu.classList.add("is-hidden");
  profileButton.setAttribute("aria-expanded", "false");
  toast.textContent = "";
  toast.classList.add("is-hidden");
  downloadsList.replaceChildren();
  watchPartyList.replaceChildren();
  joinedWatchParty.replaceChildren();
  joinedWatchParty.classList.add("is-hidden");
  watchPartyStatus.textContent = "";
  watchPartyNameInput.value = "";
  closeDownloads();
  closeTrailer();
  closeLicenses();
  closeCleanMachineDiagnostics();
  setRoute("home");
  contentScroller.scrollTop = 0;
}

async function bootstrap(): Promise<void> {
  void refreshPlayerAdapterPreference();
  try {
    state.session = await window.jellyfin.session.restore();
    if (state.session.server) serverUrlInput.value = state.session.server.address;
    if (state.session.authenticated) {
      await loadInitialData();
      return;
    }
  } catch {
    state.session = null;
  }
  showLogin();
  try {
    await discoverServers();
  } catch { /* The login view retains manual server entry. */ }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setLoginMessage("Signing in...");
  const serverUrl = normalizeServerUrl(serverUrlInput.value);
  try {
    const connection = await window.jellyfin.server.connect({ url: serverUrl });
    state.session = await window.jellyfin.session.login({
      connectionId: connection.connectionId,
      username: usernameInput.value.trim(),
      password: passwordInput.value,
      remember: true,
    });
    passwordInput.value = "";
    setLoginMessage("");
    resetSignedInState();
    await loadInitialData();
  } catch (error) {
    setLoginMessage(errorMessage(error, "Could not sign in. Check the server URL and credentials."), true);
  }
});

discoverButton.addEventListener("click", discoverServers);
serverUrlInput.addEventListener("input", renderDiscoveredServers);

brandHomeButton.addEventListener("click", openHome);
navHomeButton.addEventListener("click", openHome);
navLiveTvButton.addEventListener("click", () => { void openLiveTv(); });
navWatchPartiesButton.addEventListener("click", () => { void openWatchParties(); });
navCompanionButton.addEventListener("click", () => { void openCompanion(); });
closeApplicationButton.addEventListener("click", () => {
  closeApplicationButton.disabled = true;
  void window.jellyfin.application.close().catch((error) => {
    closeApplicationButton.disabled = false;
    showToast(errorMessage(error, "Seeing Stone could not be closed."));
  });
});
libraryFilter.addEventListener("change", () => {
  state.libraryFilter = libraryFilter.value as LibraryFilter;
  const library = state.selectedLibraryId ? supportedLibraries().find((entry) => entry.id === state.selectedLibraryId) : null;
  if (library && library.id !== DOWNLOADED_LIBRARY_ID) void refreshLibrary(library, true);
  else renderLibraryGrid(state.selectedLibraryId ? state.libraryCache.get(state.selectedLibraryId) || [] : []);
});
librarySort.addEventListener("change", () => {
  state.librarySort = librarySort.value as LibrarySort;
  const library = state.selectedLibraryId ? supportedLibraries().find((entry) => entry.id === state.selectedLibraryId) : null;
  if (library && library.id !== DOWNLOADED_LIBRARY_ID) void refreshLibrary(library, true);
  else renderLibraryGrid(state.selectedLibraryId ? state.libraryCache.get(state.selectedLibraryId) || [] : []);
});
selectDownloadedButton.addEventListener("click", () => {
  state.downloadedSelectionMode = true;
  state.selectedDownloadIds.clear();
  renderLibraryGrid(state.libraryCache.get(DOWNLOADED_LIBRARY_ID) || []);
});
selectAllDownloadedButton.addEventListener("click", () => {
  for (const checkbox of libraryGrid.querySelectorAll<HTMLInputElement>("[data-download-select]")) {
    if (!checkbox.disabled && checkbox.dataset.downloadSelect) state.selectedDownloadIds.add(checkbox.dataset.downloadSelect);
  }
  renderLibraryGrid(state.libraryCache.get(DOWNLOADED_LIBRARY_ID) || []);
});
cancelDownloadedSelectionButton.addEventListener("click", () => {
  state.downloadedSelectionMode = false;
  state.selectedDownloadIds.clear();
  renderLibraryGrid(state.libraryCache.get(DOWNLOADED_LIBRARY_ID) || []);
});
deleteSelectedDownloadedButton.addEventListener("click", () => { void deleteSelectedDownloads(); });
detailsBackButton.addEventListener("click", returnFromDetails);
detailVersionSelect.addEventListener("change", () => {
  updateDetailPlayButton();
  if (state.detailItem) {
    detailDownloadButton.onclick = () => startDownload(state.detailItem as MediaItem, selectedDetailVersion());
    syncVisibleDownloadButtons();
  }
});
seasonSelect.addEventListener("change", () => {
  if (state.detailItem?.type === "Series") loadEpisodes(state.detailItem.id, seasonSelect.value);
});
selectSeasonEpisodes.addEventListener("change", () => {
  state.selectedEpisodeIds.clear();
  if (selectSeasonEpisodes.checked) {
    for (const episode of state.episodes) if (!downloadForItem(episode.id)) state.selectedEpisodeIds.add(episode.id);
  }
  updateEpisodeSelectionControls();
});
downloadSelectedEpisodes.addEventListener("click", () => { void startSelectedEpisodeDownloads(); });

mobileHomeButton.addEventListener("click", openHome);
mobileSearchButton.addEventListener("click", () => {
  if (state.currentRoute !== "search") {
    state.searchReturnRoute = state.currentRoute === "details" ? "home" : state.currentRoute;
    state.searchReturnScrollTop = contentScroller.scrollTop;
    searchTitle.textContent = "Search";
    searchRows.innerHTML = "";
    setRoute("search");
  }
  searchInput.focus();
});
mobileLibraryButton.addEventListener("click", () => {
  const libraryId = state.selectedLibraryId || supportedLibraries()[0]?.id;
  if (libraryId) void openLibrary(libraryId);
});
mobileLiveTvButton.addEventListener("click", () => { void openLiveTv(); });
mobileWatchPartiesButton.addEventListener("click", () => { void openWatchParties(); });

liveTvGuideTab.addEventListener("click", () => setLiveTvTab("guide"));
liveTvRecordingsTab.addEventListener("click", () => setLiveTvTab("recordings"));
liveTvScheduledTab.addEventListener("click", () => setLiveTvTab("scheduled"));
refreshLiveTvButton.addEventListener("click", () => { void refreshLiveTv(); });
liveTvNowButton.addEventListener("click", () => {
  const now = Date.now();
  if (state.liveTvChannelQuery) {
    state.liveTvChannelQuery = "";
    liveTvChannelSearch.value = "";
    state.liveTvProgramSearch = null;
    state.liveTvProgramSearchRequestId += 1;
    renderLiveTv();
  }
  const guide = state.liveTvGuide;
  if (guide && now >= Date.parse(guide.windowStartUtc) && now < Date.parse(guide.windowEndUtc)) {
    scrollLiveTvGuideToTime(now);
  } else {
    void refreshLiveTv(true, guideWindowForTime(now)).then(() => scrollLiveTvGuideToTime(now));
  }
});
liveTvChannelSearch.addEventListener("input", () => {
  state.liveTvChannelQuery = liveTvChannelSearch.value;
  if (liveTvChannelSearchTimer) clearTimeout(liveTvChannelSearchTimer);
  liveTvChannelSearchTimer = setTimeout(() => {
    liveTvChannelSearchTimer = null;
    if (state.liveTvTab === "guide") void runLiveTvSearch(state.liveTvChannelQuery);
  }, 300);
});
liveTvChannelSearch.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !liveTvChannelSearch.value) return;
  event.preventDefault();
  liveTvChannelSearch.value = "";
  state.liveTvChannelQuery = "";
  state.liveTvProgramSearch = null;
  state.liveTvProgramSearchRequestId += 1;
  renderLiveTv();
});
playerPreviousChannelButton.addEventListener("click", () => { void changeLiveChannel(-1); });
playerNextChannelButton.addEventListener("click", () => { void changeLiveChannel(1); });
playerGoLiveButton.addEventListener("click", () => {
  if (state.playbackItem?.type === "TvChannel") void watchLive(state.playbackItem.id);
});
playerMiniGuideButton.addEventListener("click", togglePlayerMiniGuide);

createWatchPartyButton.addEventListener("click", () => { void createWatchParty(); });
refreshWatchPartiesButton.addEventListener("click", () => { void refreshWatchParties(); });
watchPartyNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void createWatchParty();
  }
});

searchInput.addEventListener("input", () => {
  if (state.searchTimer) clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => runSearch(searchInput.value), 280);
});

profileButton.addEventListener("click", (event) => {
  event.stopPropagation();
  const willOpen = profileMenu.classList.contains("is-hidden");
  profileMenu.classList.toggle("is-hidden", !willOpen);
  profileButton.setAttribute("aria-expanded", String(willOpen));
});

profileMenu.addEventListener("click", (event) => event.stopPropagation());
document.addEventListener("click", () => {
  profileMenu.classList.add("is-hidden");
  profileButton.setAttribute("aria-expanded", "false");
});

refreshButton.addEventListener("click", () => { void retryConnection(refreshButton); });

window.setInterval(() => { void refreshVisibleCatalog(); }, CATALOG_REFRESH_INTERVAL_MS);
window.setInterval(updateCompanionPairingCountdown, 1000);
window.setInterval(() => {
  if (state.currentRoute === "live-tv" && playerView.classList.contains("is-hidden")) void refreshLiveTv(false);
}, 5 * 60_000);
window.setInterval(() => {
  if ((state.currentRoute === "live-tv" && state.liveTvTab === "guide" && state.liveTvGuide)
    || !playerMiniGuide.classList.contains("is-hidden")) updateLiveTvTimeMarkers();
}, 60_000);
window.addEventListener("focus", () => { void refreshVisibleCatalog(); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshVisibleCatalog();
});

downloadsButton.addEventListener("click", () => openDownloads());
checkSmartDownloadsButton.addEventListener("click", () => { void checkSmartDownloads(); });
closeDownloadsButton.addEventListener("click", closeDownloads);
downloadsScrim.addEventListener("click", closeDownloads);
closeCompanionButton.addEventListener("click", closeCompanion);
companionScrim.addEventListener("click", closeCompanion);
closeTrailerButton.addEventListener("click", closeTrailer);
trailerScrim.addEventListener("click", closeTrailer);
openTrailerBrowserButton.addEventListener("click", () => { void openTrailerInBrowser(); });
companionNetwork.addEventListener("change", () => {
  if (!companionNetwork.value) return;
  void window.jellyfin.companion.selectNetwork({ networkId: companionNetwork.value })
    .then(renderCompanion).catch((error) => showToast(errorMessage(error, "The private network could not be selected.")));
});
companionEnabled.addEventListener("change", () => {
  void window.jellyfin.companion.setEnabled({ enabled: companionEnabled.checked })
    .then(renderCompanion).catch((error) => {
      companionEnabled.checked = !companionEnabled.checked;
      showToast(errorMessage(error, "Companion Remote could not be changed."));
    });
});
companionPairButton.addEventListener("click", () => {
  void window.jellyfin.companion.beginPairing().then(renderCompanion)
    .catch((error) => showToast(errorMessage(error, "Pairing could not be started.")));
});
companionCancelPairButton.addEventListener("click", () => {
  void window.jellyfin.companion.cancelPairing().then(renderCompanion)
    .catch((error) => showToast(errorMessage(error, "Pairing could not be cancelled.")));
});
companionRegeneratePortButton.addEventListener("click", () => {
  const warning = "Existing bookmarks and Home Screen shortcuts contain the old port and may need to be removed and added again. Choose a new port?";
  if (!window.confirm(warning)) return;
  void window.jellyfin.companion.regeneratePort({ confirmed: true }).then((result) => {
    renderCompanion(result.state);
    showToast("Companion Remote is using a new port. Re-add old Home Screen shortcuts if they no longer connect.");
  }).catch((error) => showToast(errorMessage(error, "The Companion port could not be changed.")));
});
licensesButton.addEventListener("click", () => { void openLicenses(); });
closeLicensesButton.addEventListener("click", closeLicenses);
licensesScrim.addEventListener("click", closeLicenses);
licensesSearchInput.addEventListener("input", renderLicenses);
cleanMachineDiagnosticsButton.addEventListener("click", openCleanMachineDiagnostics);
loginCleanMachineDiagnosticsButton.addEventListener("click", openCleanMachineDiagnostics);
closeCleanMachineDiagnosticsButton.addEventListener("click", closeCleanMachineDiagnostics);
cleanMachineDiagnosticsScrim.addEventListener("click", closeCleanMachineDiagnostics);
rerunCleanMachineDiagnosticsButton.addEventListener("click", () => { void runCleanMachineDiagnostics(); });
copyCleanMachineDiagnosticsButton.addEventListener("click", async () => {
  copyCleanMachineDiagnosticsButton.disabled = true;
  try {
    const result = await window.jellyfin.diagnostics.copyCleanMachine();
    showToast(result.completed ? "Clean-machine diagnostics copied." : "The diagnostics were not copied.");
  } catch (error) {
    showToast(errorMessage(error, "The diagnostics could not be copied."));
  } finally {
    copyCleanMachineDiagnosticsButton.disabled = false;
  }
});
saveCleanMachineDiagnosticsButton.addEventListener("click", async () => {
  saveCleanMachineDiagnosticsButton.disabled = true;
  try {
    const result = await window.jellyfin.diagnostics.saveCleanMachine();
    if (result.completed) showToast("Clean-machine diagnostics saved.");
  } catch (error) {
    showToast(errorMessage(error, "The diagnostics could not be saved."));
  } finally {
    saveCleanMachineDiagnosticsButton.disabled = false;
  }
});
chooseDownloadLocationButton.addEventListener("click", () => { void chooseDownloadLocation(); });
openDownloadLocationButton.addEventListener("click", () => { void openDownloadLocation(); });
defaultDownloadLocationButton.addEventListener("click", () => { void useDefaultDownloadLocation(); });

logoutButton.addEventListener("click", async () => {
  await closePlayer();
  try {
    await window.jellyfin.session.logout();
  } catch (error) {
    showToast(errorMessage(error, "Sign out could not be completed."));
    return;
  }
  state.session = null;
  resetSignedInState();
  showLogin("Signed out.");
  await discoverServers();
});

closePlayerButton.addEventListener("click", () => { void closePlayer(); });
playerExitButton.addEventListener("click", () => { void closePlayer(); });
playerPlayPauseButton.addEventListener("click", () => { void togglePlayerPaused(); });
playerBack10Button.addEventListener("click", () => { void seekPlayerBy(-10); });
playerForward10Button.addEventListener("click", () => { void seekPlayerBy(10); });
playerSegmentSkipButton.addEventListener("click", () => {
  const playback = playbackForPlayer();
  const segment = playback ? activeMediaSegment(playbackSegments, playback.positionTicks) : null;
  if (!playback || !segment || !state.playbackId || playerSegmentSkipButton.disabled) return;
  void applyPlaybackCommand(
    () => window.jellyfin.playback.seek({ playbackId: state.playbackId as string, positionTicks: segment.endTicks }),
    "Playback could not be seeked.",
  );
});

playerTimeline.addEventListener("pointerenter", (event) => {
  previewHovering = true;
  const playback = playbackForPlayer();
  const bounds = playerTimelineTrack.getBoundingClientRect();
  if (playback && bounds.width > 0) presentTimelinePreview((event.clientX - bounds.left) / bounds.width * playback.durationTicks, event.clientX);
});
playerTimeline.addEventListener("pointermove", (event) => {
  const playback = playbackForPlayer();
  const bounds = playerTimelineTrack.getBoundingClientRect();
  if (playback && bounds.width > 0) presentTimelinePreview((event.clientX - bounds.left) / bounds.width * playback.durationTicks, event.clientX);
});
playerTimeline.addEventListener("pointerleave", () => { previewHovering = false; hideTimelinePreviewIfInactive(); });
playerTimeline.addEventListener("focus", () => {
  previewFocused = true;
  const playback = playbackForPlayer();
  if (playback) presentTimelinePreview(timelineTicks(Number(playerTimeline.value), playback.durationTicks));
});
playerTimeline.addEventListener("blur", () => { previewFocused = false; hideTimelinePreviewIfInactive(); });
playerTimeline.addEventListener("pointerdown", () => { playerTimeline.dataset.scrubbing = "true"; });
playerTimeline.addEventListener("input", () => {
  const playback = playbackForPlayer();
  if (!playback) return;
  playerTimeline.dataset.scrubbing = "true";
  const maximum = playback.seekableUntilTicks ?? playback.durationTicks;
  const requested = timelineTicks(Number(playerTimeline.value), playback.durationTicks);
  const position = Math.min(maximum, requested);
  if (position !== requested) playerTimeline.value = String(safeTimelineValue(position, playback.durationTicks));
  playerCurrentTime.textContent = formatPlaybackTime(position);
  playerTimeline.setAttribute("aria-valuetext", playback.seekableUntilTicks === null || playback.seekableUntilTicks === undefined
    ? formatPlaybackTime(position)
    : `${formatPlaybackTime(position)}; available through ${formatPlaybackTime(playback.seekableUntilTicks)}`);
  presentTimelinePreview(position);
});
playerTimeline.addEventListener("change", () => {
  const playback = playbackForPlayer();
  delete playerTimeline.dataset.scrubbing;
  if (!state.playbackId || !playback?.seekable) return;
  const positionTicks = Math.min(
    playback.seekableUntilTicks ?? playback.durationTicks,
    timelineTicks(Number(playerTimeline.value), playback.durationTicks),
  );
  void applyPlaybackCommand(
    () => window.jellyfin.playback.seek({ playbackId: state.playbackId as string, positionTicks }),
    "Playback could not be seeked.",
  );
  hideTimelinePreviewIfInactive();
});
playerTimeline.addEventListener("pointercancel", () => { delete playerTimeline.dataset.scrubbing; hideTimelinePreviewIfInactive(); });

playerVolume.addEventListener("input", () => {
  const volume = Math.max(0, Math.min(100, Math.round(Number(playerVolume.value))));
  if (volume > 0) lastAudibleVolume = volume;
  playerMuteButton.setAttribute("aria-label", volume === 0 ? "Unmute" : "Mute");
  if (volumeUpdateTimer) clearTimeout(volumeUpdateTimer);
  volumeUpdateTimer = setTimeout(() => {
    if (!state.playbackId) return;
    void applyPlaybackCommand(
      () => window.jellyfin.playback.setVolume({ playbackId: state.playbackId as string, volume }),
      "Volume could not be changed.",
    );
  }, 75);
});
playerMuteButton.addEventListener("click", () => {
  const playback = playbackForPlayer();
  if (!state.playbackId || !playback) return;
  const volume = playback.volume > 0 ? 0 : Math.max(1, lastAudibleVolume);
  void applyPlaybackCommand(
    () => window.jellyfin.playback.setVolume({ playbackId: state.playbackId as string, volume }),
    "Volume could not be changed.",
  );
});
const changePlayerRate = (select: HTMLSelectElement): void => {
  if (!state.playbackId) return;
  const rate = Number(select.value);
  void applyPlaybackCommand(
    () => window.jellyfin.playback.setRate({ playbackId: state.playbackId as string, rate }),
    "Playback speed could not be changed.",
  );
};
const changePlayerAudio = (select: HTMLSelectElement): void => {
  if (!state.playbackId || !select.value) return;
  void applyPlaybackCommand(
    () => window.jellyfin.playback.selectAudio({ playbackId: state.playbackId as string, trackId: Number(select.value) }),
    "The audio track could not be selected.",
  );
};
const changePlayerSubtitle = (select: HTMLSelectElement): void => {
  if (!state.playbackId) return;
  const trackId = select.value ? Number(select.value) : null;
  void applyPlaybackCommand(
    () => window.jellyfin.playback.selectSubtitle({ playbackId: state.playbackId as string, trackId }),
    "The subtitle track could not be selected.",
  );
};
playerRateSelect.addEventListener("change", () => changePlayerRate(playerRateSelect));
playerSettingsRateSelect.addEventListener("change", () => changePlayerRate(playerSettingsRateSelect));
playerAudioSelect.addEventListener("change", () => changePlayerAudio(playerAudioSelect));
playerSettingsAudioSelect.addEventListener("change", () => changePlayerAudio(playerSettingsAudioSelect));
playerSubtitleSelect.addEventListener("change", () => changePlayerSubtitle(playerSubtitleSelect));
playerSettingsSubtitleSelect.addEventListener("change", () => changePlayerSubtitle(playerSettingsSubtitleSelect));
async function changePlayerAdapterPreference(mode: "embedded" | "legacy" | "libmpv"): Promise<void> {
  const previous = playerAdapterPreference?.selected;
  playerAdapterSelect.disabled = true;
  profileAdapterSelect.disabled = true;
  try {
    playerAdapterPreference = await window.jellyfin.playback.setAdapterPreference({
      mode,
    });
    renderPlayerAdapterPreference();
    if (playerAdapterPreference.restartRequired) showToast("Player engine saved. Restart Seeing Stone to apply it.");
  } catch (error) {
    if (previous) playerAdapterSelect.value = previous;
    if (previous) profileAdapterSelect.value = previous;
    showToast(errorMessage(error, "The player engine could not be changed."));
    renderPlayerAdapterPreference();
  }
}

playerAdapterSelect.addEventListener("change", () => {
  const mode = playerAdapterSelect.value;
  void changePlayerAdapterPreference(mode === "legacy" || mode === "libmpv" ? mode : "embedded");
});
profileAdapterSelect.addEventListener("change", () => {
  const mode = profileAdapterSelect.value;
  void changePlayerAdapterPreference(mode === "legacy" || mode === "libmpv" ? mode : "embedded");
});
function togglePlayerFullscreen(): void {
  const playback = playbackForPlayer();
  if (!state.playbackId || !playback) return;
  void applyPlaybackCommand(
    () => window.jellyfin.playback.setFullscreen({ playbackId: state.playbackId as string, fullscreen: !playback.fullscreen }),
    "Fullscreen could not be changed.",
  ).then(schedulePlayerViewportSettled);
}

playerFullscreenButton.addEventListener("click", togglePlayerFullscreen);
playerViewport.addEventListener("click", () => {
  if (!playbackForPlayer()?.fullscreen) return;
  if (playerViewportClickTimer) clearTimeout(playerViewportClickTimer);
  // Wait briefly so a double-click can keep its existing fullscreen behavior
  // without also toggling pause twice.
  playerViewportClickTimer = setTimeout(() => {
    playerViewportClickTimer = null;
    if (playbackForPlayer()?.fullscreen) void togglePlayerPaused();
  }, 230);
});
playerViewport.addEventListener("dblclick", (event) => {
  event.preventDefault();
  if (playerViewportClickTimer) clearTimeout(playerViewportClickTimer);
  playerViewportClickTimer = null;
  togglePlayerFullscreen();
});

const playNext = (): void => {
  const next = state.soloDiagnostics?.nextUp;
  if (next && canPlay(next)) void playItem(next);
};
playerNextButton.addEventListener("click", playNext);
playerNextCardButton.addEventListener("click", playNext);
nextEpisodePlayNowButton.addEventListener("click", () => {
  if (!state.playbackId || !playbackForPlayer()?.nextEpisodeCountdown) return;
  nextEpisodePlayNowButton.disabled = true;
  nextEpisodeCancelButton.disabled = true;
  void applyPlaybackCommand(
    () => window.jellyfin.playback.continueNextEpisode({ playbackId: state.playbackId as string }),
    "The next episode could not be started.",
  );
});
nextEpisodeCancelButton.addEventListener("click", () => {
  if (!state.playbackId || !playbackForPlayer()?.nextEpisodeCountdown) return;
  nextEpisodePlayNowButton.disabled = true;
  nextEpisodeCancelButton.disabled = true;
  void applyPlaybackCommand(
    () => window.jellyfin.playback.cancelNextEpisode({ playbackId: state.playbackId as string }),
    "Automatic playback could not be cancelled.",
  );
});
playerEpisodeBrowserButton.addEventListener("click", () => {
  if (playerEpisodeBrowser.classList.contains("is-hidden")) openPlayerEpisodeBrowser();
  else closePlayerEpisodeBrowser();
});
closePlayerEpisodeBrowserButton.addEventListener("click", () => closePlayerEpisodeBrowser());
playerEpisodeSeasonSelect.addEventListener("change", () => {
  const seriesId = state.playerEpisodeBrowserSeriesId;
  const seasonId = playerEpisodeSeasonSelect.value;
  if (seriesId && seasonId) void loadPlayerEpisodeSeason(seriesId, seasonId);
});
playerSettingsButton.addEventListener("click", togglePlayerSettings);
closePlayerSettingsButton.addEventListener("click", () => closePlayerSettings());
playerSettingsDiagnosticsButton.addEventListener("click", () => {
  closePlayerSettings(false);
  setSessionPanelView("solo");
  setSessionPanelCollapsed(false);
  const advanced = sessionPanelContent.querySelector<HTMLDetailsElement>(".session-details");
  if (advanced) advanced.open = true;
  (advanced?.querySelector<HTMLElement>("summary") || sessionPanelContent).focus();
});
sessionSoloTab.addEventListener("click", () => setSessionPanelView("solo"));
sessionWatchpartyTab.addEventListener("click", () => setSessionPanelView("watchparty"));
for (const tab of [sessionSoloTab, sessionWatchpartyTab]) {
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const nextView: SessionPanelView = state.sessionPanelView === "solo" ? "watchparty" : "solo";
    setSessionPanelView(nextView);
    (nextView === "solo" ? sessionSoloTab : sessionWatchpartyTab).focus();
  });
}
toggleSessionPanelButton.addEventListener("click", () => {
  setSessionPanelCollapsed(true);
  openSessionPanelButton.focus();
});
openSessionPanelButton.addEventListener("click", () => {
  setSessionPanelCollapsed(false);
  requestAnimationFrame(() => (state.sessionPanelView === "solo" ? sessionSoloTab : sessionWatchpartyTab).focus());
});
sessionPanelScrim.addEventListener("click", () => {
  setSessionPanelCollapsed(true);
  openSessionPanelButton.focus();
});
playerView.addEventListener("pointermove", markPlayerActivity);
playerView.addEventListener("click", markPlayerActivity);
playerView.addEventListener("focusin", markPlayerActivity);
playerControls.addEventListener("focusout", () => queueMicrotask(markPlayerActivity));
window.addEventListener("pointermove", () => {
  if (!playerView.classList.contains("is-hidden") && playbackForPlayer()?.fullscreen) markPlayerActivity();
}, { capture: true, passive: true });

for (const button of playerView.querySelectorAll<HTMLButtonElement>("[data-player-route]")) {
  button.addEventListener("click", async () => {
    const route = button.dataset.playerRoute;
    await closePlayer();
    if (route === "home") openHome();
    else if (route === "watch-parties") await openWatchParties();
    else if (route === "live-tv") await openLiveTv();
  });
}

document.addEventListener("keydown", (event) => {
  if (smartDownloadDialog.open || smartUnfollowDialog.open) return;
  if (!trailerPanel.classList.contains("is-hidden") && event.key === "Escape") {
    event.preventDefault();
    closeTrailer();
    return;
  }
  if (!cleanMachineDiagnosticsPanel.classList.contains("is-hidden")) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeCleanMachineDiagnostics();
      return;
    }
    if (event.key === "Tab") {
      const focusable = Array.from(cleanMachineDiagnosticsPanel.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex]:not([tabindex='-1'])"));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first && last && event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (first && last && !event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    return;
  }

  if (!licensesPanel.classList.contains("is-hidden")) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeLicenses();
      return;
    }
    if (event.key === "Tab") {
      const focusable = Array.from(licensesPanel.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex='-1'])"));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first && last && event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (first && last && !event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    return;
  }

  if (!playerView.classList.contains("is-hidden")) {
    if (handlePlayerMiniGuideKey(event)) return;
    markPlayerActivity();
    if (event.key === "Escape") {
      event.preventDefault();
      if (!playerEpisodeBrowser.classList.contains("is-hidden")) closePlayerEpisodeBrowser();
      else if (playbackForPlayer()?.fullscreen) togglePlayerFullscreen();
      else if (!playerSettingsMenu.classList.contains("is-hidden")) closePlayerSettings();
      else if (playerDrawerMode && !state.sessionPanelCollapsed) {
        setSessionPanelCollapsed(true);
        openSessionPanelButton.focus();
      }
      else void closePlayer();
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, select, textarea")) return;
    const key = event.key.toLocaleLowerCase();
    if (target?.closest("button") && (key === " " || key === "enter")) return;
    if (key === " " || key === "k") {
      event.preventDefault();
      void togglePlayerPaused();
    } else if (key === "arrowleft" || key === "j") {
      event.preventDefault();
      void seekPlayerBy(-10);
    } else if (key === "arrowright" || key === "l") {
      event.preventDefault();
      void seekPlayerBy(10);
    } else if (key === "m") {
      event.preventDefault();
      playerMuteButton.click();
    } else if (key === "f") {
      event.preventDefault();
      playerFullscreenButton.click();
    }
    return;
  }

  if (event.key !== "Escape") return;
  if (!profileMenu.classList.contains("is-hidden")) {
    profileMenu.classList.add("is-hidden");
    profileButton.setAttribute("aria-expanded", "false");
  } else if (!downloadsPanel.classList.contains("is-hidden")) {
    closeDownloads();
  } else if (!companionPanel.classList.contains("is-hidden")) {
    closeCompanion();
  } else if (state.currentRoute === "details") {
    returnFromDetails();
  }
});

window.jellyfin.downloads.subscribe((downloads) => {
  const completedBefore = new Set(state.downloads
    .filter((download) => download.state === "downloaded")
    .map((download) => download.itemId));
  const completedAfter = new Set(downloads
    .filter((download) => download.state === "downloaded")
    .map((download) => download.itemId));
  const completedMembershipChanged = completedBefore.size !== completedAfter.size
    || [...completedBefore].some((itemId) => !completedAfter.has(itemId));
  state.downloads = downloads;
  renderDownloads();
  syncVisibleDownloadButtons();
  updateDownloadedSelectionActions();
  if (state.currentRoute === "library"
    && state.selectedLibraryId !== DOWNLOADED_LIBRARY_ID
    && state.libraryFilter === "downloaded"
    && completedMembershipChanged) {
    renderLibraryGrid(state.selectedLibraryId ? state.libraryCache.get(state.selectedLibraryId) || [] : []);
  }
  if (offlinePlayableRefreshTimer) clearTimeout(offlinePlayableRefreshTimer);
  offlinePlayableRefreshTimer = setTimeout(() => {
    offlinePlayableRefreshTimer = null;
    void window.jellyfin.downloads.listOfflinePlayable().then((items) => {
      state.offlinePlayable = items;
      syncDownloadedLibrary();
    }).catch(() => undefined);
  }, 500);
});

window.jellyfin.smartDownloads.subscribe((smartDownloads) => {
  state.smartDownloads = smartDownloads;
  renderSmartDownloads();
  renderDownloadedFollowedSeries();
  updateDetailSmartDownloadsButton();
  if (smartDownloads.notice) showToast(smartDownloads.notice);
});

window.jellyfin.watchParties.subscribe((watchParties) => {
  state.watchParties = watchParties;
  if (state.currentRoute === "watch-parties") renderWatchParties();
  if (state.currentRoute === "details") renderDetailVersionControl();
  if (!playerView.classList.contains("is-hidden")) renderPlayerState();
});

window.jellyfin.companion.subscribe((status) => {
  renderCompanionNavStatus(status);
  if (!companionPanel.classList.contains("is-hidden")) renderCompanion(status);
});

void bootstrap();
