"use strict";

const { contextBridge } = require("electron");

const TICKS_PER_SECOND = 10_000_000;
const item = Object.freeze({
  id: "visual-fixture-episode",
  name: "The Shattered Vale",
  type: "Episode",
  overview: "A visual acceptance fixture used only to verify the player shell layout and accessibility behavior.",
  productionYear: 2026,
  premiereYear: 2026,
  officialRating: null,
  communityRating: null,
  runTimeTicks: 56 * 60 * TICKS_PER_SECOND,
  genres: [],
  primaryImageAspectRatio: null,
  imageTags: {},
  backdropImageTag: null,
  parentThumbItemId: null,
  parentThumbImageTag: null,
  seriesId: "visual-fixture-series",
  seriesName: "Visual QA Fixture",
  seasonId: "visual-fixture-season",
  indexNumber: 3,
  parentIndexNumber: 1,
  userData: { played: false, playbackPositionTicks: 0, playedPercentage: 0 },
  hasTrailer: false,
  playable: true,
});
const nextItem = Object.freeze({ ...item, id: "visual-fixture-next", name: "The Hidden Gate", indexNumber: 4 });
const safeSession = Object.freeze({
  authenticated: true,
  persistence: "none",
  server: { address: "https://visual.invalid", id: "visual-server", name: "Isolated visual harness", version: "test-fixture" },
  user: { id: "visual-user", name: "Visual QA" },
});
let watchPartyState = {
  availability: "available",
  connection: "connected",
  groups: [],
  joinedGroup: null,
  sharedControls: true,
  sync: { serverLatencyMs: null, localDriftTicks: null, authoritativeTimelineReady: false, measuredAtUnixMs: null },
  telemetry: {
    protocolVersion: 1,
    availability: "disabled",
    transport: "none",
    reason: "Enhanced participant status is unavailable in this isolated visual fixture. Standard Jellyfin SyncPlay remains active.",
    participants: [],
    incident: null,
    policy: { mode: "wait-for-all", gracePeriodMs: 1500 },
  },
  error: null,
};
const audioTracks = Object.freeze([
  Object.freeze({ id: 1, streamIndex: 0, type: "audio", title: "Fixture stereo", language: "eng", selected: true, codec: "aac", channels: 2, isDefault: true, isForced: false, external: false }),
  Object.freeze({ id: 2, streamIndex: 1, type: "audio", title: "Fixture commentary", language: "eng", selected: false, codec: "aac", channels: 2, isDefault: false, isForced: false, external: false }),
]);
const subtitleTracks = Object.freeze([
  Object.freeze({ id: 3, streamIndex: 2, type: "subtitle", title: "Fixture English", language: "eng", selected: false, codec: "ass", channels: null, isDefault: true, isForced: false, external: false }),
  Object.freeze({ id: 4, streamIndex: 3, type: "subtitle", title: "Fixture forced", language: "eng", selected: false, codec: "ass", channels: null, isDefault: false, isForced: true, external: false }),
]);
const viewportInputs = [];
let playback = {
  playbackId: null,
  itemId: null,
  phase: "idle",
  source: null,
  diagnostics: {
    sourceKind: null,
    playbackRate: 1,
    bufferAheadTicks: null,
    container: null,
    videoCodec: null,
    audioCodec: null,
    audioChannels: null,
    resolution: null,
    bitrate: null,
    videoRange: null,
    transcodeReason: null,
  },
  positionTicks: 0,
  durationTicks: 0,
  paused: true,
  buffering: false,
  seekable: false,
  volume: 80,
  fullscreen: false,
  audioTracks: [],
  subtitleTracks: [],
  error: null,
};
const playbackListeners = new Set();
const watchPartyListeners = new Set();

function copy(value) { return structuredClone(value); }
function emitPlayback() { for (const listener of playbackListeners) listener(copy(playback)); }
function updatePlayback(changes) {
  playback = { ...playback, ...changes };
  emitPlayback();
  return copy(playback);
}

function emitWatchParty() { for (const listener of watchPartyListeners) listener(copy(watchPartyState)); }
function updateWatchParty(changes) {
  watchPartyState = { ...watchPartyState, ...changes };
  emitWatchParty();
  return copy(watchPartyState);
}

