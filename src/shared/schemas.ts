import { z } from "zod";

export const emptySchema = z.object({});

export const serverUrlSchema = z.object({ url: z.string().trim().url().max(2048) });

export const loginSchema = z.object({
  connectionId: z.string().uuid(),
  username: z.string().trim().min(1).max(256),
  password: z.string().max(4096),
  remember: z.boolean(),
});

export const itemIdSchema = z.object({ itemId: z.string().min(1).max(128) });

export const watchedStateSchema = itemIdSchema.extend({ watched: z.boolean() });

export const libraryItemsSchema = z.object({
  type: z.enum(["Movie", "Series"]),
  limit: z.number().int().min(1).max(500),
});

export const searchSchema = z.object({ query: z.string().trim().min(1).max(256) });

export const episodesSchema = z.object({
  seriesId: z.string().min(1).max(128),
  seasonId: z.string().min(1).max(128),
});

export const artworkSchema = z.object({
  itemId: z.string().min(1).max(128),
  kind: z.enum(["Primary", "Backdrop", "Thumb"]),
  tag: z.string().min(1).max(256).optional(),
  width: z.number().int().min(32).max(2400).optional(),
  height: z.number().int().min(32).max(2400).optional(),
});

export const playbackStartSchema = z.object({
  itemId: z.string().min(1).max(128),
  resumeMode: z.enum(["resume", "start-over"]),
});

export const playbackIdSchema = z.object({ playbackId: z.string().uuid() });

export const playbackPauseSchema = playbackIdSchema.extend({ paused: z.boolean() });

export const playbackSeekSchema = playbackIdSchema.extend({
  positionTicks: z.number().int().min(0).max(864000000000),
});

export const playbackRateSchema = playbackIdSchema.extend({
  rate: z.number().finite().min(0.25).max(4),
});

export const playbackVolumeSchema = playbackIdSchema.extend({
  volume: z.number().finite().min(0).max(100),
});

export const playbackTrackSchema = playbackIdSchema.extend({
  trackId: z.number().int().min(1).max(65535).nullable(),
});

export const playbackFullscreenSchema = playbackIdSchema.extend({ fullscreen: z.boolean() });
export const playbackViewportSchema = z.object({
  x: z.number().finite().min(-10000).max(10000), y: z.number().finite().min(-10000).max(10000),
  width: z.number().finite().min(0).max(10000), height: z.number().finite().min(0).max(10000), visible: z.boolean(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export const playbackAdapterPreferenceSchema = z.object({ mode: z.enum(["legacy", "embedded"]) });

export const downloadStartSchema = z.object({ itemId: z.string().min(1).max(128) });

export const downloadIdSchema = z.object({ downloadId: z.string().uuid() });

export const downloadKeepSchema = downloadIdSchema.extend({ keepDownloaded: z.boolean() });

export const watchPartyCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
});

export const watchPartyGroupSchema = z.object({
  groupId: z.string().regex(/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i),
});

export const watchPartyVisibilitySchema = z.object({ visible: z.boolean() });

export const bufferingPolicyPreferenceSchema = z.object({
  mode: z.enum(["wait-for-all", "continue"]),
});

const cachedIdentity = z.string().trim().min(1).max(256).refine((value) => !value.includes("\0"));
const cachedOptionalText = (maximum: number) => z.string().max(maximum).refine((value) => !value.includes("\0")).nullable();
const cachedNonnegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * Strict, path-free representation of already-sanitized Jellyfin metadata.
 * This is intentionally separate from the raw Jellyfin response sanitizer so
 * persistence never stores unknown server fields, stream URLs, or credentials.
 */
export const cachedMediaItemSchema = z.object({
  id: cachedIdentity,
  name: z.string().trim().min(1).max(1024).refine((value) => !value.includes("\0")),
  type: z.enum(["Movie", "Series", "Season", "Episode", "BoxSet", "Video"]),
  overview: z.string().max(32_768).refine((value) => !value.includes("\0")),
  productionYear: z.number().int().min(0).max(9999).nullable(),
  premiereYear: z.number().int().min(0).max(9999).nullable(),
  officialRating: cachedOptionalText(32),
  communityRating: z.number().finite().min(0).max(100).nullable(),
  runTimeTicks: cachedNonnegativeInteger,
  genres: z.array(z.string().trim().min(1).max(256).refine((value) => !value.includes("\0"))).max(32),
  primaryImageAspectRatio: z.number().finite().positive().max(100).nullable(),
  imageTags: z.object({
    Primary: z.string().min(1).max(256).optional(),
    Backdrop: z.string().min(1).max(256).optional(),
    Thumb: z.string().min(1).max(256).optional(),
  }).strict(),
  backdropImageTag: cachedOptionalText(256),
  parentThumbItemId: cachedOptionalText(256),
  parentThumbImageTag: cachedOptionalText(256),
  seriesId: cachedOptionalText(256),
  seriesName: cachedOptionalText(1024),
  seasonId: cachedOptionalText(256),
  indexNumber: z.number().int().min(0).max(100_000).nullable(),
  parentIndexNumber: z.number().int().min(0).max(100_000).nullable(),
  userData: z.object({
    played: z.boolean(),
    playbackPositionTicks: cachedNonnegativeInteger,
    playedPercentage: z.number().finite().min(0).max(100),
  }).strict(),
  hasTrailer: z.boolean(),
  playable: z.boolean(),
}).strict();

export const cachedPlaybackDiagnosticsSchema = z.object({
  sourceKind: z.enum(["matched-local", "downloaded", "direct-play", "direct-stream", "transcode", "offline-local"]).nullable(),
  playbackRate: z.number().finite().min(0.25).max(4),
  bufferAheadTicks: cachedNonnegativeInteger.nullable(),
  container: cachedOptionalText(64),
  videoCodec: cachedOptionalText(64),
  audioCodec: cachedOptionalText(64),
  audioChannels: cachedOptionalText(64),
  resolution: cachedOptionalText(64),
  bitrate: cachedNonnegativeInteger.nullable(),
  videoRange: cachedOptionalText(64),
  transcodeReason: cachedOptionalText(1024),
}).strict();
