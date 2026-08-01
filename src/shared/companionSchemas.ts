import { z } from "zod";

const safeText = (maximum: number) => z.string().max(maximum).refine((value) => !/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value));
const opaqueRef = z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/);
const ticks = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const companionMediaSummarySchema = z.object({
  itemRef: opaqueRef,
  name: safeText(1024),
  type: z.enum(["movie", "series", "season", "episode", "video", "channel", "program"]),
  seriesName: safeText(1024).nullable(),
  seasonNumber: z.number().int().min(0).max(10000).nullable(),
  episodeNumber: z.number().int().min(0).max(100000).nullable(),
  productionYear: z.number().int().min(0).max(9999).nullable(),
  runtimeTicks: ticks,
  playable: z.boolean(),
  artworkRef: opaqueRef.nullable(),
}).strict();

export const companionTrackSchema = z.object({
  id: z.number().int().min(0).max(100000),
  type: z.enum(["audio", "subtitle"]),
  label: safeText(256),
  language: safeText(32).nullable(),
  selected: z.boolean(),
}).strict();

export const companionPlayerStateSchema = z.object({
  protocolVersion: z.literal(1),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sentAtUnixMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  playbackId: z.string().uuid().nullable(),
  phase: z.enum(["idle", "loading", "playing", "paused", "buffering", "stopped", "ended", "error"]),
  media: companionMediaSummarySchema.nullable(),
  live: z.object({
    channelName: safeText(1024),
    channelNumber: safeText(64).nullable(),
    programName: safeText(1024).nullable(),
    episodeTitle: safeText(1024).nullable(),
    programStartUtc: z.string().datetime().nullable(),
    programEndUtc: z.string().datetime().nullable(),
  }).strict().nullable(),
  positionTicks: ticks,
  durationTicks: ticks,
  playbackRate: z.number().finite().min(0.25).max(4),
  paused: z.boolean(),
  buffering: z.boolean(),
  seekable: z.boolean(),
  volume: z.number().int().min(0).max(100),
  muted: z.boolean(),
  audioTracks: z.array(companionTrackSchema).max(128),
  subtitleTracks: z.array(companionTrackSchema).max(128),
  controls: z.object({
    canPlayPause: z.boolean(),
    canStop: z.boolean(),
    canSeek: z.boolean(),
    canPrevious: z.boolean(),
    canNext: z.boolean(),
    canGoLive: z.boolean(),
    canPreviousChannel: z.boolean(),
    canNextChannel: z.boolean(),
  }).strict(),
}).strict();

export const companionQueueStateSchema = z.object({
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  editable: z.boolean(),
  blockedReason: z.literal("watchparty").nullable(),
  entries: z.array(z.object({
    queueEntryId: z.string().uuid(),
    state: z.enum(["played", "current", "upcoming"]),
    media: companionMediaSummarySchema,
    reserved: z.boolean(),
  }).strict()).max(200),
}).strict();

export const companionLibraryPageSchema = z.object({
  revision: safeText(128),
  items: z.array(companionMediaSummarySchema).max(50),
  nextOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
}).strict();

const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set-paused"), paused: z.boolean() }).strict(),
  z.object({ type: z.literal("stop") }).strict(),
  z.object({ type: z.literal("seek"), positionTicks: ticks }).strict(),
  z.object({ type: z.literal("seek-relative"), seconds: z.number().finite().min(-300).max(300) }).strict(),
  z.object({ type: z.literal("set-volume"), volume: z.number().int().min(0).max(100) }).strict(),
  z.object({ type: z.literal("toggle-mute") }).strict(),
  z.object({ type: z.literal("previous") }).strict(),
  z.object({ type: z.literal("next") }).strict(),
  z.object({ type: z.literal("go-live") }).strict(),
  z.object({ type: z.literal("previous-channel") }).strict(),
  z.object({ type: z.literal("next-channel") }).strict(),
  z.object({ type: z.literal("select-audio"), trackId: z.number().int().min(0).max(100000) }).strict(),
  z.object({ type: z.literal("select-subtitle"), trackId: z.number().int().min(0).max(100000).nullable() }).strict(),
  z.object({
    type: z.literal("send-item"),
    itemRef: opaqueRef,
    placement: z.enum(["play-now", "play-next", "queue-end"]),
    resumeMode: z.enum(["resume", "start-over"]),
  }).strict(),
  z.object({ type: z.literal("queue-remove"), queueEntryId: z.string().uuid(), expectedQueueRevision: z.number().int().min(0) }).strict(),
  z.object({ type: z.literal("queue-play-now"), queueEntryId: z.string().uuid(), expectedQueueRevision: z.number().int().min(0) }).strict(),
  z.object({
    type: z.literal("queue-move"),
    queueEntryId: z.string().uuid(),
    beforeEntryId: z.string().uuid().nullable(),
    expectedQueueRevision: z.number().int().min(0),
  }).strict(),
  z.object({ type: z.literal("queue-clear-upcoming"), expectedQueueRevision: z.number().int().min(0) }).strict(),
]);

export const companionCommandEnvelopeSchema = z.object({
  sessionEpoch: opaqueRef,
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  commandId: z.string().uuid(),
  playbackId: z.string().uuid().nullable(),
  command: commandSchema,
}).strict();

export const companionPairRequestSchema = z.object({
  ticket: opaqueRef.optional(),
  code: z.string().regex(/^\d{8}$/).optional(),
  name: safeText(40).min(1),
}).strict().refine((value) => Boolean(value.ticket) !== Boolean(value.code), "Provide one pairing credential.");

export const companionDeviceNameSchema = z.object({ name: safeText(40).min(1) }).strict();

const forbiddenCompanionFields = new Set([
  "accesstoken", "opentoken", "livestreamid", "mediasources", "headers",
  "serverurl", "mediaurl", "path", "transcodingurl", "directstreamurl",
]);

export function assertNoCompanionForbiddenFields(value: unknown): void {
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      if (forbiddenCompanionFields.has(key.toLowerCase())) throw new Error("COMPANION_FORBIDDEN_FIELD");
      visit(child);
    }
  };
  visit(value);
}
