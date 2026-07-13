import type { MediaItem } from "../../shared/contracts";
import type { AuthenticatedContext } from "./jellyfinApi";
import type { AppLogger } from "./logger";
import type { SqlitePersistenceService } from "./persistence";
import type {
  PlaybackActionKind,
  PlaybackRevisionRecord,
  RecordPlaybackRevisionInput,
} from "./persistenceTypes";

interface OfflineSyncApi {
  getAuthenticatedContext(): AuthenticatedContext;
  getDetails(itemId: string): Promise<MediaItem>;
  synchronizeOfflinePlayback(input: {
    itemId: string;
    actionKind: PlaybackActionKind;
    positionTicks: number;
    watched: boolean;
  }): Promise<void>;
}

type OfflineSyncPersistence = Pick<SqlitePersistenceService,
  | "recordPlaybackRevision"
  | "getPlaybackHead"
  | "listPendingProgress"
  | "markProgressSucceeded"
  | "markProgressFailed"
  | "markPlaybackSuperseded"
>;

export interface PlaybackCoalescingPlan {
  selected: PlaybackRevisionRecord[];
  superseded: PlaybackRevisionRecord[];
}

function identityKey(serverId: string, userId: string, itemId: string): string {
  return `${serverId}\u0000${userId}\u0000${itemId}`;
}

function safeFailureCode(error: unknown): string {
  const value = String((error as { code?: unknown })?.code ?? "");
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : "PLAYBACK_SYNC_FAILED";
}

export function coalescePlaybackRevisions(revisions: PlaybackRevisionRecord[]): PlaybackCoalescingPlan {
  const ordered = [...revisions].sort((left, right) => left.localRevision - right.localRevision);
  const barriers = ordered.filter((revision) => revision.actionKind !== "progress");
  const lastBarrier = barriers.at(-1)?.localRevision ?? 0;
  const newestProgress = ordered
    .filter((revision) => revision.actionKind === "progress" && revision.localRevision > lastBarrier)
    .at(-1);
  const selectedRevisions = new Set([
    ...barriers.map((revision) => revision.localRevision),
    ...(newestProgress ? [newestProgress.localRevision] : []),
  ]);
  return {
    selected: ordered.filter((revision) => selectedRevisions.has(revision.localRevision)),
    superseded: ordered.filter((revision) => !selectedRevisions.has(revision.localRevision)),
  };
}

/**
 * Main-only durable progress queue. SQLite work remains in its worker and all
 * Jellyfin work is asynchronous; no renderer-controlled report enters here.
 */
export class OfflineSynchronizationService {
  private enabled = false;
  private sessionRevision = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private readonly activeItems = new Set<string>();

  constructor(
    private readonly api: OfflineSyncApi,
    private readonly persistence: OfflineSyncPersistence,
    private readonly logger: AppLogger,
    private readonly intervalMilliseconds = 30_000,
  ) {}

  activate(): void {
    this.enabled = true;
    this.sessionRevision += 1;
    if (!this.timer) {
      this.timer = setInterval(() => { void this.syncNow(); }, this.intervalMilliseconds);
      this.timer.unref?.();
    }
    void this.syncNow();
  }

