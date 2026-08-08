import { randomBytes, randomUUID } from "node:crypto";
import type { CompanionDeviceRecord, CompanionCredentialStore } from "./companionCredentialStore";
import { AppError } from "./errors";

interface DeviceSession {
  epoch: string;
  csrfToken: string;
  lastSequence: number;
  commandIds: Map<string, number>;
}

interface WebSocketTicket {
  deviceId: string;
  expiresAt: number;
}

export class CompanionAuthenticationService {
  private readonly sessions = new Map<string, DeviceSession>();
  private readonly webSocketTickets = new Map<string, WebSocketTicket>();

  constructor(
    private readonly credentials: CompanionCredentialStore,
    private readonly identity: () => { serverId: string; userId: string },
  ) {}

  async authenticateCookie(cookieHeader: string | undefined): Promise<CompanionDeviceRecord> {
    const token = this.parseCookie(cookieHeader);
    if (!token) throw new AppError("COMPANION_UNAUTHORIZED", "Pair this device with Seeing Stone.", 401);
    const separator = token.indexOf(".");
    if (separator <= 0) throw new AppError("COMPANION_UNAUTHORIZED", "Pair this device with Seeing Stone.", 401);
    const deviceId = token.slice(0, separator);
    const secret = token.slice(separator + 1);
    if (!/^[0-9a-f-]{36}$/i.test(deviceId) || !/^[A-Za-z0-9_-]{32,128}$/.test(secret)) {
      throw new AppError("COMPANION_UNAUTHORIZED", "Pair this device with Seeing Stone.", 401);
    }
    const identity = this.identity();
    const record = await this.credentials.authenticate(identity.serverId, identity.userId, deviceId, secret);
    if (!record) throw new AppError("COMPANION_UNAUTHORIZED", "Pair this device with Seeing Stone.", 401);
    void this.credentials.touch(record.deviceId).catch(() => undefined);
    return record;
  }

  createCredentialCookie(deviceId: string, secret: string): string {
    return `seeing_stone_device=${deviceId}.${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=15552000`;
  }

  issueSession(deviceId: string): {
    sessionEpoch: string;
    csrfToken: string;
    nextSequence: number;
    webSocketTicket: string;
  } {
    let session = this.sessions.get(deviceId);
    if (!session) {
      session = {
        epoch: randomBytes(24).toString("base64url"),
        csrfToken: randomBytes(24).toString("base64url"),
        lastSequence: -1,
        commandIds: new Map(),
      };
      this.sessions.set(deviceId, session);
    }
    const webSocketTicket = randomBytes(24).toString("base64url");
    this.webSocketTickets.set(webSocketTicket, { deviceId, expiresAt: Date.now() + 30_000 });
    return {
      sessionEpoch: session.epoch,
      csrfToken: session.csrfToken,
      nextSequence: session.lastSequence + 1,
      webSocketTicket,
    };
  }

  acceptCommand(
    deviceId: string,
    input: { sessionEpoch: string; sequence: number; commandId: string },
    csrfHeader: string | undefined,
  ): boolean {
    const session = this.sessions.get(deviceId);
    if (!session || input.sessionEpoch !== session.epoch || csrfHeader !== session.csrfToken) {
      throw new AppError("COMPANION_SESSION_STALE", "Refresh the Companion session.", 409);
    }
    const now = Date.now();
    for (const [id, expiresAt] of session.commandIds) if (expiresAt <= now) session.commandIds.delete(id);
    if (session.commandIds.has(input.commandId)) return false;
    if (input.sequence <= session.lastSequence) throw new AppError("COMPANION_COMMAND_REPLAY", "That command is stale.", 409);
    session.lastSequence = input.sequence;
    session.commandIds.set(input.commandId, now + 10 * 60_000);
    return true;
  }

  consumeWebSocketTicket(deviceId: string, protocolHeader: string | undefined): boolean {
    const protocols = String(protocolHeader ?? "").split(",").map((entry) => entry.trim());
    const value = protocols.find((entry) => entry.startsWith("seeing-stone.v3."));
    if (!value) return false;
    const ticket = value.slice("seeing-stone.v3.".length);
    const record = this.webSocketTickets.get(ticket);
    this.webSocketTickets.delete(ticket);
    return Boolean(record && record.deviceId === deviceId && record.expiresAt > Date.now());
  }

  revoke(deviceId: string): void {
    this.sessions.delete(deviceId);
    for (const [ticket, record] of this.webSocketTickets) {
      if (record.deviceId === deviceId) this.webSocketTickets.delete(ticket);
    }
  }

  reset(): void {
    this.sessions.clear();
    this.webSocketTickets.clear();
  }

  static newDeviceSecret(): string {
    return randomBytes(32).toString("base64url");
  }

  static commandId(): string {
    return randomUUID();
  }

  private parseCookie(header: string | undefined): string | null {
    for (const part of String(header ?? "").split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === "seeing_stone_device") return rest.join("=") || null;
    }
    return null;
  }
}
