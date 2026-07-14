import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DOWNLOAD_FOLDER_NAME, DownloadLocationService } from "../src/main/services/downloadLocation";

describe("DownloadLocationService", () => {
  it("uses Windows Videos by default and remembers a custom drive without exposing its path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lf-download-location-"));
    const defaultRoot = join(directory, "Videos", DOWNLOAD_FOLDER_NAME);
    const customParent = join(directory, "Larger drive");
    const service = new DownloadLocationService(join(directory, "data"), defaultRoot);

    expect(await service.getSummary()).toEqual({ mode: "default", label: "Windows Videos folder" });
    expect(await service.getActiveRoot()).toBe(resolve(defaultRoot));

    const changed = await service.chooseParent(customParent);
    const customRoot = resolve(customParent, DOWNLOAD_FOLDER_NAME);
    expect(changed.mode).toBe("custom");
    expect(JSON.stringify(changed)).not.toContain(customParent);
    expect(await service.getActiveRoot()).toBe(customRoot);
    expect(await service.getAuthorizedRoots()).toEqual(expect.arrayContaining([resolve(defaultRoot), customRoot]));

    const restarted = new DownloadLocationService(join(directory, "data"), defaultRoot);
    expect(await restarted.getActiveRoot()).toBe(customRoot);
    expect(await restarted.useDefault()).toEqual({ mode: "default", label: "Windows Videos folder" });
    expect(await restarted.getAuthorizedRoots()).toEqual(expect.arrayContaining([resolve(defaultRoot), customRoot]));
  });

  it("does not double-nest the managed folder and recovers malformed settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lf-download-location-"));
    const data = join(directory, "data");
    const defaultRoot = join(directory, "Videos", DOWNLOAD_FOLDER_NAME);
    const selectedRoot = join(directory, "Media", DOWNLOAD_FOLDER_NAME);
    const service = new DownloadLocationService(data, defaultRoot);
    await service.chooseParent(selectedRoot);
    expect(await service.getActiveRoot()).toBe(resolve(selectedRoot));

    await writeFile(join(data, "download-location.json"), "not-json", "utf8");
    const recovered = new DownloadLocationService(data, defaultRoot);
    expect(await recovered.getActiveRoot()).toBe(resolve(defaultRoot));
    expect(JSON.parse(await readFile(join(data, "download-location.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      activeRoot: null,
      authorizedRoots: [],
    });
  });
});
