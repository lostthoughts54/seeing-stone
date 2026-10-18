import type { PlaybackState, UpdateSessionActivity, WatchPartyViewState, YouTubeRoomViewState } from "../../shared/contracts";
import type { FeatureState } from "../../shared/playerFeatures";

export function getUpdateSessionActivity(
  player: PlaybackState,
  syncPlay?: WatchPartyViewState,
  youtube?: YouTubeRoomViewState,
  features?: FeatureState,
): UpdateSessionActivity {
  // Paused, resolving, buffering, disconnected and episode countdowns are sessions too.
  const playback = !["idle", "ended", "stopped", "error"].includes(player.phase) || Boolean(player.nextEpisodeCountdown);
  const rooms = [syncPlay?.joinedGroup?.groupId, youtube?.room?.inviteToken, features?.room?.id];
  return { playback, watchParty: rooms.some(Boolean), key: JSON.stringify([playback ? player.playbackId ?? player.phase : null, ...rooms]) };
}
