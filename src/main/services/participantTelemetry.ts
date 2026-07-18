import type {
  BufferingIncident,
  BufferingPolicyMode,
  BufferingPolicyPreference,
  ParticipantTelemetryTransportAvailability,
  ParticipantTelemetryView,
  ParticipantTelemetryViewState,
  PlaybackSourceKind,
} from "../../shared/contracts";
import {
  PARTICIPANT_TELEMETRY_PROTOCOL_VERSION,
  participantTelemetryClientEnvelopeSchema,
  participantTelemetryServerEnvelopeSchema,
  type ParticipantTelemetryClientEnvelope,
  type ParticipantTelemetryServerEnvelope,
  type ParticipantTelemetryState,
} from "../../shared/participantTelemetryProtocol";

export const PARTICIPANT_TELEMETRY_HEARTBEAT_MS = 2_000;
export const PARTICIPANT_TELEMETRY_STALE_MS = 6_000;
export const PARTICIPANT_TELEMETRY_DISCONNECTED_MS = 10_000;
export const BUFFERING_GRACE_PERIOD_MS = 1_500 as const;
export const PARTICIPANT_TELEMETRY_CONNECT_TIMEOUT_MS = 3_000;
export const PARTICIPANT_TELEMETRY_OPERATION_TIMEOUT_MS = 1_000;
export const PARTICIPANT_TELEMETRY_MAX_CLOCK_SKEW_MS = 5_000;

export interface ParticipantTelemetryTransportStatus {
  availability: ParticipantTelemetryTransportAvailability;
  transport: "none" | "websocket" | "http-polling";
  reason: string | null;
}

export interface ParticipantTelemetryConnectionContext {
  groupId: string;
  signal: AbortSignal;
}

/**
 * Status-only transport boundary. Implementations must authenticate with Jellyfin
 * and report `available` only after the exact session's SyncPlay membership has
 * been verified server-side. The transport has no playback-control capability.
 */
export interface ParticipantTelemetryTransport {
  getStatus(): ParticipantTelemetryTransportStatus;
  connect(context: ParticipantTelemetryConnectionContext): Promise<void>;
  disconnect(): Promise<void>;
  publish(envelope: ParticipantTelemetryClientEnvelope): Promise<void>;
  onEnvelope(listener: (envelope: unknown) => void): () => void;
  onStatus(listener: (status: ParticipantTelemetryTransportStatus) => void): () => void;
}

export interface LocalParticipantTelemetrySnapshot {
  state: ParticipantTelemetryState;
  positionTicks: number;
  driftTicks: number | null;
  jellyfinLatencyMs: number | null;
  bufferAheadTicks: number | null;
  sourceKind: PlaybackSourceKind | null;
}

export interface ParticipantTelemetryActions {
  pauseGroup(): Promise<void>;
  resumeGroup(): Promise<void>;
}

export const ENHANCED_TELEMETRY_DISABLED_REASON =
  "Enhanced participant status is disabled: Jellyfin 10.11.11 does not expose a public plugin API that can verify the exact authenticated session's SyncPlay-group membership.";

export class DisabledParticipantTelemetryTransport implements ParticipantTelemetryTransport {
  private readonly status: ParticipantTelemetryTransportStatus = Object.freeze({
    availability: "disabled",
    transport: "none",
    reason: ENHANCED_TELEMETRY_DISABLED_REASON,
  });

  getStatus(): ParticipantTelemetryTransportStatus { return this.status; }
  async connect(_context: ParticipantTelemetryConnectionContext): Promise<void> { /* Intentionally disabled. */ }
  async disconnect(): Promise<void> { /* Intentionally disabled. */ }
  async publish(_envelope: ParticipantTelemetryClientEnvelope): Promise<void> { /* Status-only no-op. */ }
  onEnvelope(_listener: (envelope: unknown) => void): () => void { return () => undefined; }
  onStatus(_listener: (status: ParticipantTelemetryTransportStatus) => void): () => void { return () => undefined; }
}

