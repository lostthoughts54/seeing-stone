import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { IPC } from "../src/shared/contracts";

describe("renderer and preload security boundary", () => {
  it("exposes only the explicit bridge and no playback-report channel", async () => {
    expect(Object.keys(IPC)).not.toContain("request");
    expect(Object.values(IPC).join(" ")).not.toMatch(/report-start|report-progress|report-stop|sessions\/playing/i);
    const preload = await readFile("src/preload/index.ts", "utf8");
    expect(preload).not.toMatch(/exposeInMainWorld\([^,]+,\s*ipcRenderer/);
    expect(preload).not.toMatch(/\b(send|sendSync|on)\s*:/);
  });

  it("contains no renderer networking, token storage, Node, or privileged imports", async () => {
    const renderer = await readFile("src/renderer/app.ts", "utf8");
    expect(renderer).not.toMatch(/\bfetch\s*\(/);
    expect(renderer).not.toMatch(/localStorage|sessionStorage|accessToken|api_key|X-MediaBrowser-Token/);
    expect(renderer).not.toMatch(/from\s+["'](?:node:|electron|.*\/main\/)/);
    expect(renderer).not.toMatch(/window\.open|ipcRenderer|child_process/);
  });

  it("uses no synchronous privileged operations", async () => {
    const files = [
      "src/main/index.ts",
      "src/main/ipc.ts",
      "src/main/services/deviceIdentity.ts",
      "src/main/services/secureSession.ts",
      "src/main/services/jellyfinApi.ts",
      "src/main/services/serverDiscovery.ts",
    ];
    const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
    expect(source).not.toMatch(/readFileSync|writeFileSync|execSync|spawnSync|sendSync/);
  });

  it("pins hardened BrowserWindow settings and renderer network denial", async () => {
    const main = await readFile("src/main/index.ts", "utf8");
    for (const setting of [
      "contextIsolation: true",
      "sandbox: true",
      "nodeIntegration: false",
      "nodeIntegrationInWorker: false",
      "nodeIntegrationInSubFrames: false",
      "webSecurity: true",
      "allowRunningInsecureContent: false",
      "webviewTag: false",
      "navigateOnDragDrop: false",
    ]) expect(main).toContain(setting);
    expect(main).toContain('connect-src \'none\'');
    expect(main).toContain("setPermissionRequestHandler");
    expect(main).toContain("setPermissionCheckHandler");
    expect(main).toContain("onBeforeRequest");
    expect(main).toContain("setWindowOpenHandler");
  });
});
