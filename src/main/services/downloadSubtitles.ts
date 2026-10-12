import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { ExternalSubtitleTrack } from "../../shared/contracts";
import type { JellyfinApi } from "./jellyfinApi";
import type { LocalVersionRecord } from "./persistenceTypes";

const MAX_SUBTITLE_BYTES = 16 * 1024 * 1024;
const MANIFEST_NAME = "subtitles.json";
const trackSchema = z.object({
  streamIndex: z.number().int().nonnegative(),
  format: z.enum(["srt", "ass", "ssa", "vtt"]),
  title: z.string().max(256).nullable(),
  language: z.string().max(32).nullable(),
  isDefault: z.boolean(),
  isForced: z.boolean(),
  size: z.number().int().positive().max(MAX_SUBTITLE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const manifestSchema = z.object({
  version: z.literal(1),
  serverId: z.string(), userId: z.string(), itemId: z.string(),
  mediaSourceId: z.string(), localVersionId: z.string(),
  tracks: z.array(trackSchema).max(32),
}).strict();
type SavedTrack = z.infer<typeof trackSchema>;
type SubtitleIdentity = Pick<LocalVersionRecord, "serverId" | "userId" | "itemId" | "mediaSourceId" | "localVersionId" | "storageRoot" | "localPath">;

/** File capabilities remain in Electron main; only track metadata goes to mpv's proxy. */
export interface LocalSubtitleTrack extends ExternalSubtitleTrack {
  file: { identity: SubtitleIdentity; size: number; sha256: string };
}

export type DownloadSubtitleApi = Pick<JellyfinApi, "getMediaSourceCapabilities" | "fetchExternalSubtitle">;

function contained(root: string, target: string): boolean {
  const child = relative(root, target);
  return Boolean(child) && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(child);
}

async function directoryFor(local: SubtitleIdentity): Promise<string> {
  if (!isAbsolute(local.storageRoot) || !isAbsolute(local.localPath)
    || !contained(resolve(local.storageRoot), resolve(local.localPath))) throw new Error("SUBTITLE_PATH_INVALID");
  const [root, directory] = await Promise.all([realpath(local.storageRoot), realpath(dirname(local.localPath))]);
  if (!contained(root, directory)) throw new Error("SUBTITLE_PATH_INVALID");
  return directory;
}

function filename(track: Pick<SavedTrack, "streamIndex" | "sha256" | "format">): string {
  return `subtitle-${track.streamIndex}-${track.sha256}.${track.format}`;
}

async function readBoundedFile(directory: string, name: string, limit: number): Promise<Buffer> {
  const target = join(directory, name);
  const entry = await lstat(target);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("SUBTITLE_FILE_INVALID");
  const canonical = await realpath(target);
  if (relative(directory, dirname(canonical)) !== "") throw new Error("SUBTITLE_PATH_INVALID");
  const handle = await open(canonical, "r");
  try {
    const size = (await handle.stat()).size;
    if (size <= 0 || size > limit) throw new Error("SUBTITLE_SIZE_INVALID");
    const buffer = Buffer.alloc(size + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count !== size) throw new Error("SUBTITLE_SIZE_INVALID");
    return buffer.subarray(0, count);
  } finally { await handle.close(); }
}

function metadata(track: ExternalSubtitleTrack): ExternalSubtitleTrack {
  return { streamIndex: track.streamIndex, format: track.format, title: track.title, language: track.language, isDefault: track.isDefault, isForced: track.isForced };
}

export async function readLocalSubtitle(track: LocalSubtitleTrack, signal?: AbortSignal): Promise<Response> {
  signal?.throwIfAborted();
  const directory = await directoryFor(track.file.identity);
  const bytes = await readBoundedFile(directory, filename({ ...track, sha256: track.file.sha256 }), MAX_SUBTITLE_BYTES);
  signal?.throwIfAborted();
  if (bytes.length !== track.file.size || createHash("sha256").update(bytes).digest("hex") !== track.file.sha256) throw new Error("SUBTITLE_INTEGRITY_INVALID");
  return new Response(Uint8Array.from(bytes), { headers: { "Content-Type": track.format === "vtt" ? "text/vtt" : "text/plain", "Content-Length": String(bytes.length) } });
}

export async function getLocalSubtitles(local: SubtitleIdentity): Promise<LocalSubtitleTrack[]> {
  try {
    const directory = await directoryFor(local);
    const manifest = manifestSchema.parse(JSON.parse((await readBoundedFile(directory, MANIFEST_NAME, 64 * 1024)).toString("utf8")));
    for (const key of ["serverId", "userId", "itemId", "mediaSourceId", "localVersionId"] as const) {
      if (manifest[key] !== local[key]) return [];
    }
    const tracks: LocalSubtitleTrack[] = [];
    const seen = new Set<number>();
    for (const saved of manifest.tracks) {
      if (seen.has(saved.streamIndex)) continue;
      const track = { ...metadata(saved), file: { identity: { ...local }, size: saved.size, sha256: saved.sha256 } };
      try {
        const response = await readLocalSubtitle(track);
        await response.body?.cancel();
        tracks.push(track);
        seen.add(saved.streamIndex);
      } catch { /* A damaged sidecar never prevents video playback or other subtitles. */ }
    }
    return tracks;
  } catch { return []; }
}

async function atomicWrite(directory: string, name: string, bytes: string | Uint8Array, signal: AbortSignal): Promise<void> {
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    signal.throwIfAborted();
    await writeFile(temporary, bytes, { flag: "wx", signal });
    signal.throwIfAborted();
    await rename(temporary, join(directory, name));
  } finally { await rm(temporary, { force: true }); }
}

async function subtitleBytes(response: Response, signal: AbortSignal): Promise<Buffer> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("SUBTITLE_RESPONSE_INVALID");
  }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_SUBTITLE_BYTES) throw new Error("SUBTITLE_TOO_LARGE");
      chunks.push(chunk.value);
    }
    if (!size) throw new Error("SUBTITLE_EMPTY");
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
  }
}

