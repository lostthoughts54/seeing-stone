import type { CompanionLiveContext } from "../../shared/companionContracts";
import type { LiveTvGuide } from "../../shared/contracts";

interface LiveTvApi {
  getLiveTvGuide(startUtc: string, endUtc: string): Promise<LiveTvGuide>;
}

export class LiveTvContextService {
  private cachedGuide: { expiresAt: number; value: LiveTvGuide } | null = null;

  constructor(private readonly api: LiveTvApi) {}

  async getGuide(): Promise<LiveTvGuide> {
    return this.guide(Date.now());
  }

  async getContext(channelId: string): Promise<CompanionLiveContext | null> {
    const now = Date.now();
    const guide = await this.guide(now);
    const channel = guide.channels.find((candidate) => candidate.id === channelId);
    if (!channel) return null;
    const program = guide.programs.find((candidate) => candidate.channelId === channelId
      && Date.parse(candidate.startUtc) <= now && Date.parse(candidate.endUtc) > now);
    return Object.freeze({
      channelName: channel.name,
      channelNumber: channel.number,
      programName: program?.name ?? null,
      episodeTitle: null,
      programStartUtc: program?.startUtc ?? null,
      programEndUtc: program?.endUtc ?? null,
    });
  }

  async getNeighbor(channelId: string, direction: -1 | 1): Promise<string | null> {
    const guide = await this.guide(Date.now());
    const channels = [...guide.channels].sort((left, right) =>
      (left.number ?? left.name).localeCompare(right.number ?? right.name, undefined, { numeric: true }));
    const index = channels.findIndex((channel) => channel.id === channelId);
    if (index < 0 || !channels.length) return null;
    return channels[(index + direction + channels.length) % channels.length]?.id ?? null;
  }

  clear(): void {
    this.cachedGuide = null;
  }

  private async guide(now: number): Promise<LiveTvGuide> {
    if (this.cachedGuide && this.cachedGuide.expiresAt > now) return this.cachedGuide.value;
    const value = await this.api.getLiveTvGuide(
      new Date(now - 60 * 60_000).toISOString(),
      new Date(now + 6 * 60 * 60_000).toISOString(),
    );
    this.cachedGuide = { expiresAt: now + 30_000, value };
    return value;
  }
}
