import { describe, expect, it, vi } from "vitest";
import { registerIpcHandlers } from "../src/main/ipc";
import { IPC } from "../src/shared/contracts";

type RegisteredHandler = (event: unknown, input?: unknown) => Promise<unknown>;

function createHarness() {
  const handlers = new Map<string, RegisteredHandler>();
  const frame = { url: "app://bundle/index.html" };
  const webContents = {
    mainFrame: frame,
    isDestroyed: () => false,
  };
  const window = {
    webContents,
    isDestroyed: () => false,
  };
  const ipcMain = {
    handle(channel: string, handler: RegisteredHandler) { handlers.set(channel, handler); },
  };
  const login = vi.fn(async () => ({ authenticated: true, persistence: "memory-only", server: null, user: null }));
  const getSafeSession = vi.fn(() => ({ authenticated: false, persistence: "none", server: null, user: null }));
  const api = {
    connect: vi.fn(),
    login,
    restore: vi.fn(),
    getSafeSession,
    logout: vi.fn(),
    getHome: vi.fn(),
    getLibraries: vi.fn(),
    getLibraryItems: vi.fn(),
    search: vi.fn(),
    getDetails: vi.fn(),
    openTrailer: vi.fn(),
    getSeasons: vi.fn(),
    getEpisodes: vi.fn(),
    getMediaSourceCapabilities: vi.fn(),
  };
  const artwork = { clear: vi.fn(), getUrl: vi.fn() };
  const playback = { clear: vi.fn(), start: vi.fn(), stop: vi.fn(), getState: vi.fn() };
  registerIpcHandlers(ipcMain as never, window as never, api as never, artwork as never, playback as never);
  const validEvent = { sender: webContents, senderFrame: frame };
  return { handlers, frame, webContents, window, api, artwork, playback, login, getSafeSession, validEvent };
}

describe("IPC authorization and allowlist", () => {
  it("registers exactly the declared narrow channels and no reporting transport", () => {
    const { handlers } = createHarness();
    expect([...handlers.keys()].sort()).toEqual([...Object.values(IPC)].sort());
    expect([...handlers.keys()].join(" ")).not.toMatch(/report|sessions\/playing|request|fetch|filesystem|shell|command/i);
  });

  it("allows the production main frame and rejects extra privileged fields before service invocation", async () => {
    const { handlers, validEvent, login, getSafeSession } = createHarness();
    await expect(handlers.get(IPC.sessionGetState)?.(validEvent)).resolves.toEqual({
      ok: true,
      data: { authenticated: false, persistence: "none", server: null, user: null },
    });
    expect(getSafeSession).toHaveBeenCalledOnce();

    const result = await handlers.get(IPC.sessionLogin)?.(validEvent, {
      connectionId: "11111111-1111-4111-8111-111111111111",
      username: "Viewer",
      password: "password",
      remember: true,
      serverUrl: "http://127.0.0.1:8096",
      headers: { Authorization: "SECRET_TOKEN_SENTINEL" },
      command: "mpv.exe",
      args: ["--script=unsafe"],
      path: "D:\\Sensitive Folder\\movie.mkv",
    }) as { ok: boolean; error?: { message: string } };
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN_SENTINEL");
    expect(JSON.stringify(result)).not.toContain("Sensitive Folder");
    expect(login).not.toHaveBeenCalled();
  });

  it("rejects foreign windows, subframes, wrong origins, and destroyed windows", async () => {
    const { handlers, frame, webContents, window, getSafeSession } = createHarness();
    const invoke = handlers.get(IPC.sessionGetState)!;
    const foreign = await invoke({ sender: { mainFrame: frame }, senderFrame: frame });
    const subframe = await invoke({ sender: webContents, senderFrame: { url: "app://bundle/frame.html" } });
    frame.url = "https://attacker.invalid/";
    const wrongOrigin = await invoke({ sender: webContents, senderFrame: frame });
    frame.url = "app://bundle/index.html";
    window.isDestroyed = () => true;
    const destroyed = await invoke({ sender: webContents, senderFrame: frame });
    for (const result of [foreign, subframe, wrongOrigin, destroyed]) {
      expect(result).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED_IPC", retryable: false } });
    }
    expect(getSafeSession).not.toHaveBeenCalled();
  });
});
