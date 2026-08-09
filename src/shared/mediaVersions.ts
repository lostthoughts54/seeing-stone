import type { MediaItem, MediaSourceCapabilities, MediaVersion } from "./contracts";

const PROVIDER_PRECEDENCE = ["imdb", "tmdb", "tvdb"] as const;

function normalizedProviderEntries(item: MediaItem): Array<[string, string]> {
  const entries = Object.entries(item.providerIds ?? {})
    .map(([key, value]) => [key.toLocaleLowerCase("en-US"), value.trim().toLocaleLowerCase("en-US")] as [string, string])
    .filter(([key, value]) => PROVIDER_PRECEDENCE.includes(key as typeof PROVIDER_PRECEDENCE[number]) && value.length > 0);
  return entries.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    const keyOrder = PROVIDER_PRECEDENCE.indexOf(leftKey as typeof PROVIDER_PRECEDENCE[number])
      - PROVIDER_PRECEDENCE.indexOf(rightKey as typeof PROVIDER_PRECEDENCE[number]);
    return keyOrder || leftValue.localeCompare(rightValue);
  });
}

function identityTokens(item: MediaItem): string[] {
  if (item.type !== "Movie") return [];
  const presentation = item.presentationUniqueKey?.trim();
  if (presentation) return [`presentation:${presentation.toLocaleLowerCase("en-US")}`];
  const provider = normalizedProviderEntries(item)[0];
  return provider ? [`provider:${provider[0]}:${provider[1]}`] : [];
}

function canonicalScore(item: MediaItem): number {
  return (item.presentationUniqueKey === item.id ? 1_000_000 : 0)
    + (item.mediaVersions?.length ?? 0) * 1_000
    + (item.imageTags.Primary ? 100 : 0)
    + (item.backdropImageTag ? 50 : 0)
    + (item.overview ? 10 : 0)
    + (item.people?.length ? 5 : 0);
}

function chooseCanonical(items: MediaItem[]): MediaItem {
  return [...items].sort((left, right) => canonicalScore(right) - canonicalScore(left) || left.id.localeCompare(right.id))[0];
}

function mergeVersions(items: MediaItem[]): MediaVersion[] {
  const versions = new Map<string, MediaVersion>();
  for (const item of items) {
    for (const version of item.mediaVersions ?? []) {
      versions.set(`${version.itemId}\0${version.mediaSourceId}`, version);
    }
  }
  return [...versions.values()].sort((left, right) => left.itemId.localeCompare(right.itemId)
    || left.mediaSourceId.localeCompare(right.mediaSourceId));
}

function logicalUserData(items: MediaItem[]): MediaItem["userData"] {
  const allPlayed = items.every((item) => item.userData.played);
  if (allPlayed) return { played: true, playbackPositionTicks: 0, playedPercentage: 100 };
  const mostAdvanced = [...items].filter((item) => !item.userData.played)
    .sort((left, right) => right.userData.playedPercentage - left.userData.playedPercentage
      || right.userData.playbackPositionTicks - left.userData.playbackPositionTicks
      || left.id.localeCompare(right.id))[0];
  return mostAdvanced?.userData ?? { played: false, playbackPositionTicks: 0, playedPercentage: 0 };
}

/**
 * Condense only movies connected by an exact Jellyfin grouping identity or an
 * exact shared movie provider id. Input order defines logical sort order.
 */
export function groupMovieVersions(items: MediaItem[]): MediaItem[] {
  const parents = items.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    while (parents[index] !== index) {
      const next = parents[index];
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };
  const tokenOwners = new Map<string, number>();
  items.forEach((item, index) => {
    for (const token of identityTokens(item)) {
      const owner = tokenOwners.get(token);
      if (owner === undefined) tokenOwners.set(token, index);
      else union(owner, index);
    }
  });

  const members = new Map<number, MediaItem[]>();
  items.forEach((item, index) => {
    const root = find(index);
    const group = members.get(root) ?? [];
    group.push(item);
    members.set(root, group);
  });

  const result: MediaItem[] = [];
  items.forEach((item, index) => {
    const root = find(index);
    if (root !== index) return;
    const group = members.get(root) ?? [item];
    if (group.length === 1) {
      result.push(item);
      return;
    }
    const canonical = chooseCanonical(group);
    const versions = mergeVersions(group);
    result.push({
      ...canonical,
      userData: logicalUserData(group),
      mediaVersions: versions.length ? versions : canonical.mediaVersions,
    });
  });
  return result;
}

export function formatMediaVersionLabel(version: Omit<MediaVersion, "label">): string {
  const dimensions = version.width && version.height
    ? version.width >= 3_800 || version.height >= 2_100 ? "4K"
      : version.height >= 1_000 ? "1080p"
        : version.height >= 700 ? "720p"
          : `${version.width}×${version.height}`
    : null;
  const range = version.videoRange?.trim();
  const dynamicRange = range
    ? /hdr|dolby|dv|hlg/i.test(range) ? range.toLocaleUpperCase("en-US") : "SDR"
    : null;
  const codec = version.videoCodec?.trim().toLocaleUpperCase("en-US")
    .replace(/^H264$/, "H.264").replace(/^H265$/, "HEVC") ?? null;
  const channels = version.audioChannels?.trim();
  const bitrate = version.bitrate && version.bitrate > 0
    ? version.bitrate >= 1_000_000 ? `${Number((version.bitrate / 1_000_000).toFixed(1))} Mbps` : `${Math.round(version.bitrate / 1_000)} kbps`
    : null;
  const parts = [version.name, dimensions, dynamicRange, codec, channels, bitrate]
    .filter((part): part is string => Boolean(part));
  const unique = parts.filter((part, index) => parts.findIndex((candidate) => candidate?.toLocaleLowerCase("en-US") === part.toLocaleLowerCase("en-US")) === index);
  return unique.slice(0, 6).join(" • ") || "Media version";
}

export function versionsFromCapabilities(capabilities: MediaSourceCapabilities): MediaVersion[] {
  return capabilities.sources.map((source) => {
    const version = {
      itemId: capabilities.itemId,
      mediaSourceId: source.id,
      name: source.name ?? null,
      container: source.container,
      width: source.width ?? null,
      height: source.height ?? null,
      videoCodec: source.videoCodec ?? null,
      audioCodec: source.audioCodec ?? null,
      audioChannels: source.audioChannels ?? null,
      bitrate: source.bitrate ?? null,
      size: source.size,
      videoRange: source.videoRange ?? null,
      runtimeTicks: null,
      supportsDirectPlay: source.supportsDirectPlay,
      supportsDirectStream: source.supportsDirectStream,
      supportsTranscoding: source.supportsTranscoding,
    };
    return { ...version, label: formatMediaVersionLabel(version) };
  });
}
