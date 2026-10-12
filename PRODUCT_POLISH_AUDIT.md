# Product polish audit — updated 2026-10-10

This pass reviewed Seeing Stone as an existing product: the purple/obsidian visual identity, local-first playback, library browsing, downloads, Jellyfin TV, direct IPTV, shared rooms, YouTube, and phone remote. Changes preserve those features and the current Electron architecture. The working tree already contained substantial feature work; this report describes the polish applied on top of it rather than attributing the entire Git diff to this audit.

## Architecture and scope

- Electron main owns authenticated networking, filesystem access, download state, native libmpv playback, room synchronization, and the companion server. The renderer receives typed, restricted APIs through a context-isolated preload.
- SQLite persistence runs in a worker. Local playback resolves verified downloads before network sources. Download lifecycle and path validation therefore matter to both playback and data safety.
- The desktop renderer uses TypeScript and DOM components with a large coordinating `app.ts`; IPTV, its mini guide, player features, reactions, and YouTube settings have separate modules. The companion is a separate browser bundle.
- Review covered source and architecture documents, renderer interactions, service lifecycle races, security boundary tests, narrow layouts, keyboard handling, error recovery, build configuration, and existing release validation. Fixtures use synthetic media/account data and isolated profiles.

## Improvements implemented

| Area | Result |
| --- | --- |
| Navigation and requests | Episode details return through their series to the original screen. Late detail responses cannot redirect navigation. Series/episode failures expose inline retry. Search invalidates old requests as soon as input changes. |
| Keyboard and accessibility | Shared dialog focus handling traps Tab and restores visible focus. Escape follows the active overlay. Editable fields, native controls, modifier combinations, composition, and repeated transport keys keep their intended behavior. Profile controls work from the keyboard; reduced-motion settings suppress repeating animation. |
| Library filtering | Quick choices remain available even when absent from the current filtered page. Counts update without replacing focused controls and identify themselves as page counts. Detached, invalid, or obsolete numeric-filter edits cannot trigger a later browse request. |
| Downloads | Progress updates preserve cards and focus. Creation-order sorting uses the service order. Active counts exclude paused transfers. Keep actions show state, busy feedback, and errors. Deleting smart-managed entries records a skip. Narrow layouts and checkbox sizing are corrected. |
| Download reliability | Physical path checks reject redirected descendants and hard-linked files before sensitive download operations. Regression fixtures prove unrelated sentinel data survives redirected resume/delete attempts. Queue lookup failures log once and allow recovery on a later action. |
| Playback | Cancellation during initialization/open cannot resurrect a closed video; stale completions and commands cannot replace or control a new session. Stop cleanup is coalesced. Volume/mute updates track accepted native state and the intended playback. Source-resolution failures preserve their actual error. |
| Persistence | Worker events and initialization failures are associated with their originating worker. Close/init races, unexpected exits, replacement workers, and rejected termination cannot leak or tear down the wrong lifecycle. |
| Shared rooms and YouTube | Failed chat preserves drafts, duplicate sends coalesce, and newer typing survives send completion. Search has loading/empty/error feedback. Invalid blank seek/delay values are rejected. Host-only controls reflect authority. Destructive room deletion explains its shared effect. Polling preserves focus and avoids repeated announcements. Older settings responses cannot overwrite a saved key. |
| IPTV | Catalogue and guide errors offer retry. Stale cursors have bounded recovery. Provider refresh preserves category choice. The mini guide cancels stale searches, supports arrow entry, restores focus after details, and fits narrow windows. |
| Phone remote | Transient network loss preserves pairing and the current view. Bootstrap work coalesces; commands retain their original playback target. Heartbeats preserve queue focus, track choices, and slider gestures. Pairing errors and page-load failures are recoverable. All six views fit 320px at 200% text zoom. |
| Maintenance | Removed a hidden obsolete downloads drawer with duplicate IDs; extracted shared focus helpers; corrected stale runtime fixtures, schema-version checks, and packaging identity documentation. Added reproducible product-polish checks. |

## Verification

Results against the final source/build in this workspace:

| Check | Result |
| --- | --- |
| TypeScript: main, preload, renderer, companion | Passed |
| Main compilation and Vite preload/renderer/companion builds | Passed |
| Vitest | 84 files, 679 tests passed |
| Node core/security/persistence/download tests | 52 passed |
| Integrated Electron application runtime | 28 passed |
| Desktop product-polish fixture | 19 passed |
| Library-wide filter choices fixture | 16 passed |
| Desktop YouTube polling/focus fixture | 24 passed |
| IPTV/shared-room/settings interaction fixture | 27 passed |
| Companion browser fixture | 37 passed |
| Electron SQLite runtime | Passed with current schema |
| Bundled native media probe | Valid video decoded; corrupt media and path escape rejected |
| Integrated native libmpv transport | Real fixture decoded through production preload; pause, exact seek, rate changes, renderer reload, resize, and GPU texture reuse/release passed in an isolated hidden window |
| Companion UTF-8 scan | 39 files passed |
| License audit and package provenance | Passed |
| Production libmpv package inventory | Passed, 36 native artifacts |
| Rebuilt Windows package acceptance | Passed; existing installation preserved, isolated profile identity stable, legacy/embedded preferences migrated, bundled media probe passed |
| Packaged UI and protected settings | Passed; IPTV navigation, YouTube/settings UI, protected key storage/removal, active libmpv |
| Packaged source comparison | Eight desktop/companion/preload/service files match the verified build |
| Git whitespace validation | Passed |

Desktop screenshots were reviewed at wide and narrow sizes; download layouts were checked at 980px, 700px, and 420px. Room and mini-guide layouts were also checked at 420px with 200% text. These are controlled browser/Electron fixtures, not a substitute for physical device testing or an assistive-technology audit.

