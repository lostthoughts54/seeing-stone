import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectLibMpvRuntime, libMpvRuntimeDirectory } from "../src/main/services/libMpvRuntime";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

describe("libmpv runtime detection", () => {
  it("reports the checked-in exact-hash runtime as available after the real-video gate", async () => {
    await expect(detectLibMpvRuntime({
      manifestPath: join(process.cwd(), "mpv-runtime.json"),
      runtimeDirectory: join(process.cwd(), ".runtime", "libmpv"),
    })).resolves.toMatchObject({
      available: true,
      reason: null,
      clientApiVersion: "2.5",
      renderApi: "opengl-angle",
      artifacts: {
        libraryPath: join(process.cwd(), ".runtime", "libmpv", "libmpv-2.dll"),
        nativeAddonPath: join(process.cwd(), ".runtime", "libmpv", "seeing_stone_libmpv_bridge.node"),
      },
    });
  }, 15_000);

  it("keeps development and packaged libmpv artifacts in a dedicated controlled directory", () => {
    expect(libMpvRuntimeDirectory({ packaged: true, resourcesPath: "C:\\app\\resources", moduleDirectory: "ignored" }))
      .toBe(join("C:\\app\\resources", "libmpv"));
    expect(libMpvRuntimeDirectory({ packaged: false, resourcesPath: "ignored", moduleDirectory: join(process.cwd(), "dist", "main") }))
      .toBe(join(process.cwd(), ".runtime", "libmpv"));
  });

  it("rejects malformed manifests and traversal filenames", async () => {
    const root = await mkdtemp(join(tmpdir(), "seeing-stone-libmpv-manifest-"));
    const manifestPath = join(root, "runtime.json");
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 3, libmpv: { status: "ready", library: { filename: "../bad.dll" } } }));
    await expect(detectLibMpvRuntime({ manifestPath, runtimeDirectory: root })).resolves.toMatchObject({
      available: false,
      reason: "manifest-invalid",
    });
  });

  it("verifies only manifest-named runtime artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "seeing-stone-libmpv-ready-"));
    await mkdir(join(root, "runtime"));
    const runtime = join(root, "runtime");
    await writeFile(join(runtime, "custom-mpv.dll"), "library");
    await writeFile(join(runtime, "seeing-stone-libmpv.node"), "addon");
    const manifestPath = join(root, "runtime.json");
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 3,
      libmpv: {
        status: "ready",
        realVideoGatePassed: true,
        library: { filename: "custom-mpv.dll", sha256: digest("library") },
        clientApiVersion: "2.3",
        requiredSymbols: ["mpv_create", "mpv_render_context_create"],
        companionDlls: [],
        renderBackends: ["opengl", "software"],
        nativeAddon: { filename: "seeing-stone-libmpv.node", sha256: digest("addon") },
        build: {
          sourceRevision: "a".repeat(40),
          sourceArchiveUrl: "https://example.invalid/mpv.tar.gz",
          sourceArchiveSha256: "b".repeat(64),
          configuration: ["-Dlibmpv=true"],
          toolchain: { compiler: "fixture" },
          correspondingSource: "sources/mpv.tar.gz",
        },
      },
    }));
    const result = await detectLibMpvRuntime({ manifestPath, runtimeDirectory: runtime });
    expect(result).toMatchObject({ available: true, clientApiVersion: "2.3", renderApi: "opengl-angle" });
    expect(result.artifacts?.libraryPath).toBe(join(runtime, "custom-mpv.dll"));
  });
});
