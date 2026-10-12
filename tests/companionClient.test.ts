import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanionRequestError, getSession, longPoll, sendCommand, type RuntimeSession } from "../src/companion/api";

function session(): RuntimeSession {
  return {
    sessionEpoch: "epoch", csrfToken: "csrf", nextSequence: 0,
    bootstrap: { player: { playbackId: "original-playback" } },
  } as RuntimeSession;
}

function response(value: unknown = {}, status = 200): Response {
  return { ok: status < 400, status, json: async () => value } as Response;
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Companion phone requests", () => {
  it("distinguishes revoked pairing from temporary network failures", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ error: { message: "Pair this phone again." } }, 401));
    vi.stubGlobal("fetch", fetch);
    await expect(getSession()).rejects.toMatchObject({ name: "CompanionRequestError", status: 401, message: "Pair this phone again." });
    fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(getSession()).rejects.not.toBeInstanceOf(CompanionRequestError);
  });

  it("bounds a stalled request and releases its timer on success", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_path, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const result = expect(getSession()).rejects.toThrow("took too long");
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(vi.getTimerCount()).toBe(0);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
    await getSession();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows the server's 25-second long poll to complete", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_path, init) => new Promise<Response>((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      setTimeout(() => resolve(response({ protocolVersion: 3 })), 25_000);
    }));
    vi.stubGlobal("fetch", fetch);
    const poll = longPoll();
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(poll).resolves.toEqual({ protocolVersion: 3 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends rapid commands in order and preserves their original playback target", async () => {
    const resolvers: Array<(value: Response) => void> = [];
    const fetch = vi.fn(() => new Promise<Response>((resolve) => resolvers.push(resolve)));
    vi.stubGlobal("fetch", fetch);
    const runtime = session();
    const first = sendCommand(runtime, { type: "set-volume", volume: 20 });
    const second = sendCommand(runtime, { type: "seek-relative", seconds: 30 });
    runtime.bootstrap.player.playbackId = "replacement-playback";
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    resolvers[0](response());
    await first;
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    resolvers[1](response());
    await second;
    const commands = fetch.mock.calls.map((call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string));
    expect(commands.map((command) => command.sequence)).toEqual([0, 1]);
    expect(commands.map((command) => command.playbackId)).toEqual(["original-playback", "original-playback"]);
    expect(commands[0].commandId).not.toBe(commands[1].commandId);
  });

  it("does not strand later controls after a rejected command", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ error: { message: "Item changed." } }, 409)).mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetch);
    const runtime = session();
    const first = sendCommand(runtime, { type: "stop" });
    const second = sendCommand(runtime, { type: "set-volume", volume: 30 });
    await expect(first).rejects.toThrow("Item changed.");
    await expect(second).resolves.toEqual({});
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
