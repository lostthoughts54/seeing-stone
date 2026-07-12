import type { MediaItem } from "../../shared/contracts";

export interface CompletionCountdownOptions {
  isCurrent(): boolean;
  show(remainingSeconds: number): Promise<void>;
}

export class PlaybackCompletionCoordinator {
  constructor(
    private readonly countdownSeconds = 10,
    private readonly staleRetries = 3,
    private readonly wait: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  async findNextEpisode(
    currentItemId: string,
    query: () => Promise<MediaItem | null>,
    isCurrent: () => boolean,
  ): Promise<MediaItem | null> {
    for (let attempt = 0; attempt < this.staleRetries; attempt += 1) {
      if (!isCurrent()) return null;
      let item: MediaItem | null;
      try { item = await query(); } catch { return null; }
      if (!isCurrent() || !item) return null;
      if (item.id !== currentItemId) return item;
      if (attempt + 1 < this.staleRetries) await this.wait(250);
    }
    return null;
  }

  async countdown(options: CompletionCountdownOptions): Promise<boolean> {
    for (let remaining = this.countdownSeconds; remaining > 0; remaining -= 1) {
      if (!options.isCurrent()) return false;
      try { await options.show(remaining); } catch { return false; }
      await this.wait(1000);
    }
    return options.isCurrent();
  }
}