interface ReceivedParticipant {
  envelope: ParticipantTelemetryServerEnvelope;
  receivedAtUnixMs: number;
}

interface CoordinatorOptions {
  initialPolicy?: BufferingPolicyMode;
  now?: () => number;
}

function defaultViewState(status: ParticipantTelemetryTransportStatus, policy: BufferingPolicyPreference): ParticipantTelemetryViewState {
  return {
    protocolVersion: PARTICIPANT_TELEMETRY_PROTOCOL_VERSION,
    availability: status.availability,
    transport: status.transport,
    reason: status.reason,
    participants: [],
    incident: null,
    policy,
  };
}

function activeHeartbeatState(state: ParticipantTelemetryState): boolean {
  return state === "playing" || state === "buffering" || state === "recovering" || state === "stalled";
}

function safeTransportStatus(status: ParticipantTelemetryTransportStatus): ParticipantTelemetryTransportStatus {
  if (status.availability === "available") {
    return { availability: "available", transport: status.transport, reason: null };
  }
  if (status.availability === "disabled") {
    return {
      availability: "disabled",
      transport: status.transport,
      reason: status.transport === "none"
        ? ENHANCED_TELEMETRY_DISABLED_REASON
        : "Enhanced participant status is disabled. Standard Jellyfin SyncPlay remains active.",
    };
  }
  if (status.availability === "connecting") {
    return {
      availability: "connecting",
      transport: status.transport,
      reason: "Enhanced participant status is connecting. Standard Jellyfin SyncPlay remains active.",
    };
  }
  const reason = status.availability === "absent"
    ? "Enhanced participant status is unavailable because the optional server plugin was not detected. Standard Jellyfin SyncPlay remains active."
    : status.availability === "incompatible"
      ? "Enhanced participant status is unavailable because the optional server plugin is incompatible. Standard Jellyfin SyncPlay remains active."
      : "Enhanced participant status is disconnected. Standard Jellyfin SyncPlay remains active.";
  return { availability: status.availability, transport: status.transport, reason };
}

function readTransportStatus(transport: ParticipantTelemetryTransport): ParticipantTelemetryTransportStatus {
  try {
    return safeTransportStatus(transport.getStatus());
  } catch {
    return safeTransportStatus({ availability: "offline", transport: "none", reason: null });
  }
}

async function settleOptionalOperation(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const guarded = operation.then(() => true, () => false);
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const completed = await Promise.race([guarded, timedOut]);
  if (timer) clearTimeout(timer);
  return completed;
}

export class ParticipantTelemetryCoordinator {
  private readonly listeners = new Set<(state: ParticipantTelemetryViewState) => void>();
  private readonly participants = new Map<string, ReceivedParticipant>();
  private readonly now: () => number;
  private policy: BufferingPolicyPreference;
  private status: ParticipantTelemetryTransportStatus;
  private groupId: string | null = null;
  private incident: BufferingIncident | null = null;
  private incidentSessionId: string | null = null;
  private sequence = 0;
  private lastPublishedState: ParticipantTelemetryState | null = null;
  private abortController: AbortController | null = null;
  private envelopeUnsubscribe: (() => void) | null = null;
  private statusUnsubscribe: (() => void) | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private freshnessTimer: ReturnType<typeof setInterval> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private lifecycleRevision = 0;
  private connectedRevision: number | null = null;

  constructor(
    private readonly transport: ParticipantTelemetryTransport,
    private readonly getLocalSnapshot: () => LocalParticipantTelemetrySnapshot | null,
    private readonly actions: ParticipantTelemetryActions,
    options: CoordinatorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.policy = { mode: options.initialPolicy ?? "wait-for-all", gracePeriodMs: BUFFERING_GRACE_PERIOD_MS };
    this.status = readTransportStatus(transport);
  }

