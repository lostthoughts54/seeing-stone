import type { LiveTvChannel, LiveTvProgram, LiveTvProgramSearchResult } from "./contracts";

type SubjectIntent = {
  terms: string[];
  channelSignals?: string[];
  programFlag?: keyof Pick<LiveTvProgram, "isSports" | "isNews" | "isMovie">;
};

type IndexedChannel = { channel: LiveTvChannel; identity: string; categories: string };
type IndexedProgram = {
  program: LiveTvProgram;
  channel: LiveTvChannel;
  name: string;
  episodeTitle: string;
  title: string;
  genres: string;
  overview: string;
  channelText: string;
  categories: string;
};
type PreparedLiveTvIndex = { channels: IndexedChannel[]; programs: IndexedProgram[] };
const preparedIndexes = new WeakMap<LiveTvChannel[], WeakMap<LiveTvProgram[], PreparedLiveTvIndex>>();

const SUBJECT_INTENTS: Record<string, SubjectIntent> = {
  sports: { terms: ["sports", "sport", "athletics"], channelSignals: ["espn", "fs1", "fs2", "sports network", "nfl network", "nba tv", "nhl network", "mlb network", "sec network", "acc network", "big ten network"], programFlag: "isSports" },
  football: { terms: ["football", "college football", "ncaa football", "nfl", "gridiron"], channelSignals: ["nfl network", "sec network", "acc network", "big ten network"], programFlag: "isSports" },
  "college football": { terms: ["college football", "ncaa football", "college gridiron", "sec football", "acc football", "big ten football", "big 12 football"], channelSignals: ["sec network", "acc network", "big ten network"], programFlag: "isSports" },
  basketball: { terms: ["basketball", "nba", "wnba", "ncaa basketball", "college basketball"], channelSignals: ["nba tv"], programFlag: "isSports" },
  baseball: { terms: ["baseball", "mlb", "college baseball"], channelSignals: ["mlb network"], programFlag: "isSports" },
  hockey: { terms: ["hockey", "nhl", "ice hockey"], channelSignals: ["nhl network"], programFlag: "isSports" },
  soccer: { terms: ["soccer", "football club", "fifa", "mls", "premier league", "uefa"], programFlag: "isSports" },
  boxing: { terms: ["boxing", "boxer", "fight", "combat sports"], programFlag: "isSports" },
  mma: { terms: ["mma", "mixed martial arts", "ufc", "combat sports"], programFlag: "isSports" },
  "combat sports": { terms: ["combat sports", "boxing", "mma", "mixed martial arts", "ufc", "wrestling"], programFlag: "isSports" },
  news: { terms: ["news", "current affairs", "breaking news", "newscast"], channelSignals: ["news network"], programFlag: "isNews" },
  science: { terms: ["science", "scientific", "technology", "astronomy", "physics", "biology"], channelSignals: ["discovery science", "smithsonian", "national geographic", "nat geo"] },
  documentary: { terms: ["documentary", "documentaries", "factual", "nonfiction"], channelSignals: ["smithsonian", "national geographic", "nat geo", "discovery"] },
  history: { terms: ["history", "historical", "archaeology", "ancient"], channelSignals: ["history channel", "smithsonian"] },
  nature: { terms: ["nature", "wildlife", "natural world", "animals", "earth"], channelSignals: ["animal planet", "national geographic", "nat geo", "smithsonian"] },
  space: { terms: ["space", "astronomy", "cosmos", "nasa", "universe", "planetary"], channelSignals: ["discovery science", "smithsonian", "national geographic", "nat geo"] },
  movies: { terms: ["movie", "movies", "film", "cinema", "feature film"], programFlag: "isMovie" },
};

