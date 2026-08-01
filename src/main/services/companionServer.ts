import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { CompanionCommand, CompanionCommandEnvelope } from "../../shared/companionContracts";
import { COMPANION_PROTOCOL_VERSION } from "../../shared/companionContracts";
import { assertNoCompanionForbiddenFields, companionCommandEnvelopeSchema, companionPairRequestSchema } from "../../shared/companionSchemas";
import { toPublicError, AppError } from "./errors";
import { CompanionAuthenticationService } from "./companionAuthentication";
import type { CompanionCredentialStore } from "./companionCredentialStore";
import type { CompanionNetworkAdapter } from "./companionNetwork";
import { isAddressOnAdapter } from "./companionNetwork";
import type { CompanionPairingService } from "./companionPairing";
import type { CompanionStateService } from "./companionState";
import type { PlaybackCommandService } from "./playbackCommandService";
import type { PlaybackQueueStore } from "./playbackQueue";
import type { CompanionArtworkService } from "./companionArtwork";

const MAX_BODY_BYTES = 32 * 1024;
const securityHeaders = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; connect-src 'self' ws:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cache-Control": "no-store",
} as const;

interface CompanionServerOptions {
  adapter: CompanionNetworkAdapter;
  port: number;
  hosts: string[];
  staticRoot: string;
  identity: () => { serverId: string; userId: string };
  pairing: CompanionPairingService;
  authentication: CompanionAuthenticationService;
  credentials: CompanionCredentialStore;
  state: CompanionStateService;
  commands: PlaybackCommandService;
  queue: PlaybackQueueStore;
  artwork: CompanionArtworkService;
  onConnectionsChanged?: (count: number, deviceIds: ReadonlySet<string>) => void;
  onDevicesChanged?: () => void;
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json":
    case ".webmanifest": return "application/manifest+json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    default: return "application/octet-stream";
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw new AppError("CONTENT_TYPE_UNSUPPORTED", "Use application/json for this request.", 415);
  }
  const declared = Number(request.headers["content-length"] ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > MAX_BODY_BYTES) {
    throw new AppError("REQUEST_TOO_LARGE", "The request is too large.", 413);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new AppError("REQUEST_TOO_LARGE", "The request is too large.", 413);
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
    throw new AppError("INVALID_JSON", "The request body is invalid.", 400);
  }
}

export function assertCompanionRequestContext(input: {
  host: string;
  origin: string | undefined;
  fetchSite: string | undefined;
  allowedHosts: string[];
  requireOrigin: boolean;
}): void {
  const host = input.host.toLowerCase();
  if (!input.allowedHosts.map((entry) => entry.toLowerCase()).includes(host)) {
    throw new AppError("COMPANION_HOST_BLOCKED", "The request host is not allowed.", 403);
  }
  const expectedOrigin = `http://${host}`;
  if ((input.requireOrigin || input.origin) && input.origin !== expectedOrigin) {
    throw new AppError("COMPANION_ORIGIN_BLOCKED", "The request origin is not allowed.", 403);
  }
  // Some iOS Safari versions omit Fetch Metadata for same-origin LAN
  // requests. Host and Origin remain exact and mandatory for mutations;
  // validate Sec-Fetch-Site whenever the browser supplies it.
  if (input.fetchSite !== undefined && (
    (input.requireOrigin && input.fetchSite !== "same-origin")
    || (!input.requireOrigin && input.fetchSite !== "same-origin" && input.fetchSite !== "none")
  )) {
    throw new AppError("COMPANION_FETCH_BLOCKED", "The request context is not allowed.", 403);
  }
}

