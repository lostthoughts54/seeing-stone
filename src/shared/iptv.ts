import { z } from "zod";

// Independent from Jellyfin IDs, sessions and MediaItem. No resolved URL crosses this boundary.
export const IPTV_PAGE_SIZE = 50;
export const IPTV_CATALOGUE_PAGE_SIZES = [50, 100, 150, 200] as const;
export const IPTV_CATALOGUE_MAX_PAGE_SIZE = 200;
export const IPTV_SEARCH_DEBOUNCE_MS = 250;
/** Xtream providers sometimes put decorative section headings in their stream list. */
export const isIptvProviderHeading = (name: string): boolean => /^#{3,}.*#{3,}$/u.test(name.trim());
export const iptvProviderIdSchema = z.string().uuid();
const itemId = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/u);
const httpUrl = z.string().trim().max(8192).url().refine((value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash;
  } catch { return false; }
}, "Use an HTTP or HTTPS address without embedded user information or a fragment.");
const baseAddress = httpUrl.refine((value) => {
  try { return !new URL(value).search; } catch { return false; }
}, "Enter the provider base address without a query.");
const label = z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/u);

// Sensitive, one-way setup input. Never echo, log, or retain this object in renderer state.
export const iptvSetupSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("xtream"), name: label, address: baseAddress,
    username: z.string().min(1).max(256), password: z.string().min(1).max(4096),
    xmltvUrl: httpUrl.optional(),
  }).strict(),
  z.object({ kind: z.literal("m3u"), name: label, playlistUrl: httpUrl, xmltvUrl: httpUrl.optional() }).strict(),
]);
export type IptvSetup = z.infer<typeof iptvSetupSchema>;
export type IptvProviderKind = IptvSetup["kind"];
export interface IptvProviderSummary { providerId: string; kind: IptvProviderKind; name: string }

export const IPTV_IPC = {
  setup: "iptv:setup", list: "iptv:list", remove: "iptv:remove", refresh: "iptv:refresh",
  catalogue: "iptv:catalogue", groups: "iptv:groups", play: "iptv:play", schedule: "iptv:schedule", poster: "iptv:poster", favourite: "iptv:favourite",
} as const;
export const iptvProviderInputSchema = z.object({ providerId: iptvProviderIdSchema }).strict();
export const iptvGroupsSchema = z.object({ providerId: iptvProviderIdSchema, contentType: z.enum(["live", "movie", "series"]) }).strict();
export interface IptvGroup { id: string; name: string; count: number }
export interface IptvAccountTestStatus {
  provider: IptvProviderSummary;
  phase: "saved" | "connecting" | "importing" | "ready" | "failed";
  message: string;
  imported: number;
  lastSuccessfulAt: string | null;
  counts: { live: number; movie: number; series: number };
}
/** Available account/catalogue testing slice. Additional bridge methods land with their services. */
export interface IptvAccountBridge {
  favourite(input: z.input<typeof iptvFavouriteSchema>): Promise<void>;
  poster(input: z.input<typeof iptvPosterSchema>): Promise<string | null>;
  play(input: z.input<typeof iptvPlaybackSchema>): Promise<import("./contracts").PlaybackStartResult>;
  schedule(input: { providerId: string; channelId: string }): Promise<IptvChannelSchedule>;
  setup(input: IptvSetup): Promise<IptvProviderSummary>;
  list(): Promise<IptvAccountTestStatus[]>;
  remove(input: { providerId: string }): Promise<void>;
  refresh(input: { providerId: string }): Promise<void>;
  catalogue(input: z.input<typeof iptvCatalogueSchema>): Promise<IptvPage<IptvCatalogueItem>>;
  groups(input: z.input<typeof iptvGroupsSchema>): Promise<IptvGroup[]>;
}

