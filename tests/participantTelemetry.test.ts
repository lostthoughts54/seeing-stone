import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUFFERING_GRACE_PERIOD_MS,
  DisabledParticipantTelemetryTransport,
  ENHANCED_TELEMETRY_DISABLED_REASON,
  PARTICIPANT_TELEMETRY_DISCONNECTED_MS,
  PARTICIPANT_TELEMETRY_HEARTBEAT_MS,
  PARTICIPANT_TELEMETRY_MAX_CLOCK_SKEW_MS,
  PARTICIPANT_TELEMETRY_OPERATION_TIMEOUT_MS,
  PARTICIPANT_TELEMETRY_STALE_MS,
  ParticipantTelemetryCoordinator,
  type LocalParticipantTelemetrySnapshot,
  type ParticipantTelemetryConnectionContext,
  type ParticipantTelemetryTransport,
  type ParticipantTelemetryTransportStatus,
} from "../src/main/services/participantTelemetry";
import type { ParticipantTelemetryClientEnvelope } from "../src/shared/participantTelemetryProtocol";

const groupId = "11111111111141118111111111111111";
const wrongGroupId = "22222222222242228222222222222222";
const participantId = "33333333333343338333333333333333";
const now = 1_800_000_000_000;

class FakeTransport implements ParticipantTelemetryTransport {
  status: ParticipantTelemetryTransportStatus = { availability: "available", transport: "websocket", reason: null };
  published: ParticipantTelemetryClientEnvelope[] = [];
  envelopeListeners = new Set<(envelope: unknown) => void>();
  statusListeners = new Set<(status: ParticipantTelemetryTransportStatus) => void>();
  connect = vi.fn(async (_context: ParticipantTelemetryConnectionContext) => undefined);
  disconnect = vi.fn(async () => undefined);
  getStatus(): ParticipantTelemetryTransportStatus { return structuredClone(this.status); }
  async publish(envelope: ParticipantTelemetryClientEnvelope): Promise<void> { this.published.push(structuredClone(envelope)); }
  onEnvelope(listener: (envelope: unknown) => void): () => void {
    this.envelopeListeners.add(listener);
    return () => this.envelopeListeners.delete(listener);
  }
  onStatus(listener: (status: ParticipantTelemetryTransportStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
  receive(envelope: unknown): void { for (const listener of this.envelopeListeners) listener(envelope); }
  setStatus(status: ParticipantTelemetryTransportStatus): void {
    this.status = structuredClone(status);
    for (const listener of this.statusListeners) listener(structuredClone(status));
  }
}

function serverEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    groupId,
    sequence: 1,
    sentAtUnixMs: Date.now(),
    state: "buffering",
    positionTicks: 20_000_000,
    driftTicks: 500_000,
    jellyfinLatencyMs: 35,
    bufferAheadTicks: 1_000_000,
    sourceKind: "direct-play",
    sessionId: "verified-session",
    participantId,
    displayName: "Kayla",
    ...overrides,
  };
}

function harness(transport: ParticipantTelemetryTransport = new FakeTransport()) {
  let local: LocalParticipantTelemetrySnapshot = {
    state: "playing",
    positionTicks: 10_000_000,
    driftTicks: null,
    jellyfinLatencyMs: 12,
    bufferAheadTicks: 40_000_000,
    sourceKind: "matched-local",
  };
  const actions = { pauseGroup: vi.fn(async () => undefined), resumeGroup: vi.fn(async () => undefined) };
  const coordinator = new ParticipantTelemetryCoordinator(transport, () => structuredClone(local), actions);
  return {
    transport,
    coordinator,
    actions,
    setLocal(value: Partial<LocalParticipantTelemetrySnapshot>) { local = { ...local, ...value }; },
  };
}

