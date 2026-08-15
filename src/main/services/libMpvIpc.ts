import { AppError } from "./errors";
import type { LibMpvHostCommand, LibMpvHostSource, LibMpvSession } from "./libMpvHost";
import type { MpvCommandClient, MpvMessage } from "./mpvIpc";

function stringValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  throw new AppError("LIBMPV_COMMAND_INVALID", "The playback command was invalid.", 422);
}

function numericValue(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new AppError("LIBMPV_COMMAND_INVALID", "The playback command was invalid.", 422);
  return number;
}

function selectedTrack(value: unknown): number | null {
  if (value === "no" || value === null) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** Adapts the narrow libmpv host contract to the mature shared controller. */
export class LibMpvCommandClient implements MpvCommandClient {
  private readonly listeners = new Set<(message: MpvMessage) => void>();
  private readonly observed = new Map<number, { property: string; serialized: string | null }>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private pollCursor = 0;
  private closed = false;
  private readonly removeEventListener: () => void;

  constructor(
    private readonly session: LibMpvSession,
    onHostEvent: (listener: (event: { kind: string; code?: string }) => void) => () => void,
  ) {
    this.removeEventListener = onHostEvent((event) => {
      if (this.closed) return;
      if (event.kind === "end") this.emit({ event: "end-file", reason: "eof" });
      if (event.kind === "error") this.emit({ event: "end-file", reason: "error", error: event.code });
    });
  }

  async connect(_pipePath: string, _timeoutMilliseconds?: number): Promise<void> {}

  onMessage(listener: (message: MpvMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async command(command: unknown[]): Promise<unknown> {
    if (this.closed || command.length === 0) throw new AppError("PLAYER_UNAVAILABLE", "The player is unavailable.", 409);
    const name = stringValue(command[0]);
    if (name === "get_property") return this.session.query(stringValue(command[1]));
    if (name === "set_property" || name === "set") {
      const property = stringValue(command[1]);
      const value = command[2];
      const mapped: LibMpvHostCommand | null = property === "pause"
        ? (value === true || value === "yes" ? { kind: "pause" } : { kind: "play" })
        : property === "speed" ? { kind: "rate", rate: numericValue(value) }
        : property === "volume" ? { kind: "volume", volume: numericValue(value) }
        : property === "aid" ? { kind: "select-audio", trackId: selectedTrack(value) }
        : property === "sid" ? { kind: "select-subtitle", trackId: selectedTrack(value) }
        : null;
      if (mapped) await this.session.command(mapped);
      return null;
    }
    if (name === "seek") {
      await this.session.command({ kind: "seek", positionTicks: Math.max(0, Math.round(numericValue(command[1]) * 10_000_000)) });
      return null;
    }
    if (name === "sub-add") {
      await this.session.command({
        kind: "add-subtitle",
        location: stringValue(command[1]),
        select: command[2] === "select",
        title: stringValue(command[3] ?? "Jellyfin subtitle").slice(0, 256),
        language: stringValue(command[4] ?? "").slice(0, 32),
      });
      return null;
    }
    if (name === "show-text") {
      await this.session.command({
        kind: "show-message",
        message: stringValue(command[1]).replace(/[\r\n]+/g, " ").slice(0, 160),
        durationMilliseconds: Math.max(500, Math.min(5000, Math.round(numericValue(command[2] ?? 2500)))),
      });
      return null;
    }
    if (name === "loadfile") {
      await this.session.command({ kind: "load", source: { location: stringValue(command[1]) } satisfies LibMpvHostSource });
      this.emit({ event: "file-loaded" });
      return null;
    }
    if (name === "quit") {
      await this.session.stop();
      return null;
    }
    return null;
  }

  async observe(id: number, property: string): Promise<void> {
    if (this.closed) throw new AppError("PLAYER_UNAVAILABLE", "The player is unavailable.", 409);
    const observation = { property, serialized: null as string | null };
    this.observed.set(id, observation);
    await this.pollObservation(observation);
    if (!this.pollTimer) this.pollTimer = setInterval(() => { void this.pollOnce(); }, 100);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.removeEventListener();
    this.observed.clear();
    this.listeners.clear();
  }

  private async pollOnce(): Promise<void> {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      const observations = [...this.observed.values()];
      if (observations.length === 0) return;
      // time-pos drives the visible playhead, so keep it at the original 10 Hz.
      // Every other property is checked round-robin instead of querying the
      // entire native property set in a single frame-blocking burst.
      const position = observations.find((entry) => entry.property === "time-pos") ?? null;
      if (position) await this.pollObservation(position);
      const others = observations.filter((entry) => entry !== position);
      if (others.length > 0) {
        const next = others[this.pollCursor % others.length];
        this.pollCursor = (this.pollCursor + 1) % others.length;
        await this.pollObservation(next);
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollObservation(observed: { property: string; serialized: string | null }): Promise<void> {
    let value: unknown;
    try { value = await this.session.query(observed.property); } catch { return; }
    const serialized = JSON.stringify(value);
    if (serialized === observed.serialized) return;
    observed.serialized = serialized;
    this.emit({ event: "property-change", name: observed.property, data: value });
  }

  private emit(message: MpvMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}