  deactivate(): void {
    this.enabled = false;
    this.sessionRevision += 1;
    this.activeItems.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async shutdown(): Promise<void> {
    this.deactivate();
    await this.running?.catch(() => undefined);
  }

  async capture(input: Omit<RecordPlaybackRevisionInput, "serverId" | "userId" | "occurredAt">): Promise<PlaybackRevisionRecord> {
    const identity = this.api.getAuthenticatedContext();
    return this.persistence.recordPlaybackRevision({
      ...input,
      serverId: identity.serverId,
      userId: identity.userId,
      occurredAt: Date.now(),
    });
  }

  setActive(revision: PlaybackRevisionRecord, active: boolean): void {
    const key = identityKey(revision.serverId, revision.userId, revision.itemId);
    if (active) this.activeItems.add(key);
    else this.activeItems.delete(key);
    if (!active) void this.syncNow();
  }

  async markCaptureFailed(revision: PlaybackRevisionRecord, error: unknown): Promise<void> {
    await this.persistence.markProgressFailed(
      revision.serverId,
      revision.userId,
      revision.itemId,
      revision.localRevision,
      safeFailureCode(error),
    ).catch(() => undefined);
  }

  syncNow(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.running) return this.running;
    const revision = this.sessionRevision;
    const run = this.synchronize(revision).finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  private async synchronize(revision: number): Promise<void> {
    let identity: AuthenticatedContext;
    try {
      identity = this.api.getAuthenticatedContext();
    } catch {
      return;
    }
    const pending = (await this.persistence.listPendingProgress(1000))
      .filter((entry) => entry.serverId === identity.serverId && entry.userId === identity.userId);
    const groups = new Map<string, PlaybackRevisionRecord[]>();
    for (const entry of pending) {
      const key = identityKey(entry.serverId, entry.userId, entry.itemId);
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }

    for (const [key, entries] of groups) {
      if (!this.isCurrent(revision) || this.activeItems.has(key)) continue;
      const plan = coalescePlaybackRevisions(entries);
      for (const stale of plan.superseded) {
        if (!this.isCurrent(revision)) return;
        await this.persistence.markPlaybackSuperseded(
          stale.serverId,
          stale.userId,
          stale.itemId,
          stale.localRevision,
        ).catch(() => undefined);
      }
      for (const entry of plan.selected) {
        if (!this.isCurrent(revision)) return;
        const succeeded = await this.synchronizeRevision(entry, revision);
        if (!succeeded) break;
      }
    }
  }

  private async synchronizeRevision(entry: PlaybackRevisionRecord, sessionRevision: number): Promise<boolean> {
    const head = await this.persistence.getPlaybackHead(entry.serverId, entry.userId, entry.itemId);
    if (!head || !this.isCurrent(sessionRevision)) return false;
    if (entry.localRevision <= head.lastSucceededRevision) {
      await this.persistence.markPlaybackSuperseded(
        entry.serverId,
        entry.userId,
        entry.itemId,
        entry.localRevision,
      ).catch(() => undefined);
      return true;
    }

    if (entry.actionKind === "progress") {
      if (entry.positionTicks < head.lastSucceededPositionTicks
        || (head.lastSucceededWatched && !entry.watched)) {
        await this.persistence.markPlaybackSuperseded(
          entry.serverId,
          entry.userId,
          entry.itemId,
          entry.localRevision,
        ).catch(() => undefined);
        return true;
      }
      try {
        const remote = await this.api.getDetails(entry.itemId);
        if ((remote.userData.played && !entry.watched)
          || remote.userData.playbackPositionTicks > entry.positionTicks) {
          await this.persistence.markPlaybackSuperseded(
            entry.serverId,
            entry.userId,
            entry.itemId,
            entry.localRevision,
          ).catch(() => undefined);
          return true;
        }
      } catch (error) {
        await this.fail(entry, error);
        return false;
      }
    }

    try {
      await this.api.synchronizeOfflinePlayback({
        itemId: entry.itemId,
        actionKind: entry.actionKind,
        positionTicks: entry.positionTicks,
        watched: entry.watched,
      });
      if (!this.isCurrent(sessionRevision)) return false;
      await this.persistence.markProgressSucceeded(
        entry.serverId,
        entry.userId,
        entry.itemId,
        entry.localRevision,
      );
      return true;
    } catch (error) {
      await this.fail(entry, error);
      return false;
    }
  }

  private async fail(entry: PlaybackRevisionRecord, error: unknown): Promise<void> {
    await this.persistence.markProgressFailed(
      entry.serverId,
      entry.userId,
      entry.itemId,
      entry.localRevision,
      safeFailureCode(error),
    ).catch(() => undefined);
    this.logger.warn("Offline playback synchronization was deferred.", {
      actionKind: entry.actionKind,
      error: safeFailureCode(error),
    });
  }

  private isCurrent(revision: number): boolean {
    return this.enabled && this.sessionRevision === revision;
  }
}
