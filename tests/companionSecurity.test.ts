import { describe, expect, it, vi } from "vitest";
import { CompanionAuthenticationService } from "../src/main/services/companionAuthentication";
import { normalizeCompanionDeviceName } from "../src/main/services/companionCredentialStore";
import { CompanionPairingService } from "../src/main/services/companionPairing";
import { assertCompanionRequestContext } from "../src/main/services/companionServer";
import { getLibrary, getLiveTvGuide, newCompanionCommandId } from "../src/companion/api";
import { assertNoCompanionForbiddenFields, companionCommandEnvelopeSchema, companionPlayerStateSchema } from "../src/shared/companionSchemas";

describe("Companion security boundaries", () => {
  it("creates command UUIDs without secure-context randomUUID", () => {
    const first = newCompanionCommandId();
    const second = newCompanionCommandId();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });

  it("requests one opaque library page with an allowlisted sort and offset", async () => {
    const fetchMock = vi.fn(async () => Response.json({ revision: "1", items: [], nextOffset: null }));
    vi.stubGlobal("fetch", fetchMock);
    const reference = "a".repeat(32);
    await getLibrary(reference, "release-date", 30);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/library/${reference}?sort=release-date&offset=30&limit=30`,
      expect.objectContaining({ credentials: "same-origin" }),
    );
    vi.unstubAllGlobals();
  });

  it("loads the sanitized guide and accepts only opaque channel references for switching", async () => {
    const fetchMock = vi.fn(async () => Response.json({ availability: "available", message: null, generatedAtUnixMs: 1, channels: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await getLiveTvGuide();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/live-tv/guide",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(companionCommandEnvelopeSchema.safeParse({
      sessionEpoch: "a".repeat(32),
      sequence: 1,
      commandId: "6f084a65-2a40-41cb-a627-a4ef3ce40bbb",
      playbackId: null,
      command: { type: "start-live", channelRef: "b".repeat(32) },
    }).success).toBe(true);
    expect(companionCommandEnvelopeSchema.safeParse({
      sessionEpoch: "a".repeat(32),
      sequence: 1,
      commandId: "6f084a65-2a40-41cb-a627-a4ef3ce40bbb",
      playbackId: null,
      command: { type: "start-live", channelRef: "channel-1" },
    }).success).toBe(false);
    vi.unstubAllGlobals();
  });

  it("accepts iOS same-origin pairing when Fetch Metadata is omitted", () => {
    const input = {
      host: "seeing-stone-abcd.local:50123",
      origin: "http://seeing-stone-abcd.local:50123",
      fetchSite: undefined,
      allowedHosts: ["seeing-stone-abcd.local:50123", "192.168.1.20:50123"],
      requireOrigin: true,
    };
    expect(() => assertCompanionRequestContext(input)).not.toThrow();
    expect(() => assertCompanionRequestContext({ ...input, fetchSite: "same-origin" })).not.toThrow();
  });

  it("still rejects cross-site metadata and mismatched pairing origins", () => {
    const input = {
      host: "seeing-stone-abcd.local:50123",
      origin: "http://seeing-stone-abcd.local:50123",
      fetchSite: "cross-site",
      allowedHosts: ["seeing-stone-abcd.local:50123"],
      requireOrigin: true,
    };
    expect(() => assertCompanionRequestContext(input)).toThrowError(/context is not allowed/i);
    expect(() => assertCompanionRequestContext({
      ...input,
      fetchSite: undefined,
      origin: "http://attacker.invalid",
    })).toThrowError(/origin is not allowed/i);
  });

  it("consumes a pairing secret exactly once and invalidates repeated failures", async () => {
    const pairing = new CompanionPairingService();
    const first = await pairing.begin("http://seeing-stone-abcd.local:54321");
    expect(first.view.code).toMatch(/^\d{8}$/);
    pairing.consume({ ticket: first.ticket });
    expect(() => pairing.consume({ ticket: first.ticket })).toThrowError(/expired/i);

    const second = await pairing.begin("http://seeing-stone-abcd.local:54321");
    const wrongCode = second.view.code === "00000000" ? "11111111" : "00000000";
    for (let index = 0; index < 4; index += 1) expect(() => pairing.consume({ code: wrongCode })).toThrow();
    expect(() => pairing.consume({ code: wrongCode })).toThrow();
    expect(pairing.getView()).toBeNull();
    expect(second.view.qrDataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it("normalizes device names and rejects control or bidi override characters", () => {
    expect(normalizeCompanionDeviceName("  Cafe\u0301  ")).toBe("Café");
    expect(() => normalizeCompanionDeviceName("Phone\u202Eevil")).toThrowError(/visible device name/i);
    expect(() => normalizeCompanionDeviceName("\u0001")).toThrowError(/visible device name/i);
  });

  it("enforces CSRF, epoch, increasing sequence, duplicate IDs, and one-use WebSocket tickets", async () => {
    const record = {
      deviceId: "48bc1119-b1dd-4bee-864e-ae2234082765",
      serverId: "server-1",
      userId: "user-1",
      name: "Phone",
      credentialHash: "a".repeat(64),
      pairedAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    const credentials = {
      authenticate: vi.fn(async () => record),
      touch: vi.fn(async () => undefined),
    };
    const authentication = new CompanionAuthenticationService(
      credentials as never,
      () => ({ serverId: "server-1", userId: "user-1" }),
    );
    const device = await authentication.authenticateCookie(`seeing_stone_device=${record.deviceId}.${"x".repeat(43)}`);
    const session = authentication.issueSession(device.deviceId);
    const commandId = "6f084a65-2a40-41cb-a627-a4ef3ce40bbb";
    expect(authentication.acceptCommand(device.deviceId, {
      sessionEpoch: session.sessionEpoch,
      sequence: session.nextSequence,
      commandId,
    }, session.csrfToken)).toBe(true);
    expect(authentication.acceptCommand(device.deviceId, {
      sessionEpoch: session.sessionEpoch,
      sequence: session.nextSequence,
      commandId,
    }, session.csrfToken)).toBe(false);
    expect(() => authentication.acceptCommand(device.deviceId, {
      sessionEpoch: session.sessionEpoch,
      sequence: session.nextSequence,
      commandId: "73978915-594d-48b8-82e5-d44d5a8ba3ef",
    }, "wrong")).toThrowError(/refresh/i);
    expect(authentication.consumeWebSocketTicket(device.deviceId, `seeing-stone.v2.${session.webSocketTicket}`)).toBe(true);
    expect(authentication.consumeWebSocketTicket(device.deviceId, `seeing-stone.v2.${session.webSocketTicket}`)).toBe(false);
  });

  it("rejects raw player DTO fields and malformed sanitized output", () => {
    expect(() => assertNoCompanionForbiddenFields({ media: { accessToken: "secret" } })).toThrowError("COMPANION_FORBIDDEN_FIELD");
    expect(() => assertNoCompanionForbiddenFields({ MediaSources: [] })).toThrowError("COMPANION_FORBIDDEN_FIELD");
    expect(companionPlayerStateSchema.safeParse({ protocolVersion: 1, AccessToken: "secret" }).success).toBe(false);
  });
});
