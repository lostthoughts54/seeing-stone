import { describe, expect, it } from "vitest";
import {
  PARTICIPANT_TELEMETRY_PROTOCOL_VERSION,
  participantTelemetryClientEnvelopeSchema,
  participantTelemetryServerEnvelopeSchema,
} from "../src/shared/participantTelemetryProtocol";

const groupId = "11111111111141118111111111111111";
const participantId = "22222222222242228222222222222222";

function clientEnvelope() {
  return {
    protocolVersion: PARTICIPANT_TELEMETRY_PROTOCOL_VERSION,
    groupId,
    sequence: 8,
    sentAtUnixMs: 1_800_000_000_000,
    state: "buffering" as const,
    positionTicks: 90_000_000,
    driftTicks: null,
    jellyfinLatencyMs: 24,
    bufferAheadTicks: 2_000_000,
    sourceKind: "direct-play" as const,
  };
}

describe("participant telemetry protocol", () => {
  it("accepts the pinned strict client envelope without client-asserted identity", () => {
    const parsed = participantTelemetryClientEnvelopeSchema.parse(clientEnvelope());

    expect(parsed).toEqual(clientEnvelope());
    expect(parsed).not.toHaveProperty("sessionId");
    expect(parsed).not.toHaveProperty("participantId");
    expect(parsed).not.toHaveProperty("displayName");
  });

  it("rejects unknown protocol versions, extra fields, URLs, and credentials", () => {
    expect(participantTelemetryClientEnvelopeSchema.safeParse({
      ...clientEnvelope(),
      protocolVersion: 2,
    }).success).toBe(false);
    expect(participantTelemetryClientEnvelopeSchema.safeParse({
      ...clientEnvelope(),
      mediaUrl: "https://media.invalid/video",
    }).success).toBe(false);
    expect(participantTelemetryClientEnvelopeSchema.safeParse({
      ...clientEnvelope(),
      accessToken: "secret",
    }).success).toBe(false);
  });

  it("requires server-derived participant and session identity on received status", () => {
    expect(participantTelemetryServerEnvelopeSchema.parse({
      ...clientEnvelope(),
      sessionId: "authenticated-session",
      participantId,
      displayName: "Kayla",
    })).toMatchObject({ participantId, displayName: "Kayla" });

    expect(participantTelemetryServerEnvelopeSchema.safeParse(clientEnvelope()).success).toBe(false);
    expect(participantTelemetryServerEnvelopeSchema.safeParse({
      ...clientEnvelope(),
      sessionId: "authenticated-session",
      participantId: "not-a-guid",
      displayName: "Kayla",
    }).success).toBe(false);
    for (const displayName of ["Bearer secret", "https://media.invalid", "token=secret", "line\nbreak"]) {
      expect(participantTelemetryServerEnvelopeSchema.safeParse({
        ...clientEnvelope(),
        sessionId: "authenticated-session",
        participantId,
        displayName,
      }).success).toBe(false);
    }
    expect(participantTelemetryServerEnvelopeSchema.safeParse({
      ...clientEnvelope(),
      sessionId: "session/with/path",
      participantId,
      displayName: "Kayla",
    }).success).toBe(false);
  });

  it("bounds measured values and permits every sanitized delivery kind", () => {
    for (const sourceKind of [
      "matched-local",
      "downloaded",
      "direct-play",
      "direct-stream",
      "transcode",
      "offline-local",
    ] as const) {
      expect(participantTelemetryClientEnvelopeSchema.safeParse({ ...clientEnvelope(), sourceKind }).success).toBe(true);
    }
    expect(participantTelemetryClientEnvelopeSchema.safeParse({
      ...clientEnvelope(),
      jellyfinLatencyMs: 60_001,
    }).success).toBe(false);
    expect(participantTelemetryClientEnvelopeSchema.safeParse({
      ...clientEnvelope(),
      bufferAheadTicks: -1,
    }).success).toBe(false);
  });
});