export function normalizeLiveTvSearchText(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function includesPhrase(haystack: string, phrase: string): boolean {
  return haystack.includes(normalizeLiveTvSearchText(phrase));
}

function literalScore(query: string, text: string, exactScore: number, containsScore: number): number {
  if (!query || !text) return 0;
  if (text === query) return exactScore;
  if (text.includes(query)) return containsScore;
  const terms = query.split(" ");
  return terms.every((term) => text.includes(term)) ? Math.max(1, containsScore - 90) : 0;
}

function intentFor(query: string): SubjectIntent | null {
  if (SUBJECT_INTENTS[query]) return SUBJECT_INTENTS[query];
  return Object.values(SUBJECT_INTENTS).find((intent) => intent.terms.some((term) => normalizeLiveTvSearchText(term) === query)) ?? null;
}

function prepareLiveTvIndex(channels: LiveTvChannel[], programs: LiveTvProgram[]): PreparedLiveTvIndex {
  let byPrograms = preparedIndexes.get(channels);
  if (!byPrograms) {
    byPrograms = new WeakMap<LiveTvProgram[], PreparedLiveTvIndex>();
    preparedIndexes.set(channels, byPrograms);
  }
  const cached = byPrograms.get(programs);
  if (cached) return cached;
  const indexedChannels = channels.map((channel) => ({
    channel,
    identity: normalizeLiveTvSearchText(`${channel.number ?? ""} ${channel.name}`),
    categories: normalizeLiveTvSearchText((channel.categories ?? []).join(" ")),
  }));
  const channelsById = new Map(indexedChannels.map((entry) => [entry.channel.id, entry]));
  const indexedPrograms = programs.flatMap((program) => {
    const channel = channelsById.get(program.channelId);
    if (!channel) return [];
    return [{
      program,
      channel: channel.channel,
      name: normalizeLiveTvSearchText(program.name),
      episodeTitle: normalizeLiveTvSearchText(program.episodeTitle ?? ""),
      title: normalizeLiveTvSearchText(`${program.name} ${program.episodeTitle ?? ""}`),
      genres: normalizeLiveTvSearchText((program.genres ?? []).join(" ")),
      overview: normalizeLiveTvSearchText(program.overview),
      channelText: channel.identity,
      categories: channel.categories,
    }];
  });
  const prepared = { channels: indexedChannels, programs: indexedPrograms };
  byPrograms.set(programs, prepared);
  return prepared;
}

function programScore(indexed: IndexedProgram, query: string, intent: SubjectIntent | null, now: number): number {
  const { program, channel, name, episodeTitle, title, genres, categories, overview, channelText } = indexed;
  let score = Math.max(literalScore(query, name, 930, 850), literalScore(query, episodeTitle, 900, 820));
  score = Math.max(score, literalScore(query, channelText, 820, 720));
  score = Math.max(score, literalScore(query, genres, 760, 690));
  if (intent) {
    if (intent.programFlag && program[intent.programFlag]) score = Math.max(score, 920);
    if (intent.terms.some((term) => includesPhrase(title, term))) score = Math.max(score, 880);
    if (intent.terms.some((term) => includesPhrase(genres, term) || includesPhrase(categories, term))) score = Math.max(score, 740);
    if (intent.channelSignals?.some((term) => includesPhrase(channelText, term))) score = Math.max(score, 620);
    if (intent.terms.some((term) => includesPhrase(overview, term))) score = Math.max(score, 280);
  } else {
    score = Math.max(score, literalScore(query, overview, 260, 190));
  }
  if (!score) return 0;
  const start = Date.parse(program.startUtc);
  const end = Date.parse(program.endUtc);
  if (channel.currentProgramId === program.id || (start <= now && end > now)) score += 240;
  return score;
}

export function searchLiveTvGuide(query: string, channels: LiveTvChannel[], programs: LiveTvProgram[]): { channels: LiveTvChannel[]; programs: LiveTvProgramSearchResult[] } {
  const normalized = normalizeLiveTvSearchText(query);
  if (!normalized) return { channels: [], programs: [] };
  const intent = intentFor(normalized);
  const now = Date.now();
  const index = prepareLiveTvIndex(channels, programs);
  const scoredPrograms = index.programs.flatMap((indexed) => {
    const { program, channel } = indexed;
    const score = programScore(indexed, normalized, intent, now);
    return score ? [{ entry: { program, channel } satisfies LiveTvProgramSearchResult, score }] : [];
  }).sort((left, right) => right.score - left.score || Date.parse(left.entry.program.startUtc) - Date.parse(right.entry.program.startUtc));
  const associatedScores = new Map<string, number>();
  for (const match of scoredPrograms) associatedScores.set(match.entry.channel.id, Math.max(associatedScores.get(match.entry.channel.id) ?? 0, match.score - 120));
  const channelMatches = index.channels.flatMap(({ channel, identity, categories }) => {
    let score = literalScore(normalized, identity, 900, 800);
    score = Math.max(score, literalScore(normalized, categories, 720, 650));
    if (intent) {
      if (intent.terms.some((term) => includesPhrase(categories, term))) score = Math.max(score, 700);
      if (intent.channelSignals?.some((term) => includesPhrase(identity, term))) score = Math.max(score, 640);
    }
    score = Math.max(score, associatedScores.get(channel.id) ?? 0);
    return score ? [{ channel, score }] : [];
  }).sort((left, right) => right.score - left.score || (left.channel.number ?? left.channel.name).localeCompare(right.channel.number ?? right.channel.name, undefined, { numeric: true }));
  return { channels: channelMatches.map(({ channel }) => channel), programs: scoredPrograms.map(({ entry }) => entry) };
}