export const iptvIdentitySchema = z.object({
  providerId: iptvProviderIdSchema, contentType: z.enum(["live", "movie", "series", "episode"]), itemId,
}).strict();
export const iptvPosterSchema = iptvIdentitySchema.extend({ contentType: z.enum(["movie", "series"]) });
export const iptvFavouriteSchema = z.object({ providerId: iptvProviderIdSchema, channelId: itemId, favourite: z.boolean() }).strict();
export type IptvIdentity = z.infer<typeof iptvIdentitySchema>;
export type IptvPlayableIdentity = IptvIdentity & { contentType: "live" | "movie" | "episode" };
const page = { cursor: z.string().min(1).max(8192).optional(), limit: z.number().int().min(1).max(IPTV_PAGE_SIZE).default(IPTV_PAGE_SIZE) };
const filters = { groupId: itemId.optional(), favouritesOnly: z.boolean().default(false), includeHidden: z.boolean().default(false) };
export const iptvCatalogueSchema = z.object({
  providerId: iptvProviderIdSchema, contentType: z.enum(["live", "movie", "series"]),
  query: z.string().trim().min(1).max(256).optional(), ...filters, ...page,
  limit: z.number().int().min(1).max(IPTV_CATALOGUE_MAX_PAGE_SIZE).default(IPTV_PAGE_SIZE),
  programmeWindow: z.object({ startUtc: z.string().datetime(), endUtc: z.string().datetime() }).strict().refine(window => {
    const duration = Date.parse(window.endUtc) - Date.parse(window.startUtc); return duration > 0 && duration <= 86400000;
  }).optional(),
}).strict();
export const iptvGuideSearchSchema = z.object({
  providerId: iptvProviderIdSchema, query: z.string().trim().min(1).max(256),
  resultType: z.enum(["channels", "programmes"]), ...filters, ...page,
}).strict();
export const iptvGuideWindowSchema = z.object({
  providerId: iptvProviderIdSchema, channelIds: z.array(itemId).min(1).max(IPTV_PAGE_SIZE),
  startUtc: z.string().datetime({ offset: true }), endUtc: z.string().datetime({ offset: true }),
}).strict().refine((value) => {
  const duration = Date.parse(value.endUtc) - Date.parse(value.startUtc);
  return duration > 0 && duration <= 24 * 60 * 60 * 1000;
}, "Request a positive guide window no longer than 24 hours.");
export const iptvPlaybackSchema = z.object({
  identity: iptvIdentitySchema.extend({ contentType: z.enum(["live", "movie", "episode"]) }),
  resumeMode: z.enum(["resume", "start-over"]),
}).strict();
export const iptvChannelPreferencesSchema = z.object({
  providerId: iptvProviderIdSchema, channelId: itemId,
  favourite: z.boolean().optional(), hidden: z.boolean().optional(),
  // null resets to provider matching; an explicit ID is retained across guide refreshes.
  xmltvChannelId: itemId.nullable().optional(),
}).strict().refine((value) => value.favourite !== undefined || value.hidden !== undefined || value.xmltvChannelId !== undefined);
export const iptvGroupPreferencesSchema = z.object({ providerId: iptvProviderIdSchema, groupId: itemId, hidden: z.boolean() }).strict();

export interface IptvPage<T> { items: T[]; nextCursor: string | null; snapshotId: string }
export interface IptvRefreshStatus {
  phase: "never" | "refreshing" | "ready" | "failed";
  lastSuccessfulAt: string | null;
  errorCode: "authentication" | "network" | "invalid-feed" | "storage" | null;
}
export interface IptvProviderStatus {
  provider: IptvProviderSummary;
  authentication: "unchecked" | "valid" | "expired" | "unavailable";
  capabilities: { live: boolean; movies: boolean; series: boolean };
  catalogue: IptvRefreshStatus;
  guide: IptvRefreshStatus & { coverageStartUtc: string | null; coverageEndUtc: string | null };
}
export interface IptvCatalogueItem {
  identity: IptvIdentity; name: string; groupId: string | null; groupName: string | null;
  channelNumber: string | null; favourite: boolean; hidden: boolean;
}
export interface IptvProgramme {
  programmeId: string; channel: IptvCatalogueItem;
  title: string; episodeTitle: string | null; description: string; genres: string[];
  startUtc: string; endUtc: string;
}
export const iptvScheduleSchema = z.object({ providerId: iptvProviderIdSchema, channelId: itemId }).strict();
export interface IptvChannelSchedule {
  programmes: Array<{ id: string; title: string; description: string; startUtc: string; endUtc: string }>;
  fetchedAt: string;
  stale: boolean;
}
export interface IptvGuideWindow {
  snapshotId: string; startUtc: string; endUtc: string;
  channels: IptvCatalogueItem[]; programmes: IptvProgramme[];
}
export interface IptvDetails {
  item: IptvCatalogueItem; description: string; genres: string[]; durationTicks: number | null;
  seasons: Array<{ seasonId: string; number: number; name: string }>;
}
export interface IptvProgress {
  identity: IptvIdentity & { contentType: "movie" | "episode" };
  positionTicks: number; durationTicks: number; completed: boolean; updatedAt: string;
}

// Contract for a later renderer bridge. It is deliberately not registered in preload yet.
export interface IptvBridge {
  setup(input: IptvSetup): Promise<IptvProviderSummary>;
  listProviders(): Promise<IptvProviderStatus[]>;
  removeProvider(input: { providerId: string }): Promise<void>;
  refresh(input: { providerId: string; scope: "catalogue" | "guide" | "all" }): Promise<void>;
  getCatalogue(input: z.input<typeof iptvCatalogueSchema>): Promise<IptvPage<IptvCatalogueItem>>;
  getDetails(input: IptvIdentity): Promise<IptvDetails>;
  getEpisodes(input: { identity: IptvIdentity & { contentType: "series" }; seasonId: string; cursor?: string }): Promise<IptvPage<IptvCatalogueItem>>;
  getGuide(input: z.input<typeof iptvGuideWindowSchema>): Promise<IptvGuideWindow>;
  searchChannels(input: Omit<z.input<typeof iptvGuideSearchSchema>, "resultType">): Promise<IptvPage<IptvCatalogueItem>>;
  searchProgrammes(input: Omit<z.input<typeof iptvGuideSearchSchema>, "resultType">): Promise<IptvPage<IptvProgramme>>;
  setChannelPreferences(input: z.input<typeof iptvChannelPreferencesSchema>): Promise<void>;
  setGroupPreferences(input: z.input<typeof iptvGroupPreferencesSchema>): Promise<void>;
  play(input: z.input<typeof iptvPlaybackSchema>): Promise<import("./contracts").PlaybackStartResult>;
}