export class CompanionServer {
  private server: Server | null = null;
  private readonly socketsByDevice = new Map<string, Set<WebSocket>>();
  private unsubscribeState: (() => void) | null = null;
  private envelopeRevision = 0;
  private readonly pairFailures = new Map<string, { failures: number; blockedUntil: number }>();
  private readonly socketActivity = new Map<WebSocket, number>();
  private readonly searchRequests = new Map<string, number[]>();
  private readonly commandTails = new Map<string, Promise<void>>();
  private readonly requestRates = new Map<string, { windowStart: number; count: number }>();
  private pingTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: CompanionServerOptions) {}

  async start(): Promise<void> {
    if (this.server) return;
    const webSockets = new WebSocketServer({ noServer: true, maxPayload: 8192 });
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => this.fail(response, error));
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.on("upgrade", (request, socket, head) => {
      void this.upgrade(webSockets, request, socket, head).catch(() => socket.destroy());
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, this.options.adapter.address, () => {
        server.off("error", reject);
        resolvePromise();
      });
    });
    this.server = server;
    this.pingTimer = setInterval(() => {
      const cutoff = Date.now() - 90_000;
      for (const [socket, lastActivity] of this.socketActivity) {
        if (lastActivity < cutoff) socket.terminate();
        else if (socket.readyState === WebSocket.OPEN) socket.ping();
      }
    }, 25_000);
    this.pingTimer.unref();
    this.heartbeatTimer = setInterval(() => this.broadcast("server", { contact: true }), 5_000);
    this.heartbeatTimer.unref();
    this.unsubscribeState = this.options.state.onState((topic, payload) => {
      this.broadcast(topic, payload);
    });
  }

  async stop(): Promise<void> {
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    for (const sockets of this.socketsByDevice.values()) {
      for (const socket of sockets) socket.close(1001, "Companion stopped");
    }
    this.socketsByDevice.clear();
    this.socketActivity.clear();
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.pairFailures.clear();
    this.searchRequests.clear();
    this.commandTails.clear();
    this.requestRates.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    this.options.onConnectionsChanged?.(0, new Set());
  }

  closeDevice(deviceId: string): void {
    for (const socket of this.socketsByDevice.get(deviceId) ?? []) socket.close(4001, "Device revoked");
    this.socketsByDevice.delete(deviceId);
    this.reportConnections();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.assertNetwork(request);
    this.acceptRequest(request.socket.remoteAddress);
    this.applyHeaders(response);
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "invalid"}`);
    this.assertHostAndOrigin(request, url.pathname.startsWith("/api/") && request.method !== "GET");

    if (request.method === "POST" && url.pathname === "/api/v1/pair") {
      const remote = String(request.socket.remoteAddress ?? "unknown");
      const throttle = this.pairFailures.get(remote);
      if (throttle && throttle.blockedUntil > Date.now()) throw new AppError("COMPANION_PAIRING_THROTTLED", "Too many pairing failures. Try again later.", 429);
      const input = companionPairRequestSchema.parse(await readJson(request));
      try {
        this.options.pairing.consume(input);
        this.pairFailures.delete(remote);
      } catch (error) {
        const failures = (throttle?.failures ?? 0) + 1;
        this.pairFailures.set(remote, {
          failures,
          blockedUntil: failures >= 5 ? Date.now() + 15 * 60_000 : Date.now() + Math.min(30_000, failures * failures * 500),
        });
        throw error;
      }
      const identity = this.options.identity();
      const secret = CompanionServer.deviceSecret();
      const device = await this.options.credentials.create(identity.serverId, identity.userId, input.name, secret);
      this.options.onDevicesChanged?.();
      response.setHeader("Set-Cookie", this.options.authentication.createCredentialCookie(device.deviceId, secret));
      return this.json(response, 201, { paired: true, deviceName: device.name });
    }

    if (url.pathname.startsWith("/api/")) {
      const device = await this.options.authentication.authenticateCookie(request.headers.cookie);
      if (request.method === "GET" && url.pathname === "/api/v1/session") {
        const session = this.options.authentication.issueSession(device.deviceId);
        return this.json(response, 200, {
          protocolVersion: COMPANION_PROTOCOL_VERSION,
          ...session,
          bootstrap: await this.options.state.bootstrap(),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/v1/poll") {
        await new Promise<void>((resolvePromise) => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            unsubscribe();
            resolvePromise();
          };
          const unsubscribe = this.options.state.onState(() => finish());
          const timer = setTimeout(finish, 25_000);
        });
        return this.json(response, 200, await this.options.state.bootstrap());
      }
      if (request.method === "GET" && url.pathname === "/api/v1/library/home") {
        return this.json(response, 200, await this.options.state.getHomePage(
          Number(url.searchParams.get("offset") ?? 0),
          Number(url.searchParams.get("limit") ?? 30),
        ));
      }
      if (request.method === "GET" && url.pathname === "/api/v1/library/search") {
        this.acceptSearch(device.deviceId);
        return this.json(response, 200, await this.options.state.searchPage(
          url.searchParams.get("q") ?? "",
          Number(url.searchParams.get("offset") ?? 0),
          Number(url.searchParams.get("limit") ?? 30),
        ));
      }
      if (request.method === "GET" && url.pathname === "/api/v1/libraries") {
        return this.json(response, 200, await this.options.state.getLibraries());
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/v1/library/")) {
        return this.json(response, 200, await this.options.state.getLibraryPage(
          url.pathname.slice("/api/v1/library/".length),
          Number(url.searchParams.get("offset") ?? 0),
          Number(url.searchParams.get("limit") ?? 30),
        ));
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/v1/series/")) {
        return this.json(response, 200, await this.options.state.getSeriesPage(
          url.pathname.slice("/api/v1/series/".length),
          Number(url.searchParams.get("offset") ?? 0),
          Number(url.searchParams.get("limit") ?? 30),
        ));
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/v1/episodes/") && url.pathname.endsWith("/neighbors")) {
        const reference = url.pathname.slice("/api/v1/episodes/".length, -"/neighbors".length);
        return this.json(response, 200, await this.options.state.getEpisodeNeighbors(reference));
      }
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/api/v1/artwork/")) {
        const reference = url.pathname.slice("/api/v1/artwork/".length);
        if (!/^[A-Za-z0-9_-]{16,256}$/.test(reference)) throw new AppError("ARTWORK_REFERENCE_INVALID", "That artwork reference is invalid.", 400);
        const requested = url.searchParams.get("size");
        const preset = requested === "small" || requested === "large" ? requested : "medium";
        const artwork = await this.options.artwork.get(reference, preset, request.method === "HEAD");
        response.statusCode = 200;
        response.setHeader("Content-Type", artwork.contentType);
        response.setHeader("Cache-Control", "private, max-age=300");
        if (artwork.body) response.setHeader("Content-Length", artwork.body.length);
        response.end(artwork.body ?? undefined);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/commands") {
        const envelope = companionCommandEnvelopeSchema.parse(await readJson(request)) as CompanionCommandEnvelope;
        const accepted = this.options.authentication.acceptCommand(
          device.deviceId,
          envelope,
          request.headers["x-seeing-stone-csrf"] as string | undefined,
        );
        if (!accepted) return this.json(response, 200, { accepted: true, duplicate: true });
        await this.serializeCommand(device.deviceId, () => this.execute(envelope));
        return this.json(response, 200, { accepted: true });
      }
      throw new AppError("NOT_FOUND", "That Companion endpoint does not exist.", 404);
    }

    if (request.method !== "GET" && request.method !== "HEAD") throw new AppError("METHOD_NOT_ALLOWED", "That method is not allowed.", 405);
    await this.staticFile(url.pathname, request.method === "HEAD", response);
  }

  private async execute(envelope: CompanionCommandEnvelope): Promise<void> {
    const state = this.options.commands.getState();
    const command = envelope.command;
    if (!["send-item", "queue-remove", "queue-move", "queue-clear-upcoming", "queue-play-now"].includes(command.type)
      && (!envelope.playbackId || envelope.playbackId !== state.playbackId)) {
      throw new AppError("PLAYBACK_STALE", "Playback changed. Refresh the Companion state.", 409);
    }
    const playbackId = envelope.playbackId ?? "";
    switch (command.type) {
      case "set-paused": await this.options.commands.setPaused(playbackId, command.paused); break;
      case "stop": await this.options.commands.stop(playbackId); break;
      case "seek": await this.options.commands.seek(playbackId, command.positionTicks); break;
      case "seek-relative": await this.options.commands.seek(playbackId, Math.max(0, state.positionTicks + command.seconds * 10_000_000)); break;
      case "set-volume": await this.options.commands.setVolume(playbackId, command.volume); break;
      case "toggle-mute": await this.options.commands.setMuted(playbackId, state.volume > 0); break;
      case "select-audio": await this.options.commands.selectAudio(playbackId, command.trackId); break;
      case "select-subtitle": await this.options.commands.selectSubtitle(playbackId, command.trackId); break;
      case "next": {
        const next = this.options.queue.peekNext();
        if (next) await this.options.commands.playQueueEntry(next.queueEntryId);
        else await this.options.commands.navigateAdjacentEpisode(1);
        break;
      }
      case "previous": {
        const previous = this.options.queue.getPrevious();
        if (previous) await this.options.commands.playQueueEntry(previous.queueEntryId);
        else await this.options.commands.navigateAdjacentEpisode(-1);
        break;
      }
      case "send-item": await this.sendItem(command); break;
      case "queue-remove": this.assertQueueEditable(); this.options.queue.remove(command.queueEntryId, command.expectedQueueRevision); break;
      case "queue-play-now":
        this.assertQueueEditable();
        this.options.queue.assertExpectedRevision(command.expectedQueueRevision);
        await this.options.commands.playQueueEntry(command.queueEntryId);
        break;
      case "queue-move": this.assertQueueEditable(); this.options.queue.move(command.queueEntryId, command.beforeEntryId, command.expectedQueueRevision); break;
      case "queue-clear-upcoming": this.assertQueueEditable(); this.options.queue.clearUpcoming(command.expectedQueueRevision); break;
      case "go-live": await this.options.commands.goLive(); break;
      case "previous-channel": await this.options.commands.navigateLive(-1); break;
      case "next-channel": await this.options.commands.navigateLive(1); break;
    }
  }

  private async sendItem(command: Extract<CompanionCommand, { type: "send-item" }>): Promise<void> {
    const itemId = this.options.state.resolveItemRef(command.itemRef);
    if (command.placement === "play-now") {
      await this.options.commands.start(itemId, command.resumeMode);
      return;
    }
    this.assertQueueEditable();
    const item = await this.options.commands.getDetails(itemId);
    this.options.queue.add(item, command.placement === "play-next" ? "next" : "end");
  }

  private assertQueueEditable(): void {
    if (this.options.commands.isWatchPartyJoined()) {
      throw new AppError("QUEUE_WATCH_PARTY_BLOCKED", "Queue editing is unavailable during a watch party.", 409);
    }
  }

  private async staticFile(pathname: string, head: boolean, response: ServerResponse): Promise<void> {
    const decoded = decodeURIComponent(pathname);
    if (decoded.includes("\0") || decoded.split("/").includes("..")) throw new AppError("INVALID_PATH", "That path is invalid.", 400);
    const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    const target = resolve(this.options.staticRoot, relative);
    const root = resolve(this.options.staticRoot);
    if (target !== root && !target.startsWith(`${root}${sep}`)) throw new AppError("INVALID_PATH", "That path is invalid.", 400);
    let data: Buffer;
    try { data = await readFile(target); } catch { throw new AppError("NOT_FOUND", "That page was not found.", 404); }
    response.statusCode = 200;
    response.setHeader("Content-Type", contentType(target));
    response.setHeader("Content-Length", data.length);
    response.end(head ? undefined : data);
  }

  private async upgrade(webSockets: WebSocketServer, request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): Promise<void> {
    this.assertNetwork(request);
    this.assertHostAndOrigin(request, true);
    const path = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname;
    if (path !== "/api/v1/events") throw new AppError("NOT_FOUND", "That WebSocket endpoint does not exist.", 404);
    const device = await this.options.authentication.authenticateCookie(request.headers.cookie);
    if (!this.options.authentication.consumeWebSocketTicket(device.deviceId, request.headers["sec-websocket-protocol"] as string | undefined)) {
      throw new AppError("COMPANION_WS_TICKET_INVALID", "The WebSocket ticket is invalid.", 401);
    }
    const existing = this.socketsByDevice.get(device.deviceId) ?? new Set<WebSocket>();
    if (existing.size >= 3) throw new AppError("COMPANION_SOCKET_LIMIT", "This device has too many connections.", 429);
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      existing.add(webSocket);
      this.socketActivity.set(webSocket, Date.now());
      this.socketsByDevice.set(device.deviceId, existing);
      this.reportConnections();
      webSocket.on("pong", () => this.socketActivity.set(webSocket, Date.now()));
      webSocket.on("close", () => {
        existing.delete(webSocket);
        this.socketActivity.delete(webSocket);
        if (!existing.size) this.socketsByDevice.delete(device.deviceId);
        this.reportConnections();
      });
      void this.options.state.bootstrap().then((bootstrap) => {
        webSocket.send(JSON.stringify({ protocolVersion: 1, revision: ++this.envelopeRevision, topic: "server", payload: bootstrap }));
      });
    });
  }

  private broadcast(topic: string, payload: unknown): void {
    const message = JSON.stringify({ protocolVersion: 1, revision: ++this.envelopeRevision, topic, payload });
    for (const sockets of this.socketsByDevice.values()) {
      for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(message);
    }
  }

  private assertNetwork(request: IncomingMessage): void {
    if (!isAddressOnAdapter(request.socket.remoteAddress, this.options.adapter)) {
      throw new AppError("COMPANION_NETWORK_BLOCKED", "The request is not on the selected private network.", 403);
    }
  }

  private assertHostAndOrigin(request: IncomingMessage, requireOrigin: boolean): void {
    assertCompanionRequestContext({
      host: String(request.headers.host ?? ""),
      origin: request.headers.origin,
      fetchSite: Array.isArray(request.headers["sec-fetch-site"])
        ? request.headers["sec-fetch-site"][0]
        : request.headers["sec-fetch-site"],
      allowedHosts: this.options.hosts,
      requireOrigin,
    });
  }

  private applyHeaders(response: ServerResponse): void {
    for (const [name, value] of Object.entries(securityHeaders)) response.setHeader(name, value);
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    assertNoCompanionForbiddenFields(body);
    const data = Buffer.from(JSON.stringify(body), "utf8");
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Content-Length", data.length);
    response.end(data);
  }

  private fail(response: ServerResponse, error: unknown): void {
    if (response.headersSent) {
      response.end();
      return;
    }
    this.applyHeaders(response);
    const safe = toPublicError(error);
    this.json(response, safe.status ?? 500, { error: { code: safe.code, message: safe.message } });
  }

  private reportConnections(): void {
    this.options.onConnectionsChanged?.(
      [...this.socketsByDevice.values()].reduce((sum, sockets) => sum + sockets.size, 0),
      new Set(this.socketsByDevice.keys()),
    );
  }

  private acceptSearch(deviceId: string): void {
    const cutoff = Date.now() - 60_000;
    const requests = (this.searchRequests.get(deviceId) ?? []).filter((time) => time > cutoff);
    if (requests.length >= 30) throw new AppError("COMPANION_SEARCH_THROTTLED", "Search is temporarily rate limited.", 429);
    requests.push(Date.now());
    this.searchRequests.set(deviceId, requests);
  }

  private acceptRequest(remoteAddress: string | undefined): void {
    const key = String(remoteAddress ?? "unknown");
    const now = Date.now();
    let rate = this.requestRates.get(key);
    if (!rate || now - rate.windowStart >= 60_000) rate = { windowStart: now, count: 0 };
    rate.count += 1;
    this.requestRates.set(key, rate);
    if (rate.count > 600) throw new AppError("COMPANION_RATE_LIMITED", "Too many requests. Try again shortly.", 429);
  }

  private async serializeCommand<T>(deviceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.commandTails.get(deviceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const tail = previous.then(() => current);
    this.commandTails.set(deviceId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.commandTails.get(deviceId) === tail) this.commandTails.delete(deviceId);
    }
  }

  private static deviceSecret(): string {
    return CompanionAuthenticationService.newDeviceSecret();
  }
}
