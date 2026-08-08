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

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const value = await response.json().catch(() => ({})) as { error?: { message?: string } };
  if (!response.ok) throw new Error(value.error?.message || `Request failed (${response.status})`);
  return value as T;
}

export const pair = (input: { ticket?: string; code?: string; name: string }): Promise<{ paired: true }> =>
  json("/api/v1/pair", { method: "POST", body: JSON.stringify(input) });
export const getSession = (): Promise<RuntimeSession> => json("/api/v1/session");
export const longPoll = (): Promise<CompanionBootstrap> => json("/api/v1/poll");
export const getHome = (): Promise<CompanionLibraryPage> => json("/api/v1/library/home?limit=30");
export const getLibraries = (): Promise<CompanionLibrarySummary[]> => json("/api/v1/libraries");
export const getLibrary = (libraryRef: string, sort: CompanionLibrarySort, offset = 0): Promise<CompanionLibraryPage> =>
  json(`/api/v1/library/${encodeURIComponent(libraryRef)}?sort=${encodeURIComponent(sort)}&offset=${offset}&limit=30`);
export const getSeries = (seriesRef: string, offset = 0): Promise<CompanionLibraryPage> =>
  json(`/api/v1/series/${encodeURIComponent(seriesRef)}?offset=${offset}&limit=30`);
export const search = (query: string): Promise<CompanionLibraryPage> =>
  json(`/api/v1/library/search?q=${encodeURIComponent(query)}&limit=50`);
export const getLiveTvGuide = (): Promise<CompanionLiveTvGuide> => json("/api/v1/live-tv/guide");

export function sendCommand(session: RuntimeSession, command: CompanionCommand): Promise<void> {
  const envelope: CompanionCommandEnvelope = {
    sessionEpoch: session.sessionEpoch,
    sequence: session.nextSequence++,
    commandId: newCompanionCommandId(),
    playbackId: session.bootstrap.player.playbackId,
    command,
  };
  return json("/api/v1/commands", {
    method: "POST",
    headers: { "X-Seeing-Stone-CSRF": session.csrfToken },
    body: JSON.stringify(envelope),
  });
}