describe("ParticipantTelemetryCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("degrades safely through the hard-disabled transport without publishing or playback commands", async () => {
    const h = harness(new DisabledParticipantTelemetryTransport());
    await h.coordinator.start(groupId);
    await vi.advanceTimersByTimeAsync(PARTICIPANT_TELEMETRY_HEARTBEAT_MS * 2);

    expect(h.coordinator.getState()).toMatchObject({
      availability: "disabled",
      transport: "none",
      reason: ENHANCED_TELEMETRY_DISABLED_REASON,
      participants: [],
    });
    expect(h.actions.pauseGroup).not.toHaveBeenCalled();
    expect(h.actions.resumeGroup).not.toHaveBeenCalled();
    await h.coordinator.stop();
  });

  it("publishes immediate transitions and a two-second heartbeat only while active", async () => {
    const h = harness();
    await h.coordinator.start(groupId);
    const transport = h.transport as FakeTransport;
    expect(transport.published).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(PARTICIPANT_TELEMETRY_HEARTBEAT_MS);
    expect(transport.published).toHaveLength(2);
    h.setLocal({ state: "paused", positionTicks: 30_000_000 });
    await h.coordinator.notifyLocalStateTransition();
    expect(transport.published).toHaveLength(3);
    expect(transport.published.at(-1)).toMatchObject({ state: "paused", positionTicks: 30_000_000, sequence: 2 });

    await vi.advanceTimersByTimeAsync(PARTICIPANT_TELEMETRY_HEARTBEAT_MS * 2);
    expect(transport.published).toHaveLength(3);
    await h.coordinator.stop();
  });

  it("does not cross-publish when an earlier group connection resolves late", async () => {
    const transport = new FakeTransport();
    const connectResolvers: Array<() => void> = [];
    transport.connect.mockImplementation(() => new Promise<void>((resolve) => connectResolvers.push(resolve)));
    const h = harness(transport);

    const firstStart = h.coordinator.start(groupId);
    await vi.advanceTimersByTimeAsync(0);
    expect(connectResolvers).toHaveLength(1);
    const secondStart = h.coordinator.start(wrongGroupId);
    await vi.advanceTimersByTimeAsync(0);
    expect(connectResolvers).toHaveLength(2);

    connectResolvers[0]();
    await firstStart;
    expect(transport.published).toEqual([]);
    expect(h.coordinator.getState().availability).toBe("connecting");

    connectResolvers[1]();
    await secondStart;
    expect(transport.published).toEqual([expect.objectContaining({ groupId: wrongGroupId })]);
    await h.coordinator.stop();
  });

  it("contains synchronous optional transport cleanup failures", async () => {
    const transport = new FakeTransport();
    transport.onEnvelope = vi.fn(() => () => { throw new Error("unsubscribe failed"); });
    transport.onStatus = vi.fn(() => () => { throw new Error("unsubscribe failed"); });
    const h = harness(transport);
    await h.coordinator.start(groupId);
    transport.disconnect = vi.fn(() => { throw new Error("disconnect failed"); });
    transport.getStatus = vi.fn(() => { throw new Error("status failed"); });

    await expect(h.coordinator.stop()).resolves.toBeUndefined();
    expect(h.coordinator.getState()).toMatchObject({ availability: "offline", incident: null, participants: [] });
  });

  it("keeps a failed state transition eligible for an immediate retry", async () => {
    const h = harness();
    const transport = h.transport as FakeTransport;
    const publish = vi.spyOn(transport, "publish").mockRejectedValueOnce(new Error("offline"));
    await h.coordinator.start(groupId);
    expect(publish).toHaveBeenCalledTimes(1);

    await h.coordinator.notifyLocalStateTransition();
    expect(publish).toHaveBeenCalledTimes(2);
    await h.coordinator.stop();
  });

  it("accepts only strict current-group monotonic server envelopes", async () => {
    const h = harness();
    await h.coordinator.start(groupId);
    const transport = h.transport as FakeTransport;
    transport.receive(serverEnvelope({ groupId: wrongGroupId, sequence: 2 }));
    transport.receive(serverEnvelope({ sequence: 2, mediaUrl: "https://invalid.example/media" }));
    transport.receive(serverEnvelope({ sequence: 3, sentAtUnixMs: Date.now() - PARTICIPANT_TELEMETRY_MAX_CLOCK_SKEW_MS - 1 }));
    transport.receive(serverEnvelope({ sequence: 4 }));
    transport.receive(serverEnvelope({ sequence: 4, state: "ready" }));

    expect(h.coordinator.getState().participants).toEqual([expect.objectContaining({
      participantId,
      displayName: "Kayla",
      state: "buffering",
      freshness: "current",
    })]);
    await h.coordinator.stop();
  });

  it("marks verified status stale after six seconds and disconnected after ten", async () => {
    const h = harness();
    await h.coordinator.start(groupId);
    (h.transport as FakeTransport).receive(serverEnvelope());
    await vi.advanceTimersByTimeAsync(PARTICIPANT_TELEMETRY_STALE_MS);
    expect(h.coordinator.getState().participants[0]).toMatchObject({ state: "buffering", freshness: "stale" });
    expect(h.coordinator.getState().incident).toBeNull();

    await vi.advanceTimersByTimeAsync(PARTICIPANT_TELEMETRY_DISCONNECTED_MS - PARTICIPANT_TELEMETRY_STALE_MS);
    expect(h.coordinator.getState().participants[0]).toMatchObject({ state: "disconnected", freshness: "disconnected" });
    expect(h.coordinator.getState().incident).toBeNull();
    await h.coordinator.stop();
  });

  it("waits after the 1.5-second grace and identifies only a verified current participant", async () => {
    const h = harness();
    await h.coordinator.start(groupId);
    (h.transport as FakeTransport).receive(serverEnvelope());
    expect(h.coordinator.getState().incident).toMatchObject({
      participantId,
      participantName: "Kayla",
      status: "grace",
      automaticallyPaused: false,
    });

    await vi.advanceTimersByTimeAsync(BUFFERING_GRACE_PERIOD_MS - 1);
    expect(h.actions.pauseGroup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.actions.pauseGroup).toHaveBeenCalledTimes(1);
    expect(h.coordinator.getState().incident).toMatchObject({ status: "waiting", automaticallyPaused: true });
    await h.coordinator.stop();
  });

  it("keeps a buffering incident tied to the exact verified session", async () => {
    const h = harness();
    await h.coordinator.start(groupId);
    const transport = h.transport as FakeTransport;
    transport.receive(serverEnvelope({ sessionId: "session-one" }));
    transport.receive(serverEnvelope({ sessionId: "session-two", state: "playing" }));

    expect(h.coordinator.getState().incident).toMatchObject({ participantId, state: "buffering" });
    transport.receive(serverEnvelope({ sessionId: "session-two", sequence: 2, state: "recovering" }));
    expect(h.coordinator.getState().incident).not.toBeNull();
    transport.receive(serverEnvelope({ sessionId: "session-one", sequence: 2, state: "recovering" }));
    expect(h.coordinator.getState().incident).toBeNull();
    await h.coordinator.stop();
  });

  it("suppresses an incident when the authoritative automatic pause fails", async () => {
    const h = harness();
    h.actions.pauseGroup.mockRejectedValueOnce(new Error("SyncPlay unavailable"));
    await h.coordinator.start(groupId);
    (h.transport as FakeTransport).receive(serverEnvelope());
    await vi.advanceTimersByTimeAsync(BUFFERING_GRACE_PERIOD_MS);

    expect(h.coordinator.getState().incident).toMatchObject({ status: "suppressed", automaticallyPaused: false });
    await vi.advanceTimersByTimeAsync(BUFFERING_GRACE_PERIOD_MS * 2);
    expect(h.actions.pauseGroup).toHaveBeenCalledTimes(1);
    await h.coordinator.stop();
  });

  it("bounds a hung optional publish and rejects invalid outbound snapshots", async () => {
    const h = harness();
    const transport = h.transport as FakeTransport;
    await h.coordinator.start(groupId);
    vi.spyOn(transport, "publish").mockImplementationOnce(() => new Promise<void>(() => undefined));
    h.setLocal({ state: "paused" });
    const transition = h.coordinator.notifyLocalStateTransition();
    await vi.advanceTimersByTimeAsync(PARTICIPANT_TELEMETRY_OPERATION_TIMEOUT_MS);
    await expect(transition).resolves.toBeUndefined();

    const published = transport.published.length;
    h.setLocal({ state: "buffering", positionTicks: Number.NaN });
    await h.coordinator.notifyLocalStateTransition();
    expect(transport.published).toHaveLength(published);
    await h.coordinator.stop();
  });

  it("suppresses automatic waiting for the incident after Continue and clears on recovery", async () => {
    const h = harness();
    await h.coordinator.start(groupId);
    const transport = h.transport as FakeTransport;
    transport.receive(serverEnvelope());
    await h.coordinator.continue();
    expect(h.actions.resumeGroup).toHaveBeenCalledTimes(1);
    expect(h.coordinator.getState().incident).toMatchObject({ status: "suppressed" });

    transport.receive(serverEnvelope({ sequence: 2, state: "buffering" }));
    await vi.advanceTimersByTimeAsync(BUFFERING_GRACE_PERIOD_MS * 2);
    expect(h.actions.pauseGroup).not.toHaveBeenCalled();
    transport.receive(serverEnvelope({ sequence: 3, state: "recovering" }));
    expect(h.coordinator.getState().incident).toBeNull();
    await h.coordinator.stop();
  });

  it("disconnects telemetry and clears an incident without affecting standard SyncPlay", async () => {
    const h = harness();
    await h.coordinator.start(groupId);
    const transport = h.transport as FakeTransport;
    transport.receive(serverEnvelope());
    transport.setStatus({
      availability: "offline",
      transport: "websocket",
      reason: "Bearer secret should never reach diagnostics",
    });

    expect(h.coordinator.getState()).toMatchObject({
      availability: "offline",
      incident: null,
      participants: [expect.objectContaining({ state: "disconnected", freshness: "disconnected" })],
    });
    expect(h.coordinator.getState().reason).toBe("Enhanced participant status is disconnected. Standard Jellyfin SyncPlay remains active.");
    expect(h.actions.pauseGroup).not.toHaveBeenCalled();
    await h.coordinator.stop();
  });
});