Evidence is under `artifacts/product-polish/`, `artifacts/product-polish-modules/`, and `artifacts/companion-polish/`. Key logs are `unit-tests.log`, `core-tests.log`, `electron-runtime.log`, `acceptance.log`, and `release-validation.log`. The module and phone directories also contain machine-readable `result.json` and screenshots.

Native transport evidence is in `artifacts/product-polish/native-transport-svWElz/result.json` with its adjacent diagnostic trace. This proves production native/preload integration on this machine; hidden-window frame statistics are not a performance benchmark. Audible output and visible fullscreen behavior were not assessed by this smoke check. The updated `pnpm test:libmpv-integrated` harness uses a fresh isolated profile and retains its result and trace under a new `native-transport-*` directory.

To repeat the added interaction checks, run `pnpm test:product-polish`. It builds the application and runs the five fixture scripts. The phone and desktop YouTube fixtures use installed Chrome; `CHROME_PATH` can override its path. Existing `pnpm test` covers type checks, unit/core tests, Electron runtime, persistence, and media probing. In this managed Windows environment the installed Node tool entrypoints were invoked directly because the package-manager shim encountered filesystem restrictions.

### Follow-up usability pass

- Library and Live TV search render independently. A slow guide no longer delays movie/show results; either source can fail and retry without removing successful results or their keyboard focus. Empty searches identify the requested query, and stale responses remain suppressed.
- Removing a filter chip preserves focus on the next remaining chip or the Filters button, including after the server refresh completes.
- Download selection updates controls in place and labels grouped-record checkboxes for assistive technology. Select all includes matching episodes in collapsed series groups.
- Desktop YouTube room, queue, member, and handoff regions retain their DOM when their visible data has not changed. Actual changes preserve focus by room/queue item/action identity, including asynchronous button actions, while timeline updates continue. Queue arrow controls have descriptive names.
- Added seven desktop regression checks and 24 focused YouTube checks. The latter's evidence is in `artifacts/desktop-youtube-focus/result.json`.

### Library-wide filters and reported recovery failures

- Genre and people choices now come from the selected Jellyfin library, independently of the current media page. Sections load lazily, offer search/pagination/retry, preserve selected labels and focus, and discard stale requests. People indexing uses bounded metadata-only pages with session-scoped caching; unsupported oversized or malformed responses produce an explicit error. Technical/rating quick choices still use loaded items.
- The phone's series view previously fetched every episode of every season before displaying its first page. It now requests one lightweight, bounded episode page with a deadline below the phone's request deadline. Specials and server episode ordering are retained. A transient episode failure stays local to that list and offers Retry without claiming the whole Jellyfin server is offline. Nine service tests and six additional browser checks cover this path.
- Native minimization no longer overwrites renderer viewport visibility, so restore can resume without a resize. Pending starts are cancelled when stopped or superseded; shared cleanup cannot tear down a replacement channel. Seven native bridge tests exercise these races and the bounded readiness error.
- Starting local or remotely initiated playback resets the player content scroll position so the video is visible. Layout reports also remain valid during IPTV resolution before a Jellyfin item or playback ID exists. Focus/visibility restoration refreshes the viewport. The desktop fixture verifies playback after scrolling and renewed viewport reports on focus.
- The reported abrupt IPTV interruption itself was not reproduced or attributed to a provider/native cause. These changes fix identified recovery defects; they do not establish the cause of the original interruption. The misleading watch-party startup error now refers to playback.
- The final native transport rerun passed using production preload, real decoded video, seek/rate/pause, renderer reload, resize, and texture lifecycle checks. Evidence: `artifacts/product-polish/native-transport-nzRwFd/result.json`.
- Physical-device confirmation, 2026-10-10: after the updated maintained build was reopened, the user refreshed the remote in iPhone Safari and reported "Episodes and IPTV both work" when asked to check Futurama's episode list and starting/switching IPTV. This confirms those reported workflows on the user's setup; it does not establish the cause of the original interruption or constitute a long playback soak.

## Release status and remaining work

**This audit does not certify the existing installer for public release.** `validate:libmpv-release` still reports `LIBMPV_PUBLIC_RELEASE_NO_GO`: the existing installer SHA-256 differs from the artifact named in the recorded public-release acceptance. The evidence was preserved. Fresh package acceptance must correspond to the actual release artifact; changing the recorded hash alone would not establish acceptance.

- Rebuilt the maintained `.runtime/release/win-unpacked/Seeing Stone.exe` and `.runtime/release/Seeing-Stone-Setup-0.7.1-x64.exe` through the existing workflow. The normal app was closed gracefully before replacement and reopened with its existing profile. No alternative launcher or permanent profile was created. Package checks used isolated profiles and preserved the registered installation; this is not a clean-machine install/uninstall test or publication. Evidence: `artifacts/product-polish/package-acceptance.log`, `package-smoke.log`, and `packaged-source.json`.
- Windows signing remains an external release prerequisite described in `WINDOWS_PACKAGING.md`.
- The targeted iPhone Safari episode-browsing and IPTV check passed by user confirmation. Broader physical-phone coverage, real LAN interruption/reconnection, multi-person room sessions, long playback soaks, and a clean-machine install/uninstall remain release validation tasks. Synthetic fixture results do not claim those scenarios passed.
- Collections and Watchlist remain explicitly unavailable existing navigation placeholders. Direct IPTV movie/series playback is outside the currently implemented catalogue scope. No working feature was removed to conceal these product limitations.
- Technical/rating quick-filter choices remain based on loaded items. Genre and people choices now cover the selected library.
- The large desktop controller remains a maintenance concern. Shared focus handling and stable download-card updates reduce duplication and churn here; a broad controller rewrite was avoided during the release-polish pass.
