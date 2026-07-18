import type { MediaItem, PlaybackDiagnostics } from "../../shared/contracts";
import { cachedMediaItemSchema, cachedPlaybackDiagnosticsSchema } from "../../shared/schemas";
import type { MediaItemRecord, MediaSourceRecord, PlaybackHeadRecord } from "./persistenceTypes";

function fallbackItem(record: MediaItemRecord): MediaItem {
  return {
    id: record.itemId,
    name: record.name,
    type: record.itemType,
    overview: "",
    productionYear: null,
    premiereYear: null,
    officialRating: null,
    communityRating: null,
    runTimeTicks: record.runTimeTicks,
    genres: [],
    primaryImageAspectRatio: null,
    imageTags: {},
    backdropImageTag: null,
    parentThumbItemId: null,
    parentThumbImageTag: null,
    seriesId: record.seriesId,
    seriesName: null,
    seasonId: record.seasonId,
    indexNumber: null,
    parentIndexNumber: null,
    userData: { played: false, playbackPositionTicks: 0, playedPercentage: 0 },
    hasTrailer: false,
    playable: true,
  };
}

function mergePlaybackHead(
  item: MediaItem,
  head: PlaybackHeadRecord | null | undefined,
  useSucceededHead: boolean,
): MediaItem {
  if (!head || (!useSucceededHead && head.latestRevision <= head.lastSucceededRevision)) return item;
  const remote = item.userData;
  let positionTicks = remote.playbackPositionTicks;
  let played = remote.played;
  if (head.conflictPolicy === "explicit" || head.actionKind !== "progress") {
    positionTicks = head.positionTicks;
    played = head.watched;
  } else if (!(remote.played && !head.watched)) {
    if (head.watched || head.positionTicks > remote.playbackPositionTicks) {
      positionTicks = head.positionTicks;
      played = head.watched;
    }
  }
  const duration = Math.max(0, item.runTimeTicks);
  const boundedPosition = Math.max(0, Math.min(duration || Number.MAX_SAFE_INTEGER, Math.floor(positionTicks)));
  return {
    ...item,
    userData: {
      played,
      playbackPositionTicks: boundedPosition,
      playedPercentage: duration > 0 ? Math.max(0, Math.min(100, (boundedPosition / duration) * 100)) : 0,
    },
  };
}

export function materializeCachedMediaItem(
  record: MediaItemRecord,
  head?: PlaybackHeadRecord | null,
): MediaItem {
  const parsed = cachedMediaItemSchema.safeParse(record.metadata);
  const hasValidMetadata = parsed.success && parsed.data.id === record.itemId;
  const item = hasValidMetadata
    ? structuredClone(parsed.data)
    : fallbackItem(record);
  return mergePlaybackHead(item, head, !hasValidMetadata);
}

export function materializeCachedNextUp(record: MediaItemRecord): MediaItem | null {
  const parsed = cachedMediaItemSchema.safeParse(record.nextUp);
  if (!parsed.success || parsed.data.id === record.itemId) return null;
  return structuredClone(parsed.data);
}

export function materializeCachedDiagnostics(record: MediaSourceRecord | null | undefined): PlaybackDiagnostics | null {
  const parsed = cachedPlaybackDiagnosticsSchema.safeParse(record?.diagnostics);
  return parsed.success ? structuredClone(parsed.data) : null;
}
