import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceIdentity } from "../src/main/services/deviceIdentity";
import { JellyfinApi, type JellyfinConnectionClock } from "../src/main/services/jellyfinApi";
import { SecureSessionStore, type SessionProtector } from "../src/main/services/secureSession";

const identity: DeviceIdentity = {
  deviceId: "11111111-1111-4111-8111-111111111111",
  clientName: "Seeing Stone",
  clientVersion: "0.4.3",
  deviceName: "Windows Desktop",
};

const protector: SessionProtector = {
  async isAvailable() { return false; },
  async encrypt() { throw new Error("disabled"); },
  async decrypt() { throw new Error("disabled"); },
};

function serverInfo(): Response {
  return Response.json({ Id: "server-1", ServerName: "Measured Jellyfin", Version: "10.11.11" });
}

describe("Jellyfin connection diagnostics", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("measures authenticated request time to response headers and clears it while offline", async () => {
    let monotonic = 10;
    let wall = Date.parse("2026-07-17T12:00:00.000Z");
    let mode: "connected" | "offline" = "connected";
    const clock: JellyfinConnectionClock = { monotonicNow: () => monotonic, wallNow: () => wall };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/System/Info/Public") return serverInfo();
      if (url.pathname === "/Users/AuthenticateByName") {
        return Response.json({ AccessToken: "TEST_ONLY_TOKEN", User: { Id: "user-1", Name: "Viewer" } });
      }
      if (mode === "offline") throw new Error("isolated outage");
      monotonic += 37;
      if (url.pathname.endsWith("/Views")) return Response.json({ Items: [] });
      throw new Error(`Unexpected endpoint ${url.pathname}`);
    }));
    const directory = await mkdtemp(join(tmpdir(), "seeing-stone-connection-"));
    const api = new JellyfinApi(identity, new SecureSessionStore(directory, protector), async () => undefined, clock);
    const connection = await api.connect("http://127.0.0.1:8096");
    await api.login(connection.connectionId, "Viewer", "password", false);

    await api.getLibraries();
    expect(api.getConnectionDiagnostics()).toEqual({
      state: "connected",
      serverName: "Measured Jellyfin",
      serverVersion: "10.11.11",
      requestLatencyMs: 37,
      measuredAt: "2026-07-17T12:00:00.000Z",
    });

    mode = "offline";
    wall += 1_000;
    await expect(api.getLibraries()).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
    expect(api.getConnectionDiagnostics()).toMatchObject({
      state: "offline",
      requestLatencyMs: null,
      measuredAt: "2026-07-17T12:00:01.000Z",
    });

    mode = "connected";
    wall += 1_000;
    await api.getLibraries();
    expect(api.getConnectionDiagnostics()).toMatchObject({ state: "connected", requestLatencyMs: 37 });
  });

  it("does not let a slower older request overwrite the newest measurement", async () => {
    let monotonic = 0;
    let wall = Date.parse("2026-07-17T13:00:00.000Z");
    const clock: JellyfinConnectionClock = { monotonicNow: () => monotonic, wallNow: () => wall };
    const releases = new Map<string, (response: Response) => void>();
    let holdDetails = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/System/Info/Public") return serverInfo();
      if (url.pathname === "/Users/AuthenticateByName") {
        return Response.json({ AccessToken: "TEST_ONLY_TOKEN", User: { Id: "user-1", Name: "Viewer" } });
      }
      if (!holdDetails) return Response.json({ Items: [] });
      return new Promise<Response>((resolve) => { releases.set(url.pathname, resolve); });
    }));
    const directory = await mkdtemp(join(tmpdir(), "seeing-stone-connection-order-"));
    const api = new JellyfinApi(identity, new SecureSessionStore(directory, protector), async () => undefined, clock);
    const connection = await api.connect("http://127.0.0.1:8096");
    await api.login(connection.connectionId, "Viewer", "password", false);
    holdDetails = true;

    monotonic = 100;
    const older = api.getDetails("older");
    await vi.waitFor(() => expect(releases.has("/Users/user-1/Items/older")).toBe(true));
    monotonic = 110;
    const newer = api.getDetails("newer");
    await vi.waitFor(() => expect(releases.has("/Users/user-1/Items/newer")).toBe(true));
    monotonic = 120;
    releases.get("/Users/user-1/Items/newer")?.(Response.json({ Id: "newer", Name: "Newer", Type: "Movie" }));
    await newer;
    wall += 500;
    monotonic = 180;
    releases.get("/Users/user-1/Items/older")?.(Response.json({ Id: "older", Name: "Older", Type: "Movie" }));
    await older;

    expect(api.getConnectionDiagnostics()).toMatchObject({
      state: "connected",
      requestLatencyMs: 10,
      measuredAt: "2026-07-17T13:00:00.000Z",
    });
  });
});
