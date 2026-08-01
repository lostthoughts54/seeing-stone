import { randomUUID } from "node:crypto";
import type { MediaItem } from "../../shared/contracts";
import { AppError } from "./errors";

export type PlaybackQueueEntryState = "played" | "current" | "upcoming";

export interface PlaybackQueueEntry {
  queueEntryId: string;
  item: MediaItem;
  state: PlaybackQueueEntryState;
  reserved: boolean;
}

export interface PlaybackQueueSnapshot {
  revision: number;
  entries: PlaybackQueueEntry[];
}

interface QueueReservation {
  queueEntryId: string;
  completedPlaybackId: string;
}

/**
 * Main-owned, session-only queue. Entries are identified exclusively by their
 * unique queueEntryId so the same Jellyfin item may appear more than once.
 */
export class PlaybackQueueStore {
  private entries: PlaybackQueueEntry[] = [];
  private revision = 0;
  private reservation: QueueReservation | null = null;
  private readonly listeners = new Set<(snapshot: PlaybackQueueSnapshot) => void>();

  onChanged(listener: (snapshot: PlaybackQueueSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): PlaybackQueueSnapshot {
    return {
      revision: this.revision,
      entries: this.entries.map((entry) => ({ ...entry, item: structuredClone(entry.item) })),
    };
  }

  reset(item?: MediaItem): PlaybackQueueSnapshot {
    this.reservation = null;
    this.entries = item ? [this.createEntry(item, "current")] : [];
    return this.changed();
  }

  add(item: MediaItem, placement: "next" | "end" = "end"): PlaybackQueueEntry {
    if (this.entries.length >= 200) throw new AppError("QUEUE_FULL", "The playback queue is full.", 409);
    const entry = this.createEntry(item, "upcoming");
    const currentIndex = this.entries.findIndex((candidate) => candidate.state === "current");
    if (placement === "next" && currentIndex >= 0) this.entries.splice(currentIndex + 1, 0, entry);
    else this.entries.push(entry);
    this.changed();
    return structuredClone(entry);
  }

  peekNext(): PlaybackQueueEntry | null {
    const currentIndex = this.entries.findIndex((entry) => entry.state === "current");
    const entry = currentIndex >= 0 ? this.entries.slice(currentIndex + 1).find((candidate) => candidate.state === "upcoming") : null;
    return entry ? structuredClone(entry) : null;
  }

  getPrevious(): PlaybackQueueEntry | null {
    const currentIndex = this.entries.findIndex((entry) => entry.state === "current");
    if (currentIndex <= 0) return null;
    const entry = [...this.entries.slice(0, currentIndex)].reverse().find((candidate) => candidate.state === "played");
    return entry ? structuredClone(entry) : null;
  }

  reserve(queueEntryId: string, completedPlaybackId: string): void {
    if (this.reservation) {
      if (this.reservation.queueEntryId === queueEntryId && this.reservation.completedPlaybackId === completedPlaybackId) return;
      throw new AppError("QUEUE_CONTINUATION_BUSY", "Another queue transition is already pending.", 409);
    }
    const stored = this.entries.find((entry) => entry.queueEntryId === queueEntryId && entry.state !== "current");
    if (!stored) throw new AppError("QUEUE_CONTINUATION_STALE", "The selected queue entry is no longer available for navigation.", 409);
    stored.reserved = true;
    this.reservation = { queueEntryId, completedPlaybackId };
    this.changed();
  }

  release(queueEntryId: string | null): void {
    if (!queueEntryId || this.reservation?.queueEntryId !== queueEntryId) return;
    const stored = this.entries.find((entry) => entry.queueEntryId === queueEntryId);
    if (stored) stored.reserved = false;
    this.reservation = null;
    this.changed();
  }

  releasePendingReservation(): void {
    if (!this.reservation) return;
    const entry = this.entries.find((candidate) => candidate.queueEntryId === this.reservation?.queueEntryId);
    if (entry) entry.reserved = false;
    this.reservation = null;
    this.changed();
  }

  commit(queueEntryId: string, completedPlaybackId: string): void {
    if (!this.reservation
      || this.reservation.queueEntryId !== queueEntryId
      || this.reservation.completedPlaybackId !== completedPlaybackId) {
      throw new AppError("QUEUE_CONTINUATION_INVARIANT", "The queue transition could not be committed safely.", 500);
    }
    const targetIndex = this.entries.findIndex((entry) => entry.queueEntryId === queueEntryId);
    if (targetIndex < 0) throw new AppError("QUEUE_CONTINUATION_INVARIANT", "The queue transition entry is missing.", 500);
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      entry.reserved = false;
      if (index < targetIndex) entry.state = "played";
      else if (index === targetIndex) entry.state = "current";
      else entry.state = "upcoming";
    }
    this.reservation = null;
    this.changed();
  }

