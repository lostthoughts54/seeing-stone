"use strict";

// Extend the existing isolated player fixture; no real accounts or media are used.
const { contextBridge } = require("electron");
const expose = contextBridge.exposeInMainWorld.bind(contextBridge);
const subscribers = new Set();
const calls = [];
let failSeasons = true;
let failEpisodes = true;
let detailDelay = 0;
let searchOptions = {};
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds || 0));
const base = {
  id: "polish-series", name: "The Shattered Vale", type: "Series", overview: "A journey beyond the familiar.",
  productionYear: 2026, premiereYear: 2026, officialRating: "TV-PG", communityRating: 8.2,
  runTimeTicks: 33600000000, genres: ["Adventure"], people: [], imageTags: {}, backdropImageTag: null,
  primaryImageAspectRatio: null, parentThumbItemId: null, parentThumbImageTag: null,
  seriesId: null, seriesName: null, seasonId: null, indexNumber: null, parentIndexNumber: null,
  userData: { played: false, playbackPositionTicks: 0, playedPercentage: 0 }, hasTrailer: false, playable: false,
};
const season = { ...base, id: "polish-season", name: "Season 1", type: "Season" };
const episode = { ...base, id: "polish-episode", name: "The Hidden Gate", type: "Episode", playable: true,
  seriesId: base.id, seriesName: base.name, seasonId: season.id, indexNumber: 1, parentIndexNumber: 1 };
const movie = { ...base, id: "polish-movie", name: "A Distant Light", type: "Movie", playable: true };
const library = { id: "polish-library", name: "Shows", collectionType: "tvshows" };
let downloads = [
  { downloadId: "000-newest", item: movie, name: movie.name, itemId: movie.id },
  { downloadId: "zzz-oldest", item: episode, name: episode.name, itemId: episode.id },
].map((entry) => ({ ...entry, itemType: entry.item.type, state: "downloading", bytesDownloaded: 1024,
  expectedSize: 102400, progressPercent: 1, resumePositionTicks: 0, localPlaybackAvailable: false,
  canWatchWhileDownloading: false, keepDownloaded: false, smartManaged: false, error: null,
  canPause: true, canResume: false, canRetry: false, canCancel: true, canDelete: false }));
const companion = { enabled: false, runtimeState: "disabled", message: null, connectedDevices: 0,
  networks: [], selectedNetworkId: null, addresses: [], devices: [], pairing: null };
const features = { connection: "unavailable", room: null, rooms: [], error: null, local: null };
const noSubscribe = () => () => {};
contextBridge.exposeInMainWorld = (name, value) => {
  if (name !== "jellyfin") return expose(name, value);
  const api = {
    ...value,
    home: { get: async () => ({ libraries: [library], resumeItems: [], nextUpItems: [], latestRows: [{ library, items: [base, movie] }] }) },
    libraries: { list: async () => [library], getItems: async () => [base, movie],
      getFilterOptions: async input => {
        calls.push(`choices:${input.kind}`);
        return { items: input.kind === "genres" ? [{ value: "Mystery", label: "Mystery" }] : [{ value: "off-page-person", label: "Off-page Actor" }], hasMore: false, nextStartIndex: null };
      } },
    browse: { get: async input => { calls.push(`browse:${JSON.stringify(input)}`); return { items: [base, movie], totalRecordCount: 2 }; } },
    search: { query: async () => {
      const options = { ...searchOptions };
      calls.push("search:library");
      await pause(options.mediaDelay);
      if (options.mediaFails) throw Error("Library unavailable");
      return options.emptyMedia ? [] : [base, movie];
    } },
    liveTv: { ...value.liveTv, searchPrograms: async () => {
      const options = { ...searchOptions };
      calls.push("search:live-tv");
      await pause(options.televisionDelay);
      if (options.televisionFails) throw Error("Guide unavailable");
      return { channels: options.channels ? [{ id: "fixture-channel", name: "Fixture News", number: "1", categories: [], imageTag: null, isFavorite: false, currentProgramId: null }] : [], programs: [] };
    } },
    items: { ...value.items, getDetails: async ({ itemId }) => {
      if (detailDelay) await new Promise(resolve => setTimeout(resolve, detailDelay));
      return itemId === episode.id ? episode : itemId === movie.id ? movie : base;
    } },
    shows: {
      getSeasons: async () => { if (failSeasons) { failSeasons = false; throw Error("The server is temporarily unavailable."); } return [season]; },
      getEpisodes: async () => { if (failEpisodes) { failEpisodes = false; throw Error("Episodes could not be loaded."); } return [episode]; },
    },
    downloads: { ...value.downloads, list: async () => downloads,
      listOfflinePlayable: async () => downloads.filter(d => d.state === "downloaded").map(d => ({ item: d.item, resumePositionTicks: 0, sourceKind: "offline-local", localPlaybackAvailable: true })),
      subscribe: listener => { subscribers.add(listener); return () => subscribers.delete(listener); },
      getStorage: async () => ({ bytesUsed: 2048, bytesAvailable: 102400000, bytesTotal: 204800000 }),
      getLocation: async () => ({ mode: "default", label: "Windows Videos folder" }),
    },
    smartDownloads: { getState: async () => ({ series: [], notice: null }), subscribe: noSubscribe },
    updates: { subscribe: noSubscribe },
    companion: { getStatus: async () => companion, subscribe: noSubscribe,
      getYouTubeSearchSettings: async () => ({ configured: false, source: "none", storageUnavailable: false }) },
    youtubeSettings: { get: async () => ({ configured: false, source: "none" }) },
    youtubeRooms: { subscribe: noSubscribe, setVisible: async () => ({}), getState: async () => ({ room: null, rooms: [] }) },
    playerFeatures: { subscribe: noSubscribe, command: async () => features },
    iptv: { getState: async () => ({ providers: [], selectedProviderId: null }), subscribe: noSubscribe },
    playbackFeatures: { getMediaSegments: async () => [], getTrickplayManifest: async () => null },
    diagnostics: { getCleanMachine: async () => ({ overall: "ready", applicationVersion: "fixture", build: "fixture",
      platform: "win32", architecture: "x64", electronVersion: process.versions.electron,
      selectedEngine: "libmpv", activeEngine: "libmpv", checks: [] }) },
    session: { ...value.session, login: async () => {
      calls.push("login"); await new Promise(resolve => setTimeout(resolve, 150)); return value.session.restore();
    } },
  };
  expose(name, api);
};
require("./player-shell-visual-preload.cjs");
expose("polishFixture", {
  progress: () => { downloads = downloads.map(d => ({ ...d, bytesDownloaded: d.bytesDownloaded + 1024, progressPercent: d.progressPercent + 1 })); for (const subscriber of subscribers) subscriber(downloads); },
  delayDetails: value => { detailDelay = value; },
  configureSearch: options => { searchOptions = options; },
  finishDownloads: () => { downloads = downloads.map(d => ({ ...d, state: "downloaded", canDelete: true, canPause: false, progressPercent: 100 })); for (const subscriber of subscribers) subscriber(downloads); },
  calls: () => calls,
});
