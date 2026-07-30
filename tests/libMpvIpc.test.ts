import { describe, expect, it, vi } from "vitest";
import { LibMpvCommandClient } from "../src/main/services/libMpvIpc";
import type { LibMpvHostCommand, LibMpvSession } from "../src/main/services/libMpvHost";

describe("LibMpvCommandClient", () => {
  it("maps the shared controller command vocabulary onto the narrow host contract", async () => {
    const commands: LibMpvHostCommand[] = [];
    let stopped = 0;
    const session: LibMpvSession = {
      generation: { playback: 1, surface: 1 },
      command: async (command) => { commands.push(command); },
      query: async (property) => property === "duration" ? 12.5 : null,
      updateViewport: () => undefined,
      stop: async () => { stopped += 1; },
    };
    const client = new LibMpvCommandClient(session, () => () => undefined);

    expect(await client.command(["get_property", "duration"])).toBe(12.5);
    await client.command(["set_property", "pause", true]);
    await client.command(["seek", 3.25, "absolute+exact"]);
    await client.command(["set_property", "volume", 72]);
    await client.command(["set_property", "aid", 4]);
    await client.command(["set_property", "sid", "no"]);
    await client.command(["loadfile", "C:\\media\\next.mkv", "replace"]);
    await client.command(["quit"]);

    expect(commands).toEqual([
      { kind: "pause" },
      { kind: "seek", positionTicks: 32_500_000 },
      { kind: "volume", volume: 72 },
      { kind: "select-audio", trackId: 4 },
      { kind: "select-subtitle", trackId: null },
      { kind: "load", source: { location: "C:\\media\\next.mkv" } },
    ]);
    expect(stopped).toBe(1);
    client.close();
  });

  it("emits bounded property changes without duplicating unchanged values", async () => {
    vi.useFakeTimers();
    let value = 1;
    const session: LibMpvSession = {
      generation: { playback: 1, surface: 1 },
      command: async () => undefined,
      query: async () => value,
      updateViewport: () => undefined,
      stop: async () => undefined,
    };
    const client = new LibMpvCommandClient(session, () => () => undefined);
    const messages: unknown[] = [];
    client.onMessage((message) => messages.push(message));
    await client.observe(1, "time-pos");
    await vi.advanceTimersByTimeAsync(200);
    value = 2;
    await vi.advanceTimersByTimeAsync(100);
    expect(messages).toEqual([
      { event: "property-change", name: "time-pos", data: 1 },
      { event: "property-change", name: "time-pos", data: 2 },
    ]);
    client.close();
    vi.useRealTimers();
  });
});
