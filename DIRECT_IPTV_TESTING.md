# Direct IPTV live playback and guide preview

This build supports Xtream account setup, catalogue browsing, live channel playback through the existing player, and provider-supplied channel schedules without a Jellyfin login or Docker. M3U support remains catalogue-only in this slice.

## Start and connect

1. Run **Launch Seeing Stone.cmd** in this project folder, or the **Seeing Stone** desktop shortcut.
2. Choose **Open IPTV · no Jellyfin needed** on the sign-in screen, or **IPTV** in the main, player or narrow-window navigation. IPTV is an inline page in the same application and profile; the main navigation stays available. **Connect Jellyfin** returns signed-out users to sign-in.
3. Select **Xtream account**, enter a display name, provider base address including any port, username and password, then choose **Save & test connection**. Use the address supplied with your account. A `player_api.php` address without a query is also accepted. Do not paste an entire username/password query URL into the base-address field; use the separate account fields.
4. Wait for **Provider access and catalogue import succeeded**. Large catalogues display an imported-entry count while loading.
5. Browse **Live TV**, **Movies**, and **Series**; try a category and a search. **Items per page** offers 50, 100, 150 or 200 entries.
6. Click a live channel or **Watch live** to open the shared player. **Go Live** restarts at the live edge; previous/next channel moves within the current catalogue page. Closing the player returns to IPTV.
7. Select **Programme guide** for a three-hour timeline. **Earlier**, **Now**, and **Later** move through provider coverage. Click a programme for its description and **Watch live**. All times are local; future programmes do not provide replay or scheduled playback.

Use the provider selector to switch accounts and **Manage providers** to add,
refresh or remove one. Switching to another page retains IPTV's selected provider,
catalogue tab, filters, page and guide window. **Jellyfin TV** identifies the server's
Live TV page; **IPTV** identifies your direct providers. Player sidebar links stop
playback and open the requested page, while **Now Playing** keeps playback open.

For M3U, select **M3U playlist** and enter its full playlist URL, including its token/query if supplied. Movies and Series are disabled for M3U sources.

Account details are entered only in the app, protected using Windows storage, and cleared from the setup form after submission. IPTV shares `%APPDATA%\Seeing Stone` with Jellyfin and the phone remote. The former IPTV Beta profile is retained as a backup after consolidation. Provider settings and the successful catalogue survive a restart. **Test & refresh** rechecks the account and catalogue. If a refresh fails, the previous catalogue remains available. To correct credentials, remove the provider with the confirmation button and add it again.

## What to verify

In **Programme guide**, search matches channel names/numbers OR programme titles overlapping the displayed time range. A search for `college` can find ESPN airing College Football without `college` appearing in the channel name. Category/favourite filters and favourite-first pagination still apply. Earlier/Now/Later rerun the search for that range. Outside guide mode, catalogue search remains channel/title search.

The first programme search loads the provider's full XMLTV guide and Xtream channel mappings into a private background worker with a SQLite full-text index. It searches all mapped channels, including those never displayed. The in-memory index refreshes on a search after one hour and rebuilds after app restart. Initial loading is shown explicitly; a failed or unavailable feed reports an error instead of silently returning channel-only results. Persistent guide storage, M3U programme search and manual EPG mapping remain future work.

Live-channel lists and guide rows put matching favourites first, including within a category or search. Both favourites and remaining channels keep their normal title order. Sorting happens before pagination; changing a star returns to the first page so the updated order is visible.

During live playback, media information shows FPS. The information panel labels whether this is the player's current estimate or the source frame rate used as a fallback. Unavailable values are omitted; this is not a monitor refresh-rate counter.

Use the star beside a live channel (in the list or guide) to add or remove a favourite. **★ Favourites** filters the current search/category to saved favourites; click it again to show all matching channels. Favourites are local, provider-specific, and survive catalogue refreshes and app restarts. They do not change Jellyfin favourites.

Movies and Series use a responsive poster grid. Visible cards fetch artwork from the provider's item details on demand, so existing saved catalogues do not need a refresh. Missing or failed artwork retains a title-initial placeholder. Main-process fetching keeps provider image addresses private; only bounded JPEG/PNG/WebP data reaches the renderer, with a bounded in-memory cache. This adds artwork browsing; VOD and episode playback remain a later phase.

