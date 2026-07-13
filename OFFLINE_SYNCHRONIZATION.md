# Offline playback synchronization

Milestone 7 makes playback progress durable without adding a renderer reporting API. Authoritative mpv events are recorded in SQLite under the active Jellyfin server, user, and item identity before a live report is attempted.

## Ownership and lifecycle

- Electron main owns capture, Jellyfin requests, synchronization state, and authorization.
- SQLite remains isolated in its worker thread; synchronization uses asynchronous network calls.
- The renderer receives sanitized playback state but cannot submit progress, authoritative playback reports, credentials, URLs, paths, or synchronization targets.
- The renderer may request the narrow explicit user action `{ itemId, watched }`; main validates the item and creates the authoritative local revision. It cannot supply a position, percentage, report kind, URL, or target server.
- Synchronization activates only for an authenticated session, runs immediately and every 30 seconds, and is cancelled across logout or session revision changes.
- An actively playing item is not synchronized from the durable queue. Its queued revisions are considered after authoritative playback stops.

## Coalescing and ordering

Pending records are grouped by server, user, and item and processed by increasing local revision.

- Redundant automatic `progress` records are superseded, keeping the newest meaningful position after the latest explicit action.
- `completed` records are retained as completion events.
- `start_over`, `replay`, `mark_watched`, and `mark_unwatched` records are retained as explicit authoritative actions.
- A failure stops processing that item's later revisions until a retry, preserving order.
- Success advances the per-item synchronized head only when its revision is newer.

## Conflict behavior

Automatic progress is never sent when it would move Jellyfin behind a newer local success or a newer remote position. It also cannot automatically change a remotely watched item to unwatched.

A newer explicit local revision may intentionally lower the position or change watched state. This covers Start Over, replaying completed media, and explicit watched or unwatched actions. Because the action has a newer local revision, it is authoritative rather than stale automatic progress.

Movie and episode detail controls use this explicit action. Series pages expose it per episode; whole-series watched changes are intentionally not inferred from a single item action.

Network and server failures leave the revision retryable. Logs and renderer-visible errors receive only bounded safe error codes; tokens, authenticated URLs, paths, and response bodies are not logged.