function selectedTracks(tracks, selectedId) {
  return tracks.map((track) => ({ ...track, selected: track.id === selectedId }));
}

function playbackItem() {
  return playback.itemId === nextItem.id ? nextItem : item;
}

const downloads = Object.freeze({
  list: async () => [],
  getLocation: async () => ({ mode: "default", label: "Windows Videos folder" }),
  chooseLocation: async () => null,
  useDefaultLocation: async () => ({ mode: "default", label: "Windows Videos folder" }),
  openLocation: async () => ({ opened: false }),
  start: async () => { throw new Error("Not available in visual acceptance."); },
  pause: async () => { throw new Error("Not available in visual acceptance."); },
  resume: async () => { throw new Error("Not available in visual acceptance."); },
  retry: async () => { throw new Error("Not available in visual acceptance."); },
  cancel: async () => { throw new Error("Not available in visual acceptance."); },
  delete: async () => { throw new Error("Not available in visual acceptance."); },
  setKeep: async () => { throw new Error("Not available in visual acceptance."); },
  subscribe(listener) { queueMicrotask(() => listener([])); return () => undefined; },
});

const bridge = Object.freeze({
  server: Object.freeze({ discover: async () => [], connect: async () => ({ ...safeSession.server, connectionId: "visual" }) }),
  session: Object.freeze({
    login: async () => copy(safeSession),
    restore: async () => copy(safeSession),
    getState: async () => copy(safeSession),
    logout: async () => ({ authenticated: false, persistence: "none", server: null, user: null }),
  }),
  home: Object.freeze({
    get: async () => ({
      libraries: [],
      resumeItems: [copy(item)],
      nextUpItems: [copy(nextItem)],
      latestRows: [{ library: { id: "visual-library", name: "Visual QA", collectionType: "tvshows" }, items: [copy(item)] }],
    }),
  }),
  libraries: Object.freeze({ list: async () => [], getItems: async () => [copy(item)] }),
  search: Object.freeze({ query: async () => [copy(item)] }),
  items: Object.freeze({
    getDetails: async ({ itemId }) => copy(itemId === nextItem.id ? nextItem : item),
    openTrailer: async () => ({ opened: false }),
    setWatched: async ({ itemId, watched }) => ({ itemId, watched, synchronization: "synchronized" }),
  }),
  shows: Object.freeze({ getSeasons: async () => [], getEpisodes: async () => [] }),
  artwork: Object.freeze({ getUrl: async () => "" }),
  mediaSources: Object.freeze({ getCapabilities: async () => ({ itemId: item.id, sources: [] }) }),
  downloads,
  playback: Object.freeze({
    async start({ itemId }) {
      const selectedItem = itemId === nextItem.id ? nextItem : item;
      updatePlayback({
        playbackId: "visual-playback",
        itemId: selectedItem.id,
        phase: "playing",
        source: "server",
        diagnostics: { ...playback.diagnostics, sourceKind: "direct-play" },
        positionTicks: 0,
        durationTicks: selectedItem.runTimeTicks,
        paused: false,
        seekable: true,
        audioTracks: copy(audioTracks),
        subtitleTracks: copy(subtitleTracks),
      });
      return { playbackId: "visual-playback", resumePositionTicks: 0, durationTicks: selectedItem.runTimeTicks, source: "server", sourceKind: "direct-play" };
    },
    setPaused: async ({ paused }) => updatePlayback({ paused, phase: paused ? "paused" : "playing" }),
    seek: async ({ positionTicks }) => updatePlayback({ positionTicks }),
    setRate: async ({ rate }) => updatePlayback({ diagnostics: { ...playback.diagnostics, playbackRate: rate } }),
    setVolume: async ({ volume }) => updatePlayback({ volume }),
    selectAudio: async ({ trackId }) => updatePlayback({ audioTracks: selectedTracks(playback.audioTracks, trackId) }),
    selectSubtitle: async ({ trackId }) => updatePlayback({ subtitleTracks: selectedTracks(playback.subtitleTracks, trackId) }),
    setFullscreen: async ({ fullscreen }) => updatePlayback({ fullscreen }),
    stop: async () => updatePlayback({ playbackId: null, itemId: null, phase: "stopped", source: null, paused: true, seekable: false }),
    getState: async () => copy(playback),
    setViewport: async (input) => {
      viewportInputs.push(copy(input));
      if (viewportInputs.length > 200) viewportInputs.shift();
      return { embedded: true };
    },
    getAdapterPreference: async () => ({ active: "embedded", selected: "embedded", embeddedAvailable: true, restartRequired: false }),
    setAdapterPreference: async () => ({ active: "embedded", selected: "embedded", embeddedAvailable: true, restartRequired: false }),
    subscribe(listener) { playbackListeners.add(listener); queueMicrotask(() => listener(copy(playback))); return () => playbackListeners.delete(listener); },
  }),
  sessionPanel: Object.freeze({
    getSolo: async () => ({
      playback: copy(playback),
      connection: { state: "connected", serverName: "Isolated visual harness", serverVersion: "test-fixture", requestLatencyMs: null, measuredAt: null },
      item: copy(playbackItem()),
      nextUp: playback.itemId === nextItem.id ? null : copy(nextItem),
    }),
  }),
  licenses: Object.freeze({ list: async () => ({ schemaVersion: 1, projectName: "Seeing Stone", projectLicense: "GPL-2.0-or-later", entries: [] }) }),
  watchParties: Object.freeze({
    getState: async () => copy(watchPartyState),
    list: async () => copy(watchPartyState),
    create: async () => copy(watchPartyState),
    join: async () => copy(watchPartyState),
    leave: async () => updateWatchParty({ joinedGroup: null }),
    wait: async () => updateWatchParty({
      joinedGroup: watchPartyState.joinedGroup ? { ...watchPartyState.joinedGroup, playbackState: "Paused" } : null,
    }),
    continue: async () => updateWatchParty({
      joinedGroup: watchPartyState.joinedGroup ? { ...watchPartyState.joinedGroup, playbackState: "Playing" } : null,
    }),
    resync: async () => copy(watchPartyState),
    setBufferingPolicy: async (input) => {
      return updateWatchParty({
        telemetry: { ...watchPartyState.telemetry, policy: { mode: input.mode, gracePeriodMs: 1500 } },
      });
    },
    setVisible: async () => copy(watchPartyState),
    subscribe(listener) {
      watchPartyListeners.add(listener);
      queueMicrotask(() => listener(copy(watchPartyState)));
      return () => watchPartyListeners.delete(listener);
    },
  }),
});

