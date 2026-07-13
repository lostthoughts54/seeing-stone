import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveVerifiedPersistenceWorkerPath } from "../src/main/services/persistenceWorkerIntegrity";

describe("packaged persistence worker integrity", () => {
  it("accepts only worker modules matching the protected manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "lf-worker-integrity-"));
    const moduleDirectory = join(root, "app.asar", "dist", "main");
    const services = join(root, "resources", "app.asar.unpacked", "dist", "main", "services");
    await mkdir(join(moduleDirectory, "services"), { recursive: true });
    await mkdir(services, { recursive: true });
    const files = {
      "persistenceWorker.js": "worker bytes",
      "persistenceTypes.js": "types bytes",
    };
    for (const [file, bytes] of Object.entries(files)) await writeFile(join(services, file), bytes);
    await writeFile(join(moduleDirectory, "services", "persistence-worker-integrity.json"), JSON.stringify({
      schemaVersion: 1,
      algorithm: "sha256",
      files: Object.fromEntries(Object.entries(files).map(([file, bytes]) => [
        file,
        createHash("sha256").update(bytes).digest("hex"),
      ])),
    }));

    await expect(resolveVerifiedPersistenceWorkerPath(join(root, "resources"), moduleDirectory))
      .resolves.toBe(join(services, "persistenceWorker.js"));

    await writeFile(join(services, "persistenceWorker.js"), "tampered worker bytes");
    await expect(resolveVerifiedPersistenceWorkerPath(join(root, "resources"), moduleDirectory))
      .rejects.toMatchObject({ code: "PERSISTENCE_INTEGRITY_FAILED" });
    expect(await readFile(join(services, "persistenceTypes.js"), "utf8")).toBe("types bytes");
  });
});
