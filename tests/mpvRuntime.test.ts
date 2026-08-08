import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMpvRuntime } from "../src/main/services/mpvRuntime";

describe("mpv runtime resolution", () => {
  it("uses only the app-owned development or packaged runtime layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "localfirst-mpv-runtime-"));
    try {
      const moduleDirectory = join(root, "dist", "main");
      const developmentRuntime = join(root, ".runtime", "mpv");
      const developmentAssets = join(root, "assets", "mpv");
      await Promise.all([
        mkdir(moduleDirectory, { recursive: true }),
        mkdir(developmentRuntime, { recursive: true }),
        mkdir(developmentAssets, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(developmentRuntime, "mpv.exe"), "runtime"),
        writeFile(join(developmentAssets, "input.conf"), "ESC quit"),
        writeFile(join(developmentAssets, "progressive-input.conf"), "LEFT script-message jellyfin-seek-relative -10"),
      ]);
      await expect(resolveMpvRuntime({ packaged: false, resourcesPath: "unused", moduleDirectory })).resolves.toEqual({
        executable: join(developmentRuntime, "mpv.exe"),
        inputConfig: join(developmentAssets, "input.conf"),
        progressiveInputConfig: join(developmentAssets, "progressive-input.conf"),
      });

      const packagedRuntime = join(root, "resources", "mpv");
      await mkdir(packagedRuntime, { recursive: true });
      await Promise.all([
        writeFile(join(packagedRuntime, "mpv.exe"), "runtime"),
        writeFile(join(packagedRuntime, "input.conf"), "ESC quit"),
        writeFile(join(packagedRuntime, "progressive-input.conf"), "LEFT script-message jellyfin-seek-relative -10"),
      ]);
      await expect(resolveMpvRuntime({ packaged: true, resourcesPath: join(root, "resources"), moduleDirectory })).resolves.toEqual({
        executable: join(packagedRuntime, "mpv.exe"),
        inputConfig: join(packagedRuntime, "input.conf"),
        progressiveInputConfig: join(packagedRuntime, "progressive-input.conf"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never falls back to a PATH executable", async () => {
    await expect(resolveMpvRuntime({
      packaged: false,
      resourcesPath: "unused",
      moduleDirectory: join(tmpdir(), "missing-localfirst", "dist", "main"),
    })).rejects.toMatchObject({ code: "MPV_UNAVAILABLE" });
  });
});
