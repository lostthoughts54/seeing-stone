import type { AppLogger } from "./logger";

export interface ReleaseCandidate {
  tagName: string;
  name: string | null;
  publishedAt: string | null;
  draft: boolean;
  prerelease: boolean;
}

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  releaseName: string | null;
  publishedAt: string | null;
  isUpdateAvailable: boolean;
  releasePageUrl: string | null;
  source: "automatic" | "manual";
  status: "current" | "available" | "failed";
  error?: string;
}

interface ParsedVersion { major: number; minor: number; patch: number; prerelease: Array<string | number>; }

export function parseSeeingStoneVersion(tag: string): ParsedVersion | null {
  const historicalBeta = /^Seeing\.Stone\.beta\.(\d+)\.v\.(\d+\.\d+\.\d+)$/i.exec(tag);
  const normalized = historicalBeta ? `${historicalBeta[2]}-beta.${historicalBeta[1]}` : tag.replace(/^v/i, "");
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(normalized);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split(".").map((part) => /^\d+$/.test(part) ? Number(part) : part) : [];
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease };
}

export function compareSeeingStoneVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const key of ["major", "minor", "patch"] as const) if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  if (!left.prerelease.length || !right.prerelease.length) return left.prerelease.length ? -1 : right.prerelease.length ? 1 : 0;
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const a = left.prerelease[index]; const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "string") return -1;
    if (typeof a === "string" && typeof b === "number") return 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

export function canonicalReleasePageUrl(tagName: string): string | null {
  if (!parseSeeingStoneVersion(tagName)) return null;
  return `https://github.com/lostthoughts54/seeing-stone/releases/tag/${encodeURIComponent(tagName)}`;
}

export function selectNewestRelease(currentVersion: string, releases: ReleaseCandidate[]): ReleaseCandidate | null {
  const current = parseSeeingStoneVersion(currentVersion);
  if (!current) return null;
  // The 0.7.0 package version predates semver tags but is still a prerelease development build.
  const prereleaseChannel = current.prerelease.length > 0 || currentVersion === "0.7.0";
  const eligible = releases.filter((release) => !release.draft && (!release.prerelease || prereleaseChannel))
    .map((release) => ({ release, version: parseSeeingStoneVersion(release.tagName) }))
    .filter((entry): entry is { release: ReleaseCandidate; version: ParsedVersion } => entry.version !== null);
  return eligible.sort((a, b) => compareSeeingStoneVersions(b.version, a.version))[0]?.release ?? null;
}

export class UpdateChecker {
  constructor(private readonly currentVersion: string, private readonly logger: AppLogger, private readonly request: typeof fetch = fetch) {}

  async check(source: "automatic" | "manual"): Promise<UpdateStatus> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      let response: Response;
      try { response = await this.request("https://api.github.com/repos/lostthoughts54/seeing-stone/releases?per_page=20", { signal: controller.signal, headers: { Accept: "application/vnd.github+json" } }); }
      finally { clearTimeout(timeout); }
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      const body: unknown = await response.json();
      if (!Array.isArray(body)) throw new Error("GitHub returned an invalid release list");
      const releases: ReleaseCandidate[] = body.slice(0, 20).flatMap((entry): ReleaseCandidate[] => {
        if (!entry || typeof entry !== "object") return [];
        const value = entry as Record<string, unknown>;
        if (typeof value.tag_name !== "string" || typeof value.draft !== "boolean" || typeof value.prerelease !== "boolean") return [];
        return [{ tagName: value.tag_name, name: typeof value.name === "string" ? value.name.slice(0, 200) : null, publishedAt: typeof value.published_at === "string" ? value.published_at : null, draft: value.draft, prerelease: value.prerelease }];
      });
      const latest = selectNewestRelease(this.currentVersion, releases);
      const current = parseSeeingStoneVersion(this.currentVersion);
      const latestVersion = latest && parseSeeingStoneVersion(latest.tagName);
      const available = Boolean(current && latestVersion && compareSeeingStoneVersions(latestVersion, current) > 0);
      return { currentVersion: this.currentVersion, latestVersion: available ? latest!.tagName.replace(/^v/i, "") : null, releaseName: available ? latest!.name : null, publishedAt: available ? latest!.publishedAt : null, isUpdateAvailable: available, releasePageUrl: available ? canonicalReleasePageUrl(latest!.tagName) : null, source, status: available ? "available" : "current" };
    } catch (error) {
      this.logger.warn("Application update check failed.", { source, reason: error instanceof Error ? error.name : "unknown" });
      return { currentVersion: this.currentVersion, latestVersion: null, releaseName: null, publishedAt: null, isUpdateAvailable: false, releasePageUrl: null, source, status: "failed", ...(source === "manual" ? { error: "Couldn't check for updates. Check your internet connection and try again." } : {}) };
    }
  }
}
