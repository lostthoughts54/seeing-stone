# Direct IPTV: architecture and implementation order

Repository inspection: 17 September 2026. This is an incremental Windows desktop feature. Phase 1 established contracts and protected provider storage. Phase 2 now exposes a local account/catalogue preview; playback and guide integration remain subsequent slices.

## Existing components to reuse

| Component | Reuse and required adaptation |
| --- | --- |
| `src/main/services/persistence.ts`, `persistenceWorker.ts` | Keep the asynchronous facade, one worker-owned SQLite connection, WAL, strict tables, transactional migrations and integrity checks. Keep imports off the main thread. |
| `secureSession.ts`, `electronSecurity.ts` | Reuse the `SessionProtector` abstraction and `createSafeStorageProtector()` for the entire provider configuration. Keep Jellyfin session files independent. |
| `playbackSession.ts` | Add an explicit IPTV identity branch before local-download, Jellyfin identity and source resolution. Preserve revision cancellation and one active source. |
| `playerController.ts`, `playerControllerRouter.ts`, `mpvPlayer.ts`, libmpv backend | Reuse the selected backend, controls, seek/resume, authoritative events, viewport and release lifecycle. Do not create a second IPTV player. |
| `playbackProxy.ts` | Reuse the main-owned loopback capability. Add manifest/resource capability rewriting and upstream cancellation for HLS. Current proxy handles one media capability and subtitles, not nested HLS resources. |
| `playbackReporting.ts` | Dispatch on explicit content ownership before either live-TV Jellyfin reporting or offline synchronization. IPTV progress belongs in its own local table. |
| `src/renderer/liveTvPresentation.ts`, existing guide classes in `app.ts`/`styles.css` | Reuse guide geometry, local time formatting and presentation. Extract a reusable virtualized guide surface; do not copy the current full-channel loading path. |
| `src/main/ipc.ts`, `src/preload/index.ts` | Reuse authorized-sender checks, strict schemas and safe RPC errors. Add a separate IPTV bridge without session-login guards. |
| `scripts/live-tv-test-server.cjs`, playback/guide/persistence tests | Extend the synthetic fixture and add independent provider tests. No Docker or real subscription is needed for fixture validation. |

The existing `ARCHITECTURE.md` describes the Jellyfin route. Its statement that every playable item starts in Jellyfin must become scoped to that route when IPTV playback lands. This document defines the new independent route.

## Boundaries and identities

- An installation-local provider UUID owns IPTV data. Content identity is `(providerId, contentType, stableItemId)`; movie, live and episode IDs may overlap. Series is browsable, not directly playable. Never use names as identity or manufacture a Jellyfin profile for IPTV.
- A main-process provider service will own Xtream and M3U adapters, authentication, credentials, stream resolution, refresh orchestration and details fetching. A saved provider is not evidence of successful authentication. M3U exposes live channels only. Trex compatibility remains unverified until an active subscription is available.
- The renderer sends setup credentials once and subsequently receives safe summaries, identities, bounded metadata and opaque cursors. Address, playlist/XMLTV URLs, passwords, API responses, resolved stream URLs and protected blobs remain main-owned. Clear setup form values after submission. Provider text must be sanitized before IPC; artwork must use opaque main-owned resources rather than raw provider URLs.
- Reuse OS encryption, with no plaintext fallback. Encrypt address, credentials and replacement-feed URLs together in a versioned envelope bound to the provider UUID. An encryption/decryption failure preserves existing ciphertext and returns a fixed public error. Provider removal is explicit and independent from Jellyfin logout.
- The future playback request is a discriminated Jellyfin/IPTV identity, not an IPTV identifier stuffed into a Jellyfin `itemId`. Keep legacy string call sites compatible through an adapter while migrating the resolver and controller boundary. Reject room/queue operations that do not support IPTV. IPTV never reaches Jellyfin reporting, offline synchronization, download identity, Next Up, watched-state mutation or metadata fallback.
- UTC timestamps are stored and queried; only presentation converts to local time. Programme selection opens details with Watch live / Show in guide. Future broadcasts do not confer catch-up rights.

