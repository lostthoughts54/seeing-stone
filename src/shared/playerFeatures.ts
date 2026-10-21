import { z } from "zod";

const id = z.string().regex(/^[a-f0-9]{32}$/i);
const ticks = z.number().int().min(0).max(864_000_000_000);
const time = z.number().finite().nonnegative();
export const featureMediaSchema = z.object({ kind: z.enum(["jellyfin", "youtube"]), itemId: z.string().max(80), mediaSourceId: z.string().max(128).nullable(), title: z.string().max(512), durationTicks: ticks, version: z.string().max(128) });
export const featureRoomSchema = z.object({
  id, name: z.string().max(80), serverNow: time, owner: z.boolean(), hostOnly: z.boolean(), waitForAll: z.boolean(), minimumParticipants: z.number().int().min(1).max(2), autoNext: z.boolean(),
  timeline: z.object({ version: time, generation: time, positionTicks: ticks, playing: z.boolean(), anchoredAt: time, startAt: time.nullable(), nextAt: time.nullable(), phase: z.string().max(32), targetRevision: time }),
  media: featureMediaSchema.nullable(),
  queue: z.array(z.object({ id, media: featureMediaSchema, addedBy: z.string().max(80), votes: z.number().int().nonnegative(), voted: z.boolean() })).max(100),
  members: z.array(z.object({ id, name: z.string().max(80), host: z.boolean(), state: z.string().max(32), ready: z.boolean(), connected: z.boolean(), seenAt: time, positionTicks: ticks, bufferTicks: ticks.nullable(), source: z.string().max(40).nullable(), issue: z.string().max(240).nullable(), preparation: z.string().max(120) })).max(32),
  messages: z.array(z.object({ id, author: z.string().max(80), kind: z.enum(["chat", "reaction", "comment"]), text: z.string().max(500), createdAt: time, positionTicks: ticks.nullable(), generation: time })).max(200),
  events: z.array(z.object({ id, at: time, text: z.string().max(512) })).max(300),
});
export const featureSummarySchema = z.object({ id, name: z.string().max(80), title: z.string().max(512).nullable(), connected: z.number().int().min(0).max(32), updatedAt: time });
export const featureActionSchema = z.object({ action: z.enum(["play", "pause", "continue", "seek", "next", "play-item", "watch-item", "remove", "sort-votes", "vote", "host-only", "wait-for-all", "minimum", "auto-next", "prepare"]), queueItemId: id.optional(), positionTicks: ticks.optional(), enabled: z.boolean().optional(), minimumParticipants: z.number().int().min(1).max(2) }).partial({ minimumParticipants: true }).strict();
export const featureInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.enum(["refresh", "leave", "delete", "prepare", "retry", "skip"]) }).strict(),
  z.object({ operation: z.literal("create"), name: z.string().trim().min(1).max(80) }).strict(),
  z.object({ operation: z.literal("join"), roomId: id }).strict(),
  z.object({ operation: z.enum(["add", "watch-now"]), kind: z.enum(["jellyfin", "youtube"]), itemId: z.string().min(1).max(2048), mediaSourceId: z.string().max(128).optional() }).strict(),
  z.object({ operation: z.literal("action"), action: featureActionSchema }).strict(),
  z.object({ operation: z.literal("message"), kind: z.enum(["chat", "reaction", "comment"]), text: z.string().trim().min(1).max(500) }).strict(),
  z.object({ operation: z.literal("timing"), delaySeconds: z.number().finite().min(-120).max(120) }).strict(),
  z.object({ operation: z.literal("youtube-state"), generation: time, videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/), state: z.enum(["loading", "ready", "playing", "paused", "buffering", "error", "ended"]), positionTicks: ticks, durationTicks: ticks }).strict(),
]);
export type FeatureInput = z.infer<typeof featureInputSchema>;
export type FeatureRoom = z.infer<typeof featureRoomSchema>;
export type FeatureMedia = z.infer<typeof featureMediaSchema>;
export type FeatureAction = z.infer<typeof featureActionSchema>;
export interface FeatureState {
  connection: "signed-out" | "connected" | "reconnecting" | "unavailable";
  room: FeatureRoom | null;
  rooms: z.infer<typeof featureSummarySchema>[];
  error: string | null;
  local: { preparation: string; issue: string | null; delivery: string | null; subtitles: number; delaySeconds: number; downloads: string };
}
export const featureIpc = { command: "player-features:intent", changed: "player-features:changed" } as const;
export function featurePosition(room: FeatureRoom, now = Date.now()): number {
  return Math.min(room.media?.durationTicks || 864_000_000_000, room.timeline.positionTicks + (room.timeline.playing ? Math.max(0, now - room.timeline.anchoredAt) * 10000 : 0));
}
