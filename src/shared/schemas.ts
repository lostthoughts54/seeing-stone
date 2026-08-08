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

export const trailerOpenSchema = itemIdSchema.extend({ openExternally: z.boolean().optional() });

export const watchedStateSchema = itemIdSchema.extend({ watched: z.boolean() });

export const libraryItemsSchema = z.object({
  libraryId: z.string().min(1).max(128),
  type: z.enum(["Movie", "Series", "Mixed"]),
  limit: z.number().int().min(1).max(500),
});
export const browseSchema = z.object({
  libraryId: z.string().min(1).max(128).optional(),
  type: z.enum(["Movie", "Series", "Episode", "Mixed"]),
  genre: z.string().trim().min(1).max(256).optional(),
  personId: z.string().min(1).max(128).optional(),
  watched: z.boolean().optional(),
  sort: z.enum(["title-ascending", "title-descending", "date-added-descending", "release-date-descending", "release-date-ascending", "rating-descending"]),
  startIndex: z.number().int().min(0).max(100_000),
  limit: z.number().int().min(1).max(100),
}).strict();

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
  progressiveOnly: z.boolean().optional(),
});

const liveTvId = z.string().trim().min(1).max(128).regex(/^[^/?#\\\0]+$/);
const utcDate = z.string().datetime({ offset: true });
const liveTvDay = z.enum(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);
export const liveTvGuideSchema = z.object({
  startUtc: utcDate,
  endUtc: utcDate,
}).strict().superRefine((value, context) => {
  const start = Date.parse(value.startUtc);
  const end = Date.parse(value.endUtc);
  if (end <= start) context.addIssue({ code: z.ZodIssueCode.custom, message: "Guide end must be after start.", path: ["endUtc"] });
  if (end - start > 24 * 60 * 60 * 1000) context.addIssue({ code: z.ZodIssueCode.custom, message: "Guide windows cannot exceed 24 hours.", path: ["endUtc"] });
});
export const liveTvPageSchema = z.object({
  startIndex: z.number().int().min(0).max(100_000).optional(),
  limit: z.number().int().min(1).max(500).optional(),
}).strict();
export const liveTvScheduleOptionsSchema = z.object({
  recordNewOnly: z.boolean().optional(),
  recordAnyChannel: z.boolean().optional(),
  recordAnyTime: z.boolean().optional(),
  daysOfWeek: z.array(liveTvDay).max(7).optional(),
  prePaddingSeconds: z.number().int().min(0).max(24 * 60 * 60).optional(),
  postPaddingSeconds: z.number().int().min(0).max(24 * 60 * 60).optional(),
  keepUpTo: z.number().int().min(0).max(10_000).nullable().optional(),
}).strict();
export const liveTvCreateRecordingSchema = z.object({
  programId: liveTvId,
  series: z.boolean(),
  options: liveTvScheduleOptionsSchema.optional(),
}).strict();
export const liveTvUpdateScheduleSchema = z.object({
  id: liveTvId,
  series: z.boolean(),
  options: liveTvScheduleOptionsSchema,
}).strict();
export const liveTvCancelScheduleSchema = z.object({ id: liveTvId, series: z.boolean() }).strict();
export const liveTvDeleteRecordingSchema = z.object({ recordingId: liveTvId }).strict();
export const liveTvPlaybackSchema = z.object({ channelId: liveTvId }).strict();

export const playbackIdSchema = z.object({ playbackId: z.string().uuid() });

export const trickplaySpriteSchema = playbackIdSchema.extend({
  manifestId: z.string().uuid(),
  spriteIndex: z.number().int().min(0).max(10_000),
});

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
  deviceScaleFactor: z.number().finite().min(0.5).max(4).optional(),
});
export const playbackAdapterPreferenceSchema = z.object({ mode: z.enum(["legacy", "embedded", "libmpv"]) });

export const downloadStartSchema = z.object({ itemId: z.string().min(1).max(128) });

export const downloadIdSchema = z.object({ downloadId: z.string().uuid() });

export const downloadKeepSchema = downloadIdSchema.extend({ keepDownloaded: z.boolean() });

export const smartDownloadFollowSchema = z.object({
  seriesId: z.string().min(1).max(128),
  episodeLimit: z.number().int().min(1).max(5),
});

export const smartDownloadUnfollowSchema = z.object({
  seriesId: z.string().min(1).max(128),
  disposition: z.enum(["keep", "remove"]),
});

export const watchPartyCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
});

export const watchPartyGroupSchema = z.object({
  groupId: z.string().regex(/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i),
});

export const watchPartyVisibilitySchema = z.object({ visible: z.boolean() });

export const watchPartySyncOffsetSchema = z.object({
  offsetMilliseconds: z.number().int().min(-2000).max(2000).refine((value) => value % 100 === 0),
});

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
  type: z.enum(["Movie", "Series", "Season", "Episode", "BoxSet", "Video", "TvChannel", "Program"]),
  overview: z.string().max(32_768).refine((value) => !value.includes("\0")),
  productionYear: z.number().int().min(0).max(9999).nullable(),
  premiereYear: z.number().int().min(0).max(9999).nullable(),
  officialRating: cachedOptionalText(32),
  communityRating: z.number().finite().min(0).max(100).nullable(),
  runTimeTicks: cachedNonnegativeInteger,
  genres: z.array(z.string().trim().min(1).max(256).refine((value) => !value.includes("\0"))).max(32),
  people: z.array(z.object({
    id: cachedIdentity, name: z.string().trim().min(1).max(1024), role: z.string().max(256), type: z.string().max(64), primaryImageTag: cachedOptionalText(256),
  }).strict()).max(32).optional(),
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
  sourceKind: z.enum(["matched-local", "downloaded", "downloading", "direct-play", "direct-stream", "transcode", "offline-local"]).nullable(),
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
  videoOutput: z.enum(["d3d11", "opengl-software", "libmpv-opengl-angle"]).nullable().optional(),
  videoOutputHealthy: z.boolean().nullable().optional(),
  hardwareDecoding: z.boolean().nullable().optional(),
  directRendering: z.boolean().nullable().optional(),
  frameQueueDepth: z.number().int().min(0).max(16).nullable().optional(),
  droppedFrames: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  renderFallbackUsed: z.boolean().optional(),
}).strict();
