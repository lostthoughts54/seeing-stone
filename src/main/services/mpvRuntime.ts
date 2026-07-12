import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppError } from "./errors";

export interface MpvRuntimePaths {
  executable: string;
  inputConfig: string;
}

export async function resolveMpvRuntime(options: {
  packaged: boolean;
  resourcesPath: string;
  moduleDirectory: string;
}): Promise<MpvRuntimePaths> {
  const root = options.packaged
    ? join(options.resourcesPath, "mpv")
    : resolve(options.moduleDirectory, "../../.runtime/mpv");
  const inputConfig = options.packaged
    ? join(options.resourcesPath, "mpv", "input.conf")
    : resolve(options.moduleDirectory, "../../assets/mpv/input.conf");
  const executable = join(root, "mpv.exe");
  try {
    await Promise.all([access(executable), access(inputConfig)]);
  } catch {
    throw new AppError("MPV_UNAVAILABLE", "The bundled mpv runtime is unavailable. Run the pinned runtime setup before playback.", 503);
  }
  return { executable, inputConfig };
}