/** Refresh metadata and fill missing files; successful tracks survive a partial failure. */
export async function cacheDownloadSubtitles(api: DownloadSubtitleApi, local: SubtitleIdentity, signal: AbortSignal): Promise<void> {
  if (!local.mediaSourceId) return;
  signal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  const directory = await directoryFor(local);
  const capabilities = await api.getMediaSourceCapabilities(local.itemId, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
  signal.throwIfAborted();
  if (capabilities.itemId !== local.itemId) throw new Error("SUBTITLE_IDENTITY_INVALID");
  const source = capabilities.sources.find((candidate) => candidate.id === local.mediaSourceId);
  if (!source) throw new Error("SUBTITLE_SOURCE_MISSING");
  const existing = await getLocalSubtitles(local);
  const saved: SavedTrack[] = existing.map((track) => ({ ...metadata(track), size: track.file.size, sha256: track.file.sha256 }));
  let failed = false;
  for (const track of (source.externalSubtitles ?? []).slice(0, 32)) {
    signal.throwIfAborted();
    const cached = saved.find((entry) => entry.streamIndex === track.streamIndex && entry.format === track.format);
    if (cached) {
      Object.assign(cached, metadata(track));
      continue;
    }
    try {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
      const response = await api.fetchExternalSubtitle(local.itemId, local.mediaSourceId, track.streamIndex, track.format, requestSignal);
      const bytes = await subtitleBytes(response, requestSignal);
      const entry = trackSchema.parse({ ...metadata(track), size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      await atomicWrite(directory, filename(entry), bytes, signal);
      const previous = saved.findIndex((candidate) => candidate.streamIndex === entry.streamIndex);
      if (previous >= 0) saved.splice(previous, 1);
      saved.push(entry);
    } catch {
      signal.throwIfAborted();
      failed = true;
    }
    const { serverId, userId, itemId, mediaSourceId, localVersionId } = local;
    await atomicWrite(directory, MANIFEST_NAME, JSON.stringify({ version: 1, serverId, userId, itemId, mediaSourceId, localVersionId, tracks: saved.slice(0, 32) }), signal);
  }
  const { serverId, userId, itemId, mediaSourceId, localVersionId } = local;
  await atomicWrite(directory, MANIFEST_NAME, JSON.stringify({ version: 1, serverId, userId, itemId, mediaSourceId, localVersionId, tracks: saved.slice(0, 32) }), signal);
  if (failed) throw new Error("SUBTITLE_DOWNLOAD_INCOMPLETE");
}
