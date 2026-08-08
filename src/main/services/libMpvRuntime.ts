import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { LibMpvCapabilityReason, LibMpvHostCapability } from "./libMpvHost";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const controlledFilenameSchema = z.string().min(1).max(128).refine((value) => basename(value) === value && !isAbsolute(value), {
  message: "Artifact names must be plain filenames.",
});

const artifactSchema = z.object({
  filename: controlledFilenameSchema,
  sha256: sha256Schema,
}).strict();

const libMpvNotBuiltSchema = z.object({
  status: z.literal("not-built"),
  reason: z.literal("render-gate-not-passed"),
}).strict();

const libMpvReadySchema = z.object({
  status: z.literal("ready"),
  realVideoGatePassed: z.boolean(),
  library: artifactSchema,
  clientApiVersion: z.string().regex(/^\d+\.\d+$/),
  requiredSymbols: z.array(z.string().regex(/^mpv_[a-z0-9_]+$/)).min(1),
  companionDlls: z.array(artifactSchema),
  renderBackends: z.array(z.enum(["opengl", "software"])).min(1),
  nativeAddon: artifactSchema,
  build: z.object({
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
    sourceArchiveUrl: z.string().url(),
    sourceArchiveSha256: sha256Schema,
    configuration: z.array(z.string().min(1)),
    toolchain: z.record(z.string(), z.string().min(1)),
    correspondingSource: z.string().min(1),
  }).strict(),
}).strict();

const runtimeManifestSchema = z.object({
  schemaVersion: z.number().int().min(4),
  runtimeFamily: z.literal("controlled-source-built-libmpv"),
  mediaProbe: z.object({
    role: z.literal("headless-media-probe"),
    playbackEngine: z.literal(false),
    executable: artifactSchema,
  }).strict(),
  libmpv: z.union([libMpvNotBuiltSchema, libMpvReadySchema]),
}).passthrough();

export interface LibMpvRuntimeDetection extends LibMpvHostCapability {
  /** Main-process-only controlled paths. */
  artifacts?: {
    libraryPath: string;
    nativeAddonPath: string;
    companionPaths: string[];
  };
}

function unavailable(reason: LibMpvCapabilityReason): LibMpvRuntimeDetection {
  return { available: false, reason, clientApiVersion: null, renderApi: null };
}

function controlledPath(root: string, filename: string): string | null {
  const candidate = resolve(root, filename);
  const traversal = relative(root, candidate);
  return traversal === filename && !traversal.startsWith("..") && !isAbsolute(traversal) ? candidate : null;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function verifyArtifact(
  root: string,
  artifact: z.infer<typeof artifactSchema>,
  missingReason: LibMpvCapabilityReason,
  hashReason: LibMpvCapabilityReason,
): Promise<{ path?: string; reason?: LibMpvCapabilityReason }> {
  const path = controlledPath(root, artifact.filename);
  if (!path) return { reason: "manifest-invalid" };
  try {
    if (await sha256(path) !== artifact.sha256) return { reason: hashReason };
    return { path };
  } catch {
    return { reason: missingReason };
  }
}

/**
 * Validates controlled artifacts only. Symbol/ABI/graphics probing is performed
 * later by the native bridge and can only narrow this capability.
 */
export async function detectLibMpvRuntime(options: {
  manifestPath: string;
  runtimeDirectory: string;
}): Promise<LibMpvRuntimeDetection> {
  let manifest: z.infer<typeof runtimeManifestSchema>;
  try {
    manifest = runtimeManifestSchema.parse(JSON.parse(await readFile(options.manifestPath, "utf8")));
  } catch {
    return unavailable("manifest-invalid");
  }
  if (manifest.libmpv.status === "not-built") return unavailable(manifest.libmpv.reason);
  if (!manifest.libmpv.realVideoGatePassed) return unavailable("render-gate-not-passed");
  if (!manifest.libmpv.renderBackends.includes("opengl")) return unavailable("graphics-capability-unavailable");

  const root = resolve(options.runtimeDirectory);
  const library = await verifyArtifact(root, manifest.libmpv.library, "library-missing", "library-hash-mismatch");
  if (library.reason || !library.path) return unavailable(library.reason ?? "library-missing");
  const addon = await verifyArtifact(root, manifest.libmpv.nativeAddon, "native-addon-unavailable", "library-hash-mismatch");
  if (addon.reason || !addon.path) return unavailable(addon.reason ?? "native-addon-unavailable");
  const companionPaths: string[] = [];
  for (const companion of manifest.libmpv.companionDlls) {
    const result = await verifyArtifact(root, companion, "companion-missing", "companion-hash-mismatch");
    if (result.reason || !result.path) return unavailable(result.reason ?? "companion-missing");
    companionPaths.push(result.path);
  }
  return {
    available: true,
    reason: null,
    clientApiVersion: manifest.libmpv.clientApiVersion,
    renderApi: "opengl-angle",
    artifacts: { libraryPath: library.path, nativeAddonPath: addon.path, companionPaths },
  };
}

/**
 * Resolves the source-built mpv command-line player only for headless media
 * validation. It is deliberately separate from the libmpv playback capability.
 */
export async function detectMediaProbeRuntime(options: {
  manifestPath: string;
  runtimeDirectory: string;
}): Promise<{ executable: string } | null> {
  let manifest: z.infer<typeof runtimeManifestSchema>;
  try {
    manifest = runtimeManifestSchema.parse(JSON.parse(await readFile(options.manifestPath, "utf8")));
  } catch {
    return null;
  }
  const verified = await verifyArtifact(
    resolve(options.runtimeDirectory),
    manifest.mediaProbe.executable,
    "library-missing",
    "library-hash-mismatch",
  );
  return verified.path ? { executable: verified.path } : null;
}

export function libMpvManifestPath(options: {
  packaged: boolean;
  resourcesPath: string;
  moduleDirectory: string;
}): string {
  return options.packaged
    ? join(options.resourcesPath, "libmpv", "runtime-manifest.json")
    : resolve(dirname(options.moduleDirectory), "../libmpv-runtime.json");
}

export function libMpvRuntimeDirectory(options: {
  packaged: boolean;
  resourcesPath: string;
  moduleDirectory: string;
}): string {
  return options.packaged
    ? join(options.resourcesPath, "libmpv")
    : resolve(dirname(options.moduleDirectory), "../.runtime/libmpv");
}