contextBridge.exposeInMainWorld("jellyfin", bridge);
contextBridge.exposeInMainWorld("seeingStoneVisualAcceptance", Object.freeze({
  getPlayback: () => copy(playback),
  getViewportInputs: () => copy(viewportInputs),
  clearViewportInputs: () => { viewportInputs.length = 0; },
  joinWatchPartyFixture: () => updateWatchParty({
    groups: [{
      groupId: "11111111111141118111111111111111",
      name: "Isolated fixture party",
      playbackState: "Playing",
      participants: ["Fixture Host", "Fixture Guest"],
      participantCount: 2,
      lastUpdatedAt: "2026-07-17T00:00:00.000Z",
    }],
    joinedGroup: {
      groupId: "11111111111141118111111111111111",
      name: "Isolated fixture party",
      playbackState: "Playing",
      participants: ["Fixture Host", "Fixture Guest"],
      participantCount: 2,
      lastUpdatedAt: "2026-07-17T00:00:00.000Z",
      currentItemId: item.id,
      playlistItemId: "22222222222242228222222222222222",
    },
  }),
  transitionToNext: () => updatePlayback({
    playbackId: "visual-transition",
    itemId: nextItem.id,
    phase: "playing",
    positionTicks: 0,
    durationTicks: nextItem.runTimeTicks,
  }),
  terminatePlayer: () => updatePlayback({
    playbackId: null,
    itemId: null,
    phase: "disconnected",
    source: null,
    paused: true,
    seekable: false,
    error: "Visual fixture termination",
  }),
}));