  recoverAfterInvariant(queueEntryId: string): void {
    const targetIndex = this.entries.findIndex((entry) => entry.queueEntryId === queueEntryId);
    if (targetIndex < 0) {
      this.reset();
      return;
    }
    this.reservation = null;
    for (let index = 0; index < this.entries.length; index += 1) {
      this.entries[index].reserved = false;
      this.entries[index].state = index < targetIndex ? "played" : index === targetIndex ? "current" : "upcoming";
    }
    this.changed();
  }

  remove(queueEntryId: string, expectedRevision: number): PlaybackQueueSnapshot {
    this.assertRevision(expectedRevision);
    if (this.reservation?.queueEntryId === queueEntryId) {
      throw new AppError("QUEUE_ENTRY_RESERVED", "That queue entry is transitioning and cannot be removed.", 409);
    }
    const index = this.entries.findIndex((entry) => entry.queueEntryId === queueEntryId);
    if (index < 0) throw new AppError("QUEUE_ENTRY_NOT_FOUND", "That queue entry is unavailable.", 404);
    if (this.entries[index].state === "current") throw new AppError("QUEUE_CURRENT_ENTRY", "The current item cannot be removed.", 409);
    this.entries.splice(index, 1);
    return this.changed();
  }

  move(queueEntryId: string, beforeEntryId: string | null, expectedRevision: number): PlaybackQueueSnapshot {
    this.assertRevision(expectedRevision);
    if (this.reservation?.queueEntryId === queueEntryId || this.reservation?.queueEntryId === beforeEntryId) {
      throw new AppError("QUEUE_ENTRY_RESERVED", "A transitioning queue entry cannot be moved.", 409);
    }
    const from = this.entries.findIndex((entry) => entry.queueEntryId === queueEntryId);
    if (from < 0 || this.entries[from].state !== "upcoming") {
      throw new AppError("QUEUE_ENTRY_NOT_FOUND", "That upcoming queue entry is unavailable.", 404);
    }
    const [entry] = this.entries.splice(from, 1);
    const currentIndex = this.entries.findIndex((candidate) => candidate.state === "current");
    const requested = beforeEntryId === null
      ? this.entries.length
      : this.entries.findIndex((candidate) => candidate.queueEntryId === beforeEntryId);
    if (requested < 0 || requested <= currentIndex) {
      this.entries.splice(from, 0, entry);
      throw new AppError("QUEUE_MOVE_INVALID", "Queue entries can only be reordered after the current item.", 422);
    }
    this.entries.splice(requested, 0, entry);
    return this.changed();
  }

  clearUpcoming(expectedRevision: number): PlaybackQueueSnapshot {
    this.assertRevision(expectedRevision);
    if (this.reservation) throw new AppError("QUEUE_CONTINUATION_BUSY", "A queue transition is pending.", 409);
    this.entries = this.entries.filter((entry) => entry.state !== "upcoming");
    return this.changed();
  }

  assertExpectedRevision(expectedRevision: number): void {
    this.assertRevision(expectedRevision);
  }

  private createEntry(item: MediaItem, state: PlaybackQueueEntryState): PlaybackQueueEntry {
    return { queueEntryId: randomUUID(), item: structuredClone(item), state, reserved: false };
  }

  private assertRevision(expectedRevision: number): void {
    if (expectedRevision !== this.revision) throw new AppError("QUEUE_REVISION_STALE", "The playback queue changed.", 409);
  }

  private changed(): PlaybackQueueSnapshot {
    this.revision += 1;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }
}
