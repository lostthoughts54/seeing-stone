import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { AppError } from "./errors";

export interface MediaProbeRuntime {
  executable: string;
}

export interface MediaProbeResult {
  actualSize: number;
  container: string | null;
}

export class MediaProbeService {
  constructor(
    private readonly runtime: MediaProbeRuntime | null,
    private readonly timeoutMilliseconds = 30000,
  ) {}

  async probe(storageRoot: string, localPath: string, signal?: AbortSignal): Promise<MediaProbeResult> {
    const root = resolve(storageRoot);
    const target = resolve(localPath);
    const child = relative(root, target);
    if (!isAbsolute(storageRoot) || !isAbsolute(localPath) || !child || child.startsWith("..") || isAbsolute(child)) {
      throw new AppError("INVALID_LOCAL_PATH", "The local media file is outside the authorized download storage.", 400);
    }
    const file = await stat(target).catch(() => null);
    if (!file?.isFile() || !Number.isSafeInteger(file.size) || file.size <= 0) {
      throw new AppError("MEDIA_PROBE_FAILED", "The downloaded media file is missing or empty.", 422);
    }
    if (signal?.aborted) throw new AppError("DOWNLOAD_CANCELLED", "The media check was cancelled.", 409);
    if (!this.runtime) {
      throw new AppError("MEDIA_PROBE_UNAVAILABLE", "The downloaded media file could not be validated.", 503);
    }
    const runtime = this.runtime;

    await new Promise<void>((resolveProbe, rejectProbe) => {
      const process = spawn(runtime.executable, [
        "--no-config",
        "--terminal=no",
        "--msg-level=all=no",
        "--force-window=no",
        "--vo=null",
        "--ao=null",
        "--frames=1",
        "--idle=no",
        "--",
        target,
      ], {
        windowsHide: true,
        stdio: "ignore",
      });
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error) rejectProbe(error);
        else resolveProbe();
      };
      const onAbort = (): void => {
        process.kill();
        finish(new AppError("DOWNLOAD_CANCELLED", "The media check was cancelled.", 409));
      };
      const timer = setTimeout(() => {
        process.kill();
        finish(new AppError("MEDIA_PROBE_TIMEOUT", "The downloaded media file took too long to validate.", 422));
      }, this.timeoutMilliseconds);
      signal?.addEventListener("abort", onAbort, { once: true });
      process.once("error", () => finish(new AppError("MEDIA_PROBE_UNAVAILABLE", "The downloaded media file could not be validated.", 503)));
      process.once("exit", (code) => finish(code === 0
        ? undefined
        : new AppError("MEDIA_PROBE_FAILED", "The downloaded file is not usable media.", 422)));
    });

    const extension = extname(target).slice(1).toLocaleLowerCase("en-US");
    return { actualSize: file.size, container: extension || null };
  }
}
