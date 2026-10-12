import type { CompanionBootstrap, CompanionCommand, CompanionCommandEnvelope, CompanionLibraryPage, CompanionLibrarySort, CompanionLibrarySummary, CompanionLiveTvGuide } from "../shared/companionContracts";

export interface RuntimeSession {
  protocolVersion: 3;
  sessionEpoch: string;
  csrfToken: string;
  nextSequence: number;
  webSocketTicket: string;
  bootstrap: CompanionBootstrap;
}

export function newCompanionCommandId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class CompanionRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "CompanionRequestError";
  }
}

async function json<T>(path: string, init?: RequestInit, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const value = await response.json().catch(() => ({})) as { error?: { message?: string } };
    if (!response.ok) throw new CompanionRequestError(value.error?.message || `Request failed (${response.status})`, response.status);
    return value as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("The desktop took too long to respond. Please try again.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export const pair = (input: { ticket?: string; code?: string; name: string }): Promise<{ paired: true }> =>
  json("/api/v1/pair", { method: "POST", body: JSON.stringify(input) });
export const getSession = (): Promise<RuntimeSession> => json("/api/v1/session");
export const longPoll = (): Promise<CompanionBootstrap> => json("/api/v1/poll", undefined, 35_000);
export const getHome = (): Promise<CompanionLibraryPage> => json("/api/v1/library/home?limit=30");
export const getLibraries = (): Promise<CompanionLibrarySummary[]> => json("/api/v1/libraries");
export const getLibrary = (libraryRef: string, sort: CompanionLibrarySort, offset = 0): Promise<CompanionLibraryPage> =>
  json(`/api/v1/library/${encodeURIComponent(libraryRef)}?sort=${encodeURIComponent(sort)}&offset=${offset}&limit=30`);
export const getSeries = (seriesRef: string, offset = 0): Promise<CompanionLibraryPage> =>
  json(`/api/v1/series/${encodeURIComponent(seriesRef)}?offset=${offset}&limit=30`);
export const search = (query: string): Promise<CompanionLibraryPage> =>
  json(`/api/v1/library/search?q=${encodeURIComponent(query)}&limit=50`);
export const getLiveTvGuide = (): Promise<CompanionLiveTvGuide> => json("/api/v1/live-tv/guide");
export const getYouTubeState = (): Promise<import("../shared/companionContracts").CompanionYouTubeState> => json("/api/v1/youtube/state");
export const browseYouTube = (query: string, pageToken = ""): Promise<import("../shared/companionContracts").CompanionYouTubePage> =>
  json(`/api/v1/youtube/browse?q=${encodeURIComponent(query)}&pageToken=${encodeURIComponent(pageToken)}`);

const pendingCommands = new WeakMap<RuntimeSession, Promise<void>>();

export function sendCommand(session: RuntimeSession, command: CompanionCommand): Promise<void> {
  const envelope: CompanionCommandEnvelope = {
    sessionEpoch: session.sessionEpoch,
    sequence: session.nextSequence++,
    commandId: newCompanionCommandId(),
    playbackId: session.bootstrap.player.playbackId,
    command,
  };
  // Keep increasing sequences in arrival order, including quick taps on different controls.
  // Capture playback identity now so a queued action cannot affect replacement media.
  const request = (pendingCommands.get(session) ?? Promise.resolve()).catch(() => undefined).then(() =>
    json<void>("/api/v1/commands", {
      method: "POST",
      headers: { "X-Seeing-Stone-CSRF": session.csrfToken },
      body: JSON.stringify(envelope),
    }));
  pendingCommands.set(session, request);
  void request.finally(() => {
    if (pendingCommands.get(session) === request) pendingCommands.delete(session);
  }).catch(() => undefined);
  return request;
}