**Programme guide** uses the shared content area, with the main navigation and catalogue tabs still available. Provider management stays collapsed until **Manage providers** is selected. **Back to channels** restores the channel list. **Find categories** narrows the category dropdown by word prefix (for example, `US` excludes `RUS`); choose a matching category to filter channels. Clearing the search restores the full category list. Programme details float over the guide without reducing the timeline height.

Channel browsing now shows the current programme and its end time beneath each visible station when the provider supplies guide data. Decorative provider headings such as `##### FOX TEXAS #####` are excluded from lists, counts and playback; choose an actual station such as `US| FOX 4 DALLAS TX (KDFW)`. Existing saved catalogues receive this filtering immediately without a refresh.

The FOX Dallas account check reached H.264 playback with an audio track and captured an actual decoded FOX4 frame. The provider returned no guide entries for that station during this check. The synthetic Electron check verifies current-programme labels alongside guide selection, playback, Go Live and stopping; it does not establish guide coverage for every provider channel.

- Login succeeds with the provider's address, username and password.
- Channel/movie/series counts look plausible for your subscription.
- Category names and multilingual channel/title searches work.
- Restarting the preview restores the saved provider and catalogue.
- If a test fails, report the visible status message and which step failed. Keep passwords and credential-bearing URLs in the local setup form.

Visible guide rows use Xtream channel schedules with a bounded five-minute cache until a full XMLTV search index is loaded; mapped rows then use that index. Missing schedules never prevent playback. Persistent guide generations, hidden channels, scheduled refresh, VOD/episode playback and local progress remain later phases. Movies and Series are still catalogue-only.

## Developer validation

Real-account validation completed on 18 September 2026: 55,174 live channels, 196,632 movies and 45,359 series imported. Categories, title searches and two distinct pages passed for all three types. These counts describe that refresh and may change as the provider updates its catalogue. The preview profile already contains the Windows-protected account and saved catalogue; no re-entry is needed on this computer.

The provider initially returned an empty movie array despite populated movie categories. The adapter now retries that inconsistency up to three total attempts with cancellable delays; persistent inconsistency fails the refresh and preserves the previous catalogue. The diagnostic report contains only counts and checks, not credentials or raw URLs. Its elapsed checks combine page fetches, categories and search; they are not a warm-search p95 benchmark. Movie search still uses substring scanning pending the planned FTS work.

Build the main process, preload and renderer with the existing build scripts. Run:

```text
node --test tests-node/iptv-service.test.cjs tests-node/iptv-provider-store.test.cjs tests-node/sqlite-persistence.test.cjs
node node_modules/vitest/vitest.mjs run tests/iptvProviderClient.test.ts tests/iptvContracts.test.ts tests/ipc.test.ts tests/liveTvFixture.test.ts
node scripts/iptv-beta-acceptance.cjs
node scripts/persistence-runtime-acceptance.cjs
```

The Electron acceptance test uses only the loopback synthetic provider, a temporary app profile and actual Windows protection. It saves review screenshots/result metadata in `artifacts/iptv-beta`. Its Chromium subprocesses require a normal Windows runtime environment; restricted command sandboxes may prevent them from loading.

While IPTV is playing, Mini guide opens over the player without stopping the stream. Search channels, filter favourites, browse pages, and read now/next programme listings; select a different channel to tune it. Close or Escape returns focus to playback. Last channel toggles between the two most recently confirmed channels in the current app session; Go Live preserves that history. The Electron test checks stream identity during guide browsing and round-trip Last channel switching.

The existing Live TV fixture also accepts Xtream authentication at its base address: synthetic username `viewer`, password `fixture-password`; username `expired` exercises rejected access. These are local test accounts only. The Electron acceptance test now opens programme details, starts live IPTV in the shared player and stops it. `tests/iptvPlayback.test.ts` covers ownership isolation, stream revocation, nested HLS capability rewriting and multilingual EPG timestamps.
