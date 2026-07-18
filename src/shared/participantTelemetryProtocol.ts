import { z } from "zod";

export const PARTICIPANT_TELEMETRY_PROTOCOL_VERSION = 1 as const;

const guid = z.string().regex(/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
const sessionIdentifier = z.string().min(1).max(128).regex(/^[a-z0-9._:-]+$/i);
const displayName = z.string().trim().min(1).max(80)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "Display name contains control characters.")
  .refine(
    (value) => !/(?:https?:\/\/|file:\/\/|\bBearer\s+|\b(?:token|api[_ -]?key|password)\s*[:=])/iu.test(value),
    "Display name contains URL- or credential-shaped content.",
  );
const safeTicks = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const optionalSignedTicks = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable();
const optionalMilliseconds = z.number().min(0).max(60_000).nullable();

export const participantTelemetryStateSchema = z.enum([
  "playing",
  "paused",
  "buffering",
  "recovering",
  "ready",
  "stalled",
  "disconnected",
]);

export const participantTelemetrySourceKindSchema = z.enum([
  "matched-local",
  "downloaded",
  "direct-play",
  "direct-stream",
  "transcode",
  "offline-local",
]);

const telemetryPayload = {
  protocolVersion: z.literal(PARTICIPANT_TELEMETRY_PROTOCOL_VERSION),
  groupId: guid,
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sentAtUnixMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  state: participantTelemetryStateSchema,
  positionTicks: safeTicks,
  driftTicks: optionalSignedTicks,
  jellyfinLatencyMs: optionalMilliseconds,
  bufferAheadTicks: safeTicks.nullable(),
  sourceKind: participantTelemetrySourceKindSchema.nullable(),
} as const;

/** Client-to-plugin status. Identity is deliberately absent and must be derived by Jellyfin. */
export const participantTelemetryClientEnvelopeSchema = z.object(telemetryPayload).strict();

/** Plugin-to-client status after authenticated session and SyncPlay membership verification. */
export const participantTelemetryServerEnvelopeSchema = z.object({
  ...telemetryPayload,
  sessionId: sessionIdentifier,
  participantId: guid,
  displayName,
}).strict();

export type ParticipantTelemetryState = z.infer<typeof participantTelemetryStateSchema>;
export type ParticipantTelemetrySourceKind = z.infer<typeof participantTelemetrySourceKindSchema>;
export type ParticipantTelemetryClientEnvelope = z.infer<typeof participantTelemetryClientEnvelopeSchema>;
export type ParticipantTelemetryServerEnvelope = z.infer<typeof participantTelemetryServerEnvelopeSchema>;

export type ParticipantTelemetryFreshness = "current" | "stale" | "disconnected";

export interface ParticipantTelemetry {
  protocolVersion: typeof PARTICIPANT_TELEMETRY_PROTOCOL_VERSION;
  groupId: string;
  sessionId: string;
  participantId: string;
  displayName: string;
  sequence: number;
  state: ParticipantTelemetryState;
  positionTicks: number;
  driftTicks: number | null;
  jellyfinLatencyMs: number | null;
  bufferAheadTicks: number | null;
  sourceKind: ParticipantTelemetrySourceKind | null;
  receivedAtUnixMs: number;
  freshness: ParticipantTelemetryFreshness;
}