## Storage and worker design

**Version 9, implemented in this pass:** `iptv_providers(provider_id, kind, name, protected_configuration, created_at, updated_at)`. It has no Jellyfin foreign keys and can be used on an empty installation. Only encrypted configuration bytes cross into the persistence worker; list queries do not even select the protected blob. The main-only store supports create, list, read, explicit removal and encryption rotation. No provider API, startup hook or renderer IPC is wired yet.

**Next additive migrations, proposed (allocate version numbers against the repository at implementation time):**

1. Catalogue generations and active snapshot pointers; provider-scoped categories and catalogued live/movie/series items with composite identities and bounded metadata. Details, seasons and episodes are fetched on demand. Store any credential-bearing media/artwork locations under OS protection, not in metadata JSON. Add local VOD progress keyed by provider/type/item, separate from `playback_heads` and `playback_revisions`.
2. Channel preferences, hidden groups and explicit channel-to-XMLTV mapping overrides. Preferences reference stable provider identities, not refresh generation rows, so they survive a catalogue refresh or temporary disappearance.
3. Guide import generations, XMLTV channels, programme entries and coverage/refresh metadata. Match provider XMLTV IDs first; saved overrides win. Missing or unmatched schedules never remove channels. Index programme windows by generation/channel/start/end and map one XMLTV ID to multiple provider channels when necessary.
4. Worker-owned FTS5 word/prefix indexes for channel name/number and programme title/episode title/description/genres; catalogue indexes for movies/series. Add trigram indexes for partial names/titles, preserving original text. Use normalized search fields and bound literal FTS expressions; short multilingual queries need an explicit bounded fallback because trigram queries shorter than three characters do not match. Confirm correctness and query plans before fixing a final index layout. See [SQLite FTS5 documentation](https://www.sqlite.org/fts5.html).

Stage rows and indexes under a new generation in bounded transactions, yielding between batches so interactive worker queries can run. Publish the generation pointer, coverage and last-success time atomically only after complete parsing/validation/indexing. Readers join only the active generation. Failed or interrupted work leaves the old snapshot usable; startup prunes abandoned staging data. Keep 24 hours of history and at most seven future days, reporting actual feed coverage. Clean obsolete generations incrementally after publication.

Use a dedicated streaming XMLTV parser worker feeding bounded batches to the existing persistence worker with backpressure. It must reject external entities, bound records and decompressed input, handle UTF-8 chunk boundaries, and support cancellation. Do not extend the existing persistence request into a multi-minute job: its facade currently times out requests after 15 seconds. Each batch remains a short request; progress/job state is a separate interface. Keep downloaded schedules out of renderer IPC.

Search channels and programmes separately across the active downloaded schedule, not just the visible window. Order exact normalized names/titles first and then currently airing programme matches with stable tie-breakers. Apply provider, hidden/group/favourite filters before pagination. Cursors must be scoped to query, filters and snapshot; reject/restart stale cursors after publication. Use 50-result pages, a 250 ms debounce and renderer request generations to discard superseded replies. Virtualized channel rows request only visible-channel windows; movie/series virtualization must bound DOM nodes and retained pages.

## Implementation order and acceptance gates

| Phase | Deliverable | Gate before advancing |
| --- | --- | --- |
| 1 — this pass | Typed setup/identity/browse/guide/search/preferences/playback contract and encrypted provider registry, migration 9 | Existing data survives upgrade/restart; safe summaries omit credentials; encryption failure and rotation preserve data; no Jellyfin dependency |
| 2 | Main-process adapters, setup/status IPC, mock Xtream auth and streaming M3U ingestion; catalogue snapshots and paged browsing | Independent startup/setup with no Jellyfin; expired credentials and failed refresh retain usable catalogue; stable duplicate-name identities |
| 3 | Discriminated playback resolver/controller, TS/VOD/HLS proxy integration, local progress | Single session, rapid switching cancellation, upstream stream release, bounded reconnects, seek/resume/restart; prove zero IPTV calls to Jellyfin |
| 4 | XMLTV worker, atomic generations, mappings, preferences, FTS search, refresh scheduler | Search descriptions/multilingual titles/numbers, missing schedules, DST and timezone correctness; failed/interrupted refresh recovery |
| 5 | Separate IPTV Live TV / Movies / Series navigation, setup, on-demand details/episodes, virtualized guide/catalogue | Available while signed out; independent content ownership; all search filters/details actions; bounded DOM and stale-result handling |
| 6 | Extended fixture, scale harness, packaged local beta | 10,000 channels, 1,000,000 programmes, 100,000 catalogue items; warm first-page search p95 below 500 ms excluding debounce; responsive browsing during import; relevant Jellyfin/player/IPC regressions and packaged Electron verification |
| 7 | User enters renewed Trex credentials locally | Actual authentication, coverage/mapping, live switching, HLS/TS and VOD validation; document provider-specific differences |

Schedule overdue refresh on launch, guides every six hours and catalogues daily while open, plus explicit refresh. Coalesce concurrent requests per provider and cancel on removal/shutdown. Distinguish last attempt/error from last successful refresh. No recording, catch-up, downloads, watch parties, expanded companion browsing or Docker work belongs to these phases.

## Regression risks discovered during inspection

- `PlaybackReportingService` special-cases live content by reporting to Jellyfin, while all other content enters offline synchronization. Routing must precede both branches. `PlaybackMetadataService`, continuation, queue and companion helpers also assume Jellyfin identities.
- Resolver cancellation currently occurs around asynchronous resolution; new provider requests need real AbortSignals and late-result rejection. Proxy disconnect cancellation must reach upstream requests and HLS descendants. Reconnect must be bounded per session and reset only on deliberate playback changes.
- The guide currently searches its loaded guide when available and progressively appends rows. That is not full-schedule search or virtualization, even though the layout is reusable.
- IPC is a trusted-sender boundary, not permission to expose provider headers/URLs. HLS variant, key, map, subtitle and segment URIs (including redirected relative bases) must all remain proxied. Avoid logging upstream errors that contain credentials. Cap manifest resources and enforce HTTP(S) transport policy.
- `node:sqlite` runs inside a worker with `trusted_schema=OFF` and extension loading disabled. Validate FTS availability in Electron, maintain indexes explicitly in import transactions, and avoid depending on FTS triggers under that setting.
- Packaged persistence workers verify exactly two unpacked modules today. This phase keeps SQL and runtime worker logic in those modules. Adding worker dependencies later requires matching changes to both builder configs, manifest generation, verification and packaged tests.
- Startup integrity checks and large index maintenance can become costly with million-row data. Measure startup, import responsiveness, disk growth and query plans in addition to isolated searches. Preserve the previous generation until publication succeeds.
- The working tree contains active changes to player features, downloads, libmpv, renderer, IPC and contracts. Keep later changes narrow and re-inspect those files at each phase; do not reset or replace them from HEAD.

## Current pass validation

Automated contract, protected-store, migration and Electron persistence checks accompany this foundation. They use synthetic credentials and an injected test protector. They do not claim real OS credential round-trips, provider compatibility, search benchmarks, player integration, or a packaged beta. Those are explicit later gates above.

Validation completed for this pass:

- All four TypeScript projects passed `pnpm run typecheck`; `pnpm run build:main` passed after the final changes.
- 81 selected Vitest tests passed across contracts, schemas, playback session/reporting/proxy, IPC, guide search/presentation/fixture, packaging configuration and worker integrity. The updated contracts suite was rerun after the malformed-address fix.
- 17 Node tests passed across provider storage and existing SQLite persistence, including v1/v8 upgrades, failed-migration preservation, restart, duplicate provider labels, swapped ciphertext, protection failure and key rotation.
- `node scripts/persistence-runtime-acceptance.cjs` passed in Electron 43.1.0 / Node 24.18.0 / SQLite 3.53.1, including the new provider BLOB and safe-list operations without Jellyfin rows.
- `git diff --check` passed. Existing unrelated working-tree changes were preserved.

## Phase 2: account/catalogue testing point

Implemented `IptvProviderClient` and `IptvService`, a separate `window.iptv` bridge, and a setup/catalogue dialog available from the signed-out screen or sidebar. The Xtream adapter checks account auth/status/expiry before streaming category and live/movie/series arrays. The M3U adapter exposes live metadata only. Upstream URLs, errors, artwork and raw response properties are not exposed to the renderer. Requests are cancellable, size-bounded and limited to HTTP(S), with a redirect limit and no HTTPS downgrade. The API shape is based on the [Xtream-compatible server implementation](https://github.com/gtaman92/XtreamCodesExtendAPI/blob/master/player_api.php); actual Trex behavior still requires the user's local test.

Migration 10 adds provider-owned staging/published snapshots and catalogue rows. Failed refreshes preserve the current published catalogue, startup removes abandoned staging, and removal cancels pending imports before deleting provider data. The renderer uses 50-row pages, category filters, 250 ms debounced searches and request generations; it never receives the complete catalogue. Search is currently normalized literal substring matching, not the planned FTS or programme search. The preview does not yet run scheduled refreshes.

The local launcher uses a separate `Seeing Stone IPTV Beta` user-data profile. [Testing instructions](DIRECT_IPTV_TESTING.md) explain account entry and the exact preview scope. The mock fixture covers Xtream auth, expired accounts, duplicate/multilingual channels, VOD/series catalogues and failed-refresh recovery. `scripts/iptv-beta-acceptance.cjs` exercises the real Electron application, preload, IPC, Windows OS encryption, signed-out setup/browsing, paging and refresh recovery; screenshots and the result are under `artifacts/iptv-beta`.

Real-provider validation on 18 September 2026 imported 297,165 entries: 55,174 live, 196,632 movies and 45,359 series. Category enumeration, title search and two-page identity checks passed in each section. A transient HTTP 200 / empty movie list despite populated categories required a compatibility fix: retry an inconsistent empty section twice with cancellable delays, then fail without publishing if it remains inconsistent. This is covered by adapter regression tests. The encrypted account and published catalogue are in the isolated beta profile, while workspace reports contain only aggregate counts and check results.

## Live playback and initial provider guide integration

Xtream live identities now reach the shared controller through a main-validated command context. Resolution checks the saved catalogue and opens an opaque loopback capability. The main-owned IPTV stream handles TS and rewrites nested HLS manifests, keys, maps and segments; stop/switch cancels upstream access. IPTV ownership bypasses Jellyfin reporting, offline progress, metadata enrichment and companion guide lookups. Go Live and desktop channel navigation stay in IPTV. Live channels have no saved resume position.

The first guide is an incremental provider-schedule integration: Xtream `get_simple_data_table` schedules are fetched for visible rows (two concurrent renderer requests), decoded and sanitized in main, and cached in a bounded memory cache. The UI reuses guide placement/time-axis functions, displays local-time three-hour windows and programme details, and offers Watch live even when a schedule is absent. This is not the full XMLTV/FTS phase: persistent imports, replacements/mappings, preferences, full-schedule search and scheduling remain outstanding. M3U playback, VOD/episode playback, local VOD progress, reconnect policy and the scale benchmark also remain later work.

No new database migration is required for this slice; item lookup uses the published catalogue. Synthetic Electron acceptance covers guide-to-player launch/stop while signed out. Real-account checks decoded H.264 with healthy native video output and audio on three news-channel selections; a tested channel supplied 135 programme entries. This remains a local preview, not a packaged release.
