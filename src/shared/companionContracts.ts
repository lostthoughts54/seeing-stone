export const COMPANION_PROTOCOL_VERSION = 2 as const;

export type CompanionMediaType =
  | "movie" | "series" | "season" | "episode" | "video"
  | "channel" | "program";

export interface CompanionMediaSummary {
  itemRef: string;
  name: string;
  type: CompanionMediaType;
  seriesName: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  productionYear: number | null;
  runtimeTicks: number;
  playable: boolean;
  artworkRef: string | null;
}

export interface CompanionTrack {
  id: number;
  type: "audio" | "subtitle";
  label: string;
  language: string | null;
  selected: boolean;
}

export interface CompanionLiveContext {
  channelName: string;
  channelNumber: string | null;
  programName: string | null;
  episodeTitle: string | null;
  programStartUtc: string | null;
  programEndUtc: string | null;
}

export interface CompanionLiveTvProgram {
  name: string;
  startUtc: string;
  endUtc: string;
  isLive: boolean;
}

export interface CompanionLiveTvChannel {
  channelRef: string;
  name: string;
  number: string | null;
  isPlaying: boolean;
  programs: CompanionLiveTvProgram[];
}

export interface CompanionLiveTvGuide {
  availability: "available" | "not-configured" | "forbidden" | "offline";
  message: string | null;
  generatedAtUnixMs: number;
  channels: CompanionLiveTvChannel[];
}

export interface CompanionPlayerState {
  protocolVersion: 2;
  revision: number;
  sentAtUnixMs: number;
  playbackId: string | null;
  phase: "idle" | "loading" | "playing" | "paused" | "buffering" | "stopped" | "ended" | "error";
  media: CompanionMediaSummary | null;
  live: CompanionLiveContext | null;
  positionTicks: number;
  durationTicks: number;
  playbackRate: number;
  paused: boolean;
  buffering: boolean;
  seekable: boolean;
  seekableUntilTicks: number | null;
  volume: number;
  muted: boolean;
  audioTracks: CompanionTrack[];
  subtitleTracks: CompanionTrack[];
  controls: {
    canPlayPause: boolean;
    canStop: boolean;
    canSeek: boolean;
    canPrevious: boolean;
    canNext: boolean;
    canGoLive: boolean;
    canPreviousChannel: boolean;
    canNextChannel: boolean;
  };
}

export interface CompanionQueueEntry {
  queueEntryId: string;
  state: "played" | "current" | "upcoming";
  media: CompanionMediaSummary;
  reserved: boolean;
}

export interface CompanionQueueState {
  revision: number;
  editable: boolean;
  blockedReason: "watchparty" | null;
  entries: CompanionQueueEntry[];
}

export interface CompanionLibraryPage {
  revision: string;
  items: CompanionMediaSummary[];
  nextOffset: number | null;
}

export type CompanionLibrarySort = "recently-added" | "release-date" | "alphabetical";

export interface CompanionLibrarySummary {
  itemRef: string;
  name: string;
  collectionType: string | null;
}

export interface CompanionBootstrap {
  protocolVersion: 2;
  player: CompanionPlayerState;
  queue: CompanionQueueState;
  watchParty: CompanionWatchPartyState;
  server: { online: boolean };
}

export interface CompanionWatchPartyState {
  joined: boolean;
  phase: "idle" | "waiting-for-participant" | "preparing" | "ready" | "starting" | "playing" | "error";
  participantCount: number;
  minimumParticipants: 2;
  localSyncOffsetMilliseconds: number;
  scheduledStartAtUnixMs: number | null;
}

export type CompanionCommand =
  | { type: "set-paused"; paused: boolean }
  | { type: "stop" }
  | { type: "seek"; positionTicks: number }
  | { type: "seek-relative"; seconds: number }
  | { type: "set-volume"; volume: number }
  | { type: "toggle-mute" }
  | { type: "previous" }
  | { type: "next" }
  | { type: "go-live" }
  | { type: "previous-channel" }
  | { type: "next-channel" }
  | { type: "start-live"; channelRef: string }
  | { type: "select-audio"; trackId: number }
  | { type: "select-subtitle"; trackId: number | null }
  | { type: "set-watchparty-sync-offset"; offsetMilliseconds: number }
  | {
    type: "send-item";
    itemRef: string;
    placement: "play-now" | "play-next" | "queue-end";
    resumeMode: "resume" | "start-over";
  }
  | { type: "queue-remove"; queueEntryId: string; expectedQueueRevision: number }
  | { type: "queue-play-now"; queueEntryId: string; expectedQueueRevision: number }
  | { type: "queue-move"; queueEntryId: string; beforeEntryId: string | null; expectedQueueRevision: number }
  | { type: "queue-clear-upcoming"; expectedQueueRevision: number };

export interface CompanionCommandEnvelope {
  sessionEpoch: string;
  sequence: number;
  commandId: string;
  playbackId: string | null;
  command: CompanionCommand;
}

export interface CompanionPairedDeviceSummary {
  deviceId: string;
  name: string;
  connected: boolean;
  pairedAt: string;
  lastUsedAt: string | null;
}

export interface CompanionNetworkOption {
  id: string;
  name: string;
  address: string;
  netmask: string;
  recommended: boolean;
}

export interface CompanionPairingView {
  code: string;
  expiresAt: string;
  address: string;
  qrDataUrl: string;
}

export type CompanionRuntimeState =
  | "disabled" | "starting" | "listening" | "network-changed"
  | "firewall-unknown" | "firewall-blocked" | "security-blocked";

export interface CompanionSettingsState {
  enabled: boolean;
  runtimeState: CompanionRuntimeState;
  addresses: string[];
  preferredAddress: string | null;
  port: number | null;
  selectedNetworkId: string | null;
  networks: CompanionNetworkOption[];
  connectedDevices: number;
  devices: CompanionPairedDeviceSummary[];
  pairing: CompanionPairingView | null;
  message: string | null;
}

export interface CompanionSettingsBridge {
  getStatus(): Promise<CompanionSettingsState>;
  setEnabled(input: { enabled: boolean }): Promise<CompanionSettingsState>;
  selectNetwork(input: { networkId: string }): Promise<CompanionSettingsState>;
  beginPairing(): Promise<CompanionSettingsState>;
  cancelPairing(): Promise<CompanionSettingsState>;
  renameDevice(input: { deviceId: string; name: string }): Promise<CompanionSettingsState>;
  revokeDevice(input: { deviceId: string }): Promise<CompanionSettingsState>;
  regeneratePort(input: { confirmed: true }): Promise<{
    oldAddresses: string[];
    newAddresses: string[];
    state: CompanionSettingsState;
  }>;
  subscribe(listener: (state: CompanionSettingsState) => void): () => void;
}
