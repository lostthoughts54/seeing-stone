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

export const playbackTrackSchema = playbackIdSchema.extend({
  trackId: z.number().int().min(1).max(65535).nullable(),
});

export const playbackFullscreenSchema = playbackIdSchema.extend({ fullscreen: z.boolean() });

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
