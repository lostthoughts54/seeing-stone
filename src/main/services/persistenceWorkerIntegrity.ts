import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "./errors";

const workerFiles = ["persistenceWorker.js", "persistenceTypes.js"] as const;

interface WorkerIntegrityManifest {
  schemaVersion: 1;
  algorithm: "sha256";
  files: Record<(typeof workerFiles)[number], string>;
}

export async function resolveVerifiedPersistenceWorkerPath(
  resourcesPath: string,
  moduleDirectory: string,
): Promise<string> {
  try {
    const manifest = parseManifest(JSON.parse(await readFile(
      join(moduleDirectory, "services", "persistence-worker-integrity.json"),
      "utf8",
    )));
    const unpackedDirectory = join(resourcesPath, "app.asar.unpacked", "dist", "main", "services");
    for (const file of workerFiles) {
      const bytes = await readFile(join(unpackedDirectory, file));
      const actual = createHash("sha256").update(bytes).digest();
      const expected = Buffer.from(manifest.files[file], "hex");
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error("mismatch");
    }
    return join(unpackedDirectory, "persistenceWorker.js");
  } catch {
    throw new AppError(
      "PERSISTENCE_INTEGRITY_FAILED",
      "The packaged persistence worker failed integrity verification.",
      503,
    );
  }
}

function parseManifest(value: unknown): WorkerIntegrityManifest {
  if (!value || typeof value !== "object") throw new Error("invalid");
  const candidate = value as Partial<WorkerIntegrityManifest>;
  if (candidate.schemaVersion !== 1 || candidate.algorithm !== "sha256" || !candidate.files || typeof candidate.files !== "object") {
    throw new Error("invalid");
  }
  const keys = Object.keys(candidate.files).sort();
  if (keys.length !== workerFiles.length || keys.some((key, index) => key !== [...workerFiles].sort()[index])) throw new Error("invalid");
  for (const file of workerFiles) {
    if (!/^[0-9a-f]{64}$/.test(candidate.files[file] ?? "")) throw new Error("invalid");
  }
  return candidate as WorkerIntegrityManifest;
}
