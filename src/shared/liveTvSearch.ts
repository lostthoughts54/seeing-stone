import type { LiveTvChannel, LiveTvProgram, LiveTvProgramSearchResult } from "./contracts";

export function searchLiveTvGuide(query: string, channels: LiveTvChannel[], programs: LiveTvProgram[]): { channels: LiveTvChannel[]; programs: LiveTvProgramSearchResult[] } {
  const normalized = query.normalize("NFC").trim().toLocaleLowerCase();
  const channelMatches = channels.filter((channel) => `${channel.number || ""} ${channel.name}`.toLocaleLowerCase().includes(normalized));
  const channelsById = new Map(channels.map((channel) => [channel.id, channel]));
  const programMatches = programs
    .filter((program) => [program.name, program.episodeTitle || "", program.overview]
      .some((value) => value.toLocaleLowerCase().includes(normalized)))
    .map((program) => ({ program, channel: channelsById.get(program.channelId) }))
    .filter((entry): entry is LiveTvProgramSearchResult => Boolean(entry.channel))
    .sort((left, right) => Date.parse(left.program.startUtc) - Date.parse(right.program.startUtc));
  return { channels: channelMatches, programs: programMatches };
}