  getState(): ParticipantTelemetryViewState {
    const now = this.now();
    const participants = [...this.participants.values()]
      .map((entry): ParticipantTelemetryView => {
        const age = Math.max(0, now - entry.receivedAtUnixMs);
        const freshness = age >= PARTICIPANT_TELEMETRY_DISCONNECTED_MS
          ? "disconnected"
          : age >= PARTICIPANT_TELEMETRY_STALE_MS ? "stale" : "current";
        return {
          participantId: entry.envelope.participantId,
          displayName: entry.envelope.displayName,
          state: freshness === "disconnected" ? "disconnected" : entry.envelope.state,
          freshness,
          positionTicks: entry.envelope.positionTicks,
          driftTicks: entry.envelope.driftTicks,
          jellyfinLatencyMs: entry.envelope.jellyfinLatencyMs,
          bufferAheadTicks: entry.envelope.bufferAheadTicks,
          sourceKind: entry.envelope.sourceKind,
        };
      })
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
    return {
      ...defaultViewState(this.status, this.policy),
      participants,
      incident: this.incident ? structuredClone(this.incident) : null,
    };
  }

  onState(listener: (state: ParticipantTelemetryViewState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(groupId: string): Promise<void> {
    await this.stop();
    const revision = ++this.lifecycleRevision;
    this.groupId = groupId;
    this.abortController = new AbortController();
    const reported = readTransportStatus(this.transport);
    if (reported.availability === "disabled" || reported.availability === "absent" || reported.availability === "incompatible") {
      this.status = reported;
      this.emit();
      return;
    }
    this.status = safeTransportStatus({ availability: "connecting", transport: reported.transport, reason: null });
    this.emit();
    try {
      this.envelopeUnsubscribe = this.transport.onEnvelope((envelope) => this.receive(envelope, revision, groupId));
      this.statusUnsubscribe = this.transport.onStatus((status) => {
        if (!this.isCurrentLifecycle(revision, groupId)) return;
        const next = safeTransportStatus(status);
        if (next.availability === "available" && this.connectedRevision !== revision) return;
        this.updateStatus(next);
      });
      this.freshnessTimer = setInterval(() => {
        if (this.isCurrentLifecycle(revision, groupId)) this.refreshFreshness();
      }, 1_000);
      this.heartbeatTimer = setInterval(() => {
        void this.publishHeartbeat(revision, groupId);
      }, PARTICIPANT_TELEMETRY_HEARTBEAT_MS);
      const connected = await settleOptionalOperation(
        this.transport.connect({ groupId, signal: this.abortController.signal }),
        PARTICIPANT_TELEMETRY_CONNECT_TIMEOUT_MS,
      );
      if (!this.isCurrentLifecycle(revision, groupId)) return;
      if (!connected) throw new Error("Optional telemetry transport did not connect.");
      this.connectedRevision = revision;
      this.updateStatus(readTransportStatus(this.transport));
      await this.publishLocal(true, revision, groupId);
    } catch {
      if (!this.isCurrentLifecycle(revision, groupId)) return;
      this.connectedRevision = null;
      this.updateStatus({
        availability: "offline",
        transport: this.status.transport,
        reason: "Enhanced participant status could not connect. Standard Jellyfin SyncPlay remains active.",
      });
    }
  }

  async stop(): Promise<void> {
    this.lifecycleRevision += 1;
    this.connectedRevision = null;
    try { this.abortController?.abort(); } catch { /* Optional transport cleanup is fail-closed. */ }
    this.abortController = null;
    try { this.envelopeUnsubscribe?.(); } catch { /* Optional transport cleanup is fail-closed. */ }
    this.envelopeUnsubscribe = null;
    try { this.statusUnsubscribe?.(); } catch { /* Optional transport cleanup is fail-closed. */ }
    this.statusUnsubscribe = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.freshnessTimer) clearInterval(this.freshnessTimer);
    this.freshnessTimer = null;
    this.clearGraceTimer();
    this.groupId = null;
    this.participants.clear();
    this.incident = null;
    this.incidentSessionId = null;
    this.lastPublishedState = null;
    void settleOptionalOperation(
      Promise.resolve().then(() => this.transport.disconnect()),
      PARTICIPANT_TELEMETRY_OPERATION_TIMEOUT_MS,
    );
    const reported = readTransportStatus(this.transport);
    this.status = reported.availability === "disabled" || reported.availability === "absent" || reported.availability === "incompatible"
      ? reported
      : safeTransportStatus({ availability: "offline", transport: reported.transport, reason: null });
    this.emit();
  }

  setPolicy(mode: BufferingPolicyMode): ParticipantTelemetryViewState {
    this.policy = { mode, gracePeriodMs: BUFFERING_GRACE_PERIOD_MS };
    if (mode === "continue") {
      this.clearIncident();
    } else {
      this.reconcileIncident();
    }
    this.emit();
    return this.getState();
  }

  async wait(): Promise<ParticipantTelemetryViewState> {
    await this.actions.pauseGroup();
    if (this.incident) {
      this.incident = { ...this.incident, status: "waiting", automaticallyPaused: false };
      this.clearGraceTimer();
    }
    this.emit();
    return this.getState();
  }

  async continue(): Promise<ParticipantTelemetryViewState> {
    await this.actions.resumeGroup();
    if (this.incident) {
      this.incident = { ...this.incident, status: "suppressed" };
      this.clearGraceTimer();
    }
    this.emit();
    return this.getState();
  }

  async notifyLocalStateTransition(): Promise<void> {
    const groupId = this.groupId;
    if (!groupId) return;
    await this.publishLocal(false, this.lifecycleRevision, groupId);
  }

  private receive(value: unknown, revision: number, groupId: string): void {
    if (!this.isCurrentLifecycle(revision, groupId) || this.connectedRevision !== revision || this.status.availability !== "available") return;
    const parsed = participantTelemetryServerEnvelopeSchema.safeParse(value);
    if (!parsed.success || parsed.data.groupId !== groupId) return;
    const now = this.now();
    // Clock-skewed packets cannot safely drive automatic group pausing. The
    // optional channel fails open while ordinary Jellyfin SyncPlay continues.
    if (Math.abs(parsed.data.sentAtUnixMs - now) > PARTICIPANT_TELEMETRY_MAX_CLOCK_SKEW_MS) return;
    const current = this.participants.get(parsed.data.sessionId);
    if (current && parsed.data.sequence <= current.envelope.sequence) return;
    this.participants.set(parsed.data.sessionId, { envelope: parsed.data, receivedAtUnixMs: now });
    this.reconcileIncident();
    this.emit();
  }

  private updateStatus(status: ParticipantTelemetryTransportStatus): void {
    this.status = safeTransportStatus(status);
    if (this.status.availability !== "available") {
      this.clearIncident();
      if (this.status.availability === "offline" || this.status.availability === "disabled" || this.status.availability === "incompatible") {
        const now = this.now() - PARTICIPANT_TELEMETRY_DISCONNECTED_MS;
        for (const entry of this.participants.values()) entry.receivedAtUnixMs = now;
      }
    }
    this.emit();
  }

  private async publishHeartbeat(revision: number, groupId: string): Promise<void> {
    if (!this.isCurrentLifecycle(revision, groupId) || this.connectedRevision !== revision) return;
    const snapshot = this.getLocalSnapshot();
    if (!snapshot || !activeHeartbeatState(snapshot.state)) return;
    await this.publishLocal(true, revision, groupId);
  }

  private async publishLocal(force: boolean, revision: number, groupId: string): Promise<void> {
    if (!this.isCurrentLifecycle(revision, groupId) || this.connectedRevision !== revision || this.status.availability !== "available") return;
    const snapshot = this.getLocalSnapshot();
    if (!snapshot) return;
    if (!force && snapshot.state === this.lastPublishedState) return;
    const parsed = participantTelemetryClientEnvelopeSchema.safeParse({
      protocolVersion: PARTICIPANT_TELEMETRY_PROTOCOL_VERSION,
      groupId,
      sequence: this.sequence++,
      sentAtUnixMs: this.now(),
      state: snapshot.state,
      positionTicks: Math.max(0, Math.round(snapshot.positionTicks)),
      driftTicks: snapshot.driftTicks === null ? null : Math.round(snapshot.driftTicks),
      jellyfinLatencyMs: snapshot.jellyfinLatencyMs,
      bufferAheadTicks: snapshot.bufferAheadTicks === null ? null : Math.max(0, Math.round(snapshot.bufferAheadTicks)),
      sourceKind: snapshot.sourceKind,
    });
    if (!parsed.success) return;
    try {
      const published = await settleOptionalOperation(
        this.transport.publish(parsed.data),
        PARTICIPANT_TELEMETRY_OPERATION_TIMEOUT_MS,
      );
      if (!published || !this.isCurrentLifecycle(revision, groupId) || this.connectedRevision !== revision) return;
      this.lastPublishedState = snapshot.state;
    } catch {
      // The transport owns reconnect state. A failed transition remains eligible for retry.
    }
  }

  private refreshFreshness(): void {
    const hadIncident = this.incident !== null;
    this.reconcileIncident();
    if (this.participants.size > 0 || hadIncident !== (this.incident !== null)) this.emit();
  }

  private reconcileIncident(): void {
    if (this.policy.mode !== "wait-for-all" || this.status.availability !== "available") {
      this.clearIncident();
      return;
    }
    const now = this.now();
    if (this.incident) {
      const entry = this.incidentSessionId ? this.participants.get(this.incidentSessionId) : undefined;
      const age = entry ? now - entry.receivedAtUnixMs : Number.POSITIVE_INFINITY;
      const resolved = !entry
        || age >= PARTICIPANT_TELEMETRY_STALE_MS
        || entry.envelope.state === "disconnected"
        || entry.envelope.state === "ready"
        || entry.envelope.state === "recovering"
        || entry.envelope.state === "playing";
      if (!resolved) return;
      this.clearIncident();
    }
    const candidate = [...this.participants.entries()]
      .filter(([, entry]) => now - entry.receivedAtUnixMs < PARTICIPANT_TELEMETRY_STALE_MS)
      .filter(([, entry]) => entry.envelope.state === "buffering" || entry.envelope.state === "stalled")
      .sort(([, left], [, right]) => left.receivedAtUnixMs - right.receivedAtUnixMs)[0];
    if (!candidate) return;
    const [sessionId, participant] = candidate;
    this.incidentSessionId = sessionId;
    this.incident = {
      incidentId: `${participant.envelope.participantId}:${participant.envelope.sequence}`,
      participantId: participant.envelope.participantId,
      participantName: participant.envelope.displayName,
      state: participant.envelope.state as "buffering" | "stalled",
      startedAtUnixMs: now,
      status: "grace",
      automaticallyPaused: false,
    };
    this.graceTimer = setTimeout(() => { void this.applyAutomaticWait(); }, BUFFERING_GRACE_PERIOD_MS);
  }

  private async applyAutomaticWait(): Promise<void> {
    this.graceTimer = null;
    if (!this.incident || this.incident.status !== "grace" || this.policy.mode !== "wait-for-all") return;
    const incidentId = this.incident.incidentId;
    try {
      await this.actions.pauseGroup();
      if (this.incident?.incidentId === incidentId && this.incident.status === "grace") {
        this.incident = { ...this.incident, status: "waiting", automaticallyPaused: true };
        this.emit();
      }
    } catch {
      // SyncPlay owns playback commands and error presentation. Telemetry never retries them.
      if (this.incident?.incidentId === incidentId && this.incident.status === "grace") {
        this.incident = { ...this.incident, status: "suppressed", automaticallyPaused: false };
        this.emit();
      }
    }
  }

  private clearIncident(): void {
    this.clearGraceTimer();
    this.incident = null;
    this.incidentSessionId = null;
  }

  private clearGraceTimer(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  private isCurrentLifecycle(revision: number, groupId: string): boolean {
    return revision === this.lifecycleRevision && groupId === this.groupId;
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      try { listener(state); } catch { /* Optional diagnostics listeners cannot escape into SyncPlay. */ }
    }
  }
}
