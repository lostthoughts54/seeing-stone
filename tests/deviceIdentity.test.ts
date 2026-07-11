import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DeviceIdentityService } from "../src/main/services/deviceIdentity";

describe("DeviceIdentityService", () => {
  it("creates one UUID concurrently and preserves it across restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lf-identity-"));
    const service = new DeviceIdentityService(directory, "Windows Desktop", "Client", "1.0.0");
    const results = await Promise.all([service.get(), service.get(), service.get()]);
    expect(new Set(results.map((value) => value.deviceId)).size).toBe(1);
    expect(results[0].deviceId).toMatch(/^[0-9a-f-]{36}$/i);

    const restarted = await new DeviceIdentityService(directory, "Windows Desktop", "Client", "1.0.1").get();
    expect(restarted.deviceId).toBe(results[0].deviceId);
    expect(restarted.clientVersion).toBe("1.0.1");
  });

  it("recovers a corrupt identity without exposing it to renderer state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lf-identity-"));
    await writeFile(join(directory, "device-identity.json"), "not-json");
    const identity = await new DeviceIdentityService(directory, "Windows Desktop", "Client", "1.0.0").get();
    expect(identity.deviceId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.parse(await readFile(join(directory, "device-identity.json"), "utf8")).deviceId).toBe(identity.deviceId);
  });
});
