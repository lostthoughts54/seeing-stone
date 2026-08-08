import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Windows release packaging boundary", () => {
  it("builds a current x64 NSIS artifact with only controlled runtime resources", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
      dependencies: Record<string, string>;
    };
    const config = await readFile("electron-builder.yml", "utf8");

    expect(packageJson.scripts["package:windows"]).not.toContain("pnpm run setup:mpv");
    expect(packageJson.scripts["package:windows"]).toContain("pnpm run build");
    expect(packageJson.scripts["package:windows"]).toContain("pnpm run generate:worker-integrity");
    expect(packageJson.scripts["package:windows"]).toContain("electron-builder --win nsis --x64");
    expect(packageJson.devDependencies["electron-builder"]).toBe("26.15.3");
    expect(packageJson.devDependencies["@electron/fuses"]).toBe("2.1.2");
    expect(packageJson.dependencies.ws).toBe("8.18.3");

    expect(config).toContain("appId: app.seeingstone.client");
    expect(config).toContain("asar: true");
    expect(config).toContain('!dist/**/*.map');
    expect(config).toContain("dist/main/services/persistenceWorker.js");
    expect(config).toContain("dist/main/services/persistenceTypes.js");
    expect(config).not.toContain("from: .runtime/mpv");
    expect(config).toContain("from: assets/mpv/licenses");
    expect(config).toContain("from: libmpv-runtime.json");
    expect(config).toContain("to: libmpv/runtime-manifest.json");
    expect(config).toContain('      - "mpv.exe"');
    expect(config).toContain("target: nsis");
    expect(config).toContain("- x64");
    expect(config).not.toContain("electronFuses:");
  });

  it("uses an explicit unpacked worker path and hardens every Electron 43 fuse", async () => {
    const main = await readFile("src/main/index.ts", "utf8");
    const persistence = await readFile("src/main/services/persistence.ts", "utf8");
    const workerIntegrity = await readFile("src/main/services/persistenceWorkerIntegrity.ts", "utf8");
    const hook = await readFile("scripts/after-pack.cjs", "utf8");

    expect(main).toContain("await resolveVerifiedPersistenceWorkerPath(process.resourcesPath, __dirname)");
    expect(main).toContain('app.isPackaged ? "libmpv" : "embedded"');
    expect(main).toContain('packagedProduction ? "libmpv" : undefined');
    expect(main).toContain("createUnavailableRoute()");
    expect(persistence).toContain("new Worker(this.workerPath");
    expect(workerIntegrity).toContain('"persistence-worker-integrity.json"');
    expect(workerIntegrity).toContain('createHash("sha256")');
    expect(workerIntegrity).toContain("timingSafeEqual(expected, actual)");
    expect(hook).toContain("strictlyRequireAllFuses: true");
    for (const fuse of [
      "RunAsNode",
      "EnableCookieEncryption",
      "EnableNodeOptionsEnvironmentVariable",
      "EnableNodeCliInspectArguments",
      "EnableEmbeddedAsarIntegrityValidation",
      "OnlyLoadAppFromAsar",
      "LoadBrowserProcessSpecificV8Snapshot",
      "GrantFileProtocolExtraPrivileges",
      "WasmTrapHandlers",
    ]) {
      expect(hook).toContain(`FuseV1Options.${fuse}`);
    }
  });

  it("packages only the staged, validated libmpv native closure for stable builds", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const config = await readFile("electron-builder.yml", "utf8");
    const releaseGate = await readFile("scripts/validate-libmpv-release.mjs", "utf8");

    expect(config).toContain("from: .runtime/libmpv");
    expect(config).toContain("to: libmpv");
    expect(config).toContain('"*.dll"');
    expect(config).toContain('"*.node"');
    expect(config).toContain('"mpv.exe"');
    expect(packageJson.scripts["package:windows"]).toContain("stage:libmpv-runtime");
    expect(packageJson.scripts["package:windows:dir"]).toContain("validate:libmpv-package");
    expect(packageJson.scripts["validate:libmpv-release"]).toBe("node scripts/validate-libmpv-release.mjs");
    expect(releaseGate).toContain("LIBMPV_PUBLIC_RELEASE_NO_GO");
    expect(releaseGate).toContain("dependency-provenance.json");
    expect(releaseGate).toContain("public-release-acceptance.json");
    expect(releaseGate).toContain("release-sources/libmpv");
  });

  it("keeps synthetic Live TV channels out of every installer", async () => {
    const stableConfig = await readFile("electron-builder.yml", "utf8");
    const internalConfig = await readFile("electron-builder.libmpv-test.yml", "utf8");
    const provenanceGate = await readFile("scripts/validate-package-provenance.mjs", "utf8");

    expect(stableConfig).not.toContain("assets/fixtures/live-tv");
    expect(internalConfig).not.toContain("assets/fixtures/live-tv");
    expect(provenanceGate).toContain('"assets/fixtures/live-tv/"');
  });

  it("provides a separate self-contained internal libmpv acceptance package", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const config = await readFile("electron-builder.libmpv-test.yml", "utf8");
    const acceptance = await readFile("scripts/libmpv-package-acceptance.cjs", "utf8");

    expect(packageJson.scripts["package:windows:libmpv-test"]).toContain("stage:libmpv-runtime");
    expect(packageJson.scripts["package:windows:libmpv-test"]).toContain("validate:libmpv-test-package");
    expect(packageJson.scripts["package:windows:libmpv-test"]).not.toContain("build:libmpv-native");
    expect(config).toContain("app.seeingstone.client.libmpv-test");
    expect(config).toContain("Seeing Stone Libmpv Test");
    expect(config).toContain("from: .runtime/libmpv");
    expect(config).toContain('      - "*.dll"');
    expect(config).toContain('      - "*.node"');
    expect(acceptance).toContain("player-engine-status.json");
    expect(acceptance).toContain("--resources=");
    expect(acceptance).toContain('assert.equal(diagnostics.active, "libmpv")');
    expect(acceptance).toContain("libmpv-test-acceptance.json");
    expect(acceptance).toContain(".sha256.txt");
  });

  it("recreates verified mpv inputs only inside the workspace", async () => {
    const setup = await readFile("scripts/setup-mpv.ps1", "utf8");
    expect(setup).toContain("legacy-mpv-runtime.json");
    expect(setup).toContain("Get-FileHash -Algorithm SHA256");
    expect(setup).toContain("Refusing to replace an mpv runtime outside the project workspace.");
    expect(setup).toContain("Remove-Item -LiteralPath $runtimePath -Recurse -Force");
  });
});
