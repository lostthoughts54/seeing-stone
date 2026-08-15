import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Seeing Stone player shell", () => {
  it("provides bounded segment and trickplay controls without a new seek path", async () => {
    const [html, renderer, preload, security] = await Promise.all([
      readFile("src/renderer/index.html", "utf8"),
      readFile("src/renderer/app.ts", "utf8"),
      readFile("src/preload/index.ts", "utf8"),
      readFile("src/main/electronSecurity.ts", "utf8"),
    ]);
    for (const id of ["playerSegmentSkipButton", "playerTimelineTrack", "playerTimelinePreview", "playerTimelinePreviewImg"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(renderer).toContain("window.jellyfin.playback.seek({ playbackId: state.playbackId as string, positionTicks: segment.endTicks })");
    expect(renderer).toContain("getTrickplaySpriteUrl");
    expect(renderer).toContain("playerTimeline.addEventListener(\"change\"");
    expect(preload).toContain("playbackFeaturesGetTrickplaySpriteUrl");
    expect(security).toContain("jellyfin-trickplay");
  });
  it("ships guide-first Live TV across desktop, mobile, and player navigation", async () => {
    const [html, app] = await Promise.all([
      readFile("src/renderer/index.html", "utf8"),
      readFile("src/renderer/app.ts", "utf8"),
    ]);
    for (const id of [
      "navLiveTvButton", "mobileLiveTvButton", "liveTvView", "liveTvGuideTab",
      "liveTvRecordingsTab", "liveTvScheduledTab", "playerMiniGuide", "playerGoLiveButton",
      "liveTvChannelSearch", "liveTvChannelSearchStatus", "liveTvNowButton",
    ]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('data-player-route="live-tv"');
    expect(app).toContain("window.jellyfin.playback.startLive");
    expect(app).toContain("window.jellyfin.liveTv.createRecording");
    expect(app).toContain("window.confirm");
    expect(app).not.toContain("matchingChannels.slice(0, 300)");
    expect(app).toContain("requestAnimationFrame(renderBatch)");
    expect(app).toContain("programsByChannel");
    expect(app).toContain("window.jellyfin.liveTv.searchPrograms");
    expect(html).toContain('placeholder="Search channels or programs"');
  });

  it("keeps the Full Guide controls compact and gives the grid the remaining viewport height", async () => {
    const [html, styles] = await Promise.all([
      readFile("src/renderer/index.html", "utf8"),
      readFile("src/renderer/styles.css", "utf8"),
    ]);
    const toolbar = html.slice(html.indexOf('<header class="live-tv-toolbar">'), html.indexOf('id="liveTvContent"'));
    for (const id of [
      "liveTvGuideTab", "liveTvRecordingsTab", "liveTvScheduledTab", "liveTvChannelSearch",
      "liveTvNowButton", "liveTvChannelSearchStatus", "liveTvStatus", "refreshLiveTvButton",
    ]) expect(toolbar).toContain(`id="${id}"`);
    const compactGuideStyles = styles.slice(
      styles.indexOf("/* Live TV: a compact toolbar"),
      styles.indexOf("/* Mini Guide lives"),
    );
    expect(compactGuideStyles).toMatch(/\.live-tv-view \{[\s\S]*?display: flex;[\s\S]*?height: 100%;[\s\S]*?min-height: 0;[\s\S]*?overflow: hidden;/);
    expect(compactGuideStyles).toMatch(/\.live-tv-toolbar \{[\s\S]*?grid-template-columns:/);
    expect(compactGuideStyles).toMatch(/\.live-tv-content \{[\s\S]*?flex: 1 1 auto;[\s\S]*?min-height: 0;/);
    expect(compactGuideStyles).toMatch(/\.live-tv-grid \{[\s\S]*?flex: 1 1 0;[\s\S]*?max-height: none;[\s\S]*?min-height: 0;/);
  });

  it("keeps Live TV artwork authenticated and the Mini Guide above auto-hiding controls", async () => {
    const [html, styles, app] = await Promise.all([
      readFile("src/renderer/index.html", "utf8"),
      readFile("src/renderer/styles.css", "utf8"),
      readFile("src/renderer/app.ts", "utf8"),
    ]);
    expect(app).toContain('window.jellyfin.artwork.getUrl({ itemId: channel.id, kind: "Primary", tag: channel.imageTag');
    expect(app).toContain("handlePlayerMiniGuideKey");
    expect(app).toContain('event.key === "ArrowUp"');
    expect(app).toContain('event.key === "ArrowLeft"');
    expect(app).toContain('event.key === "Enter"');
    expect(html.indexOf('id="playerMiniGuide"')).toBeLessThan(html.indexOf('id="playerControls"'));
    expect(styles).toMatch(/\.player-mini-guide \{[\s\S]*?position: absolute[\s\S]*?z-index: 9/s);
    expect(`${html}\n${app}`).not.toMatch(/AccessToken|api_key|X-Emby-Token/);
  });

  it("keeps guide artwork stable across scroll and time-marker updates", async () => {
    const [renderer, styles] = await Promise.all([
      readFile("src/renderer/app.ts", "utf8"),
      readFile("src/renderer/styles.css", "utf8"),
    ]);
    const artwork = renderer.slice(renderer.indexOf("function setLiveTvChannelLogo"), renderer.indexOf("function createLiveTvChannelIdentity"));
    const markerUpdate = renderer.slice(renderer.indexOf("function updateLiveTvTimeMarkers"), renderer.indexOf("async function refreshLiveTv"));
    const catalogRefresh = renderer.slice(renderer.indexOf("async function refreshVisibleCatalog"), renderer.indexOf("function downloadForItem"));
    expect(artwork).toContain('image.loading = "eager"');
    expect(artwork).not.toContain('image.loading = "lazy"');
    expect(artwork).toContain("liveTvArtworkUrls.get(key)");
    expect(markerUpdate).not.toContain("renderLiveTv()");
    expect(catalogRefresh).toContain("updateLiveTvTimeMarkers();");
    expect(catalogRefresh).not.toContain("await refreshLiveTv(false);");
    expect(styles).toMatch(/\.live-tv-channel-number \{[\s\S]*?min-width: 3\.25rem;[\s\S]*?white-space: nowrap;/);
  });

  it("uses one fixed horizontal timeline and program-level guide jumps", async () => {
    const [renderer, styles] = await Promise.all([
      readFile("src/renderer/app.ts", "utf8"),
      readFile("src/renderer/styles.css", "utf8"),
    ]);
    expect(renderer).toContain("LIVE_TV_HALF_HOUR_PX");
    expect(renderer).toContain("guideScrollLeftForTime");
    expect(renderer).toContain("focusPendingGuideTarget");
    expect(styles).toMatch(/\.live-tv-grid \{[\s\S]*?overflow: auto[\s\S]*?scrollbar-gutter: stable both-edges;/);
    expect(styles).toMatch(/grid-template-columns: var\(--live-tv-channel-width\) var\(--live-tv-track-width\)/);
  });

  it("uses a dedicated inert native viewport with sibling controls", async () => {
    const html = await readFile("src/renderer/index.html", "utf8");
    const player = html.slice(html.indexOf('<section id="playerView"'), html.indexOf('<div id="downloadsScrim"'));
    expect(player).toContain('id="playerViewport"');
    expect(player).not.toMatch(/<video\b/i);
    expect(player.indexOf('id="playerViewport"')).toBeLessThan(player.indexOf('id="playerControls"'));
    expect(player).toContain('id="playerCenter"');
    expect(player).toContain('aria-label="Native video surface"');
    expect(player).toContain('aria-label="Playback controls"');
  });

  it("provides the required controls and contextual Session Panel without enabling chat", async () => {
    const html = await readFile("src/renderer/index.html", "utf8");
    for (const id of [
      "playerTimeline",
      "playerVolume",
      "playerPlayPauseButton",
      "playerBack10Button",
      "playerForward10Button",
      "playerRateSelect",
      "playerAudioSelect",
      "playerSubtitleSelect",
      "playerFullscreenButton",
      "playerNextButton",
      "playerSettingsMenu",
      "playerSettingsRateSelect",
      "playerSettingsAudioSelect",
      "playerSettingsSubtitleSelect",
      "playerAdapterSelect",
      "playerAdapterStatus",
      "sessionPanel",
      "sessionSoloTab",
      "sessionWatchpartyTab",
      "sessionChatTab",
    ]) expect(html).toContain(`id="${id}"`);
    expect(html).toMatch(/id="sessionChatTab"[^>]*aria-disabled="true"[^>]*disabled/);
    expect(html).toMatch(/id="playerSettingsButton"[^>]*aria-controls="playerSettingsMenu"[^>]*aria-expanded="false"/);
    expect(html).toMatch(/id="openSessionPanelButton"[^>]*aria-controls="sessionPanel"[^>]*aria-expanded="true"/);
  });

  it("offers an actionable automatic Next Episode countdown above the video surface", async () => {
    const [html, styles, renderer, preload] = await Promise.all([
      readFile("src/renderer/index.html", "utf8"),
      readFile("src/renderer/styles.css", "utf8"),
      readFile("src/renderer/app.ts", "utf8"),
      readFile("src/preload/index.ts", "utf8"),
    ]);
    for (const id of [
      "nextEpisodeCountdown",
      "nextEpisodeCountdownTitle",
      "nextEpisodeCountdownProgress",
      "nextEpisodePlayNowButton",
      "nextEpisodeCancelButton",
    ]) expect(html).toContain(`id="${id}"`);
    expect(styles).toMatch(/\.next-episode-countdown \{[^}]*position: absolute[^}]*z-index: 6/s);
    expect(styles).toContain('[data-controls-overlay="true"] .next-episode-countdown');
    expect(renderer).toContain("playback?.nextEpisodeCountdown");
    expect(renderer).toContain("window.jellyfin.playback.continueNextEpisode");
    expect(renderer).toContain("window.jellyfin.playback.cancelNextEpisode");
    expect(preload).toContain("IPC.playbackContinueNextEpisode");
    expect(preload).toContain("IPC.playbackCancelNextEpisode");
  });

  it("offers a libmpv-only in-player season and episode browser", async () => {
    const [html, styles, renderer] = await Promise.all([
      readFile("src/renderer/index.html", "utf8"),
      readFile("src/renderer/styles.css", "utf8"),
      readFile("src/renderer/app.ts", "utf8"),
    ]);
    for (const id of [
      "playerEpisodeBrowser",
      "playerEpisodeBrowserButton",
      "closePlayerEpisodeBrowserButton",
      "playerEpisodeSeasonSelect",
      "playerEpisodeBrowserStatus",
      "playerEpisodeList",
    ]) expect(html).toContain(`id="${id}"`);
    expect(html).toMatch(/id="playerEpisodeBrowserButton"[^>]*aria-controls="playerEpisodeBrowser"/);
    expect(styles).toContain('.player-view:not([data-active-adapter="libmpv"]) .player-episode-browser');
    expect(styles).toMatch(/\.player-episode-browser \{[^}]*position: absolute[^}]*z-index: 7/s);
    expect(styles).toContain('.player-episode-entry[aria-current="true"]');
    expect(renderer).toContain("window.jellyfin.shows.getSeasons({ itemId: seriesId })");
    expect(renderer).toContain("window.jellyfin.shows.getEpisodes({ seriesId, seasonId })");
    expect(renderer).toContain('playerAdapterPreference?.active !== "libmpv"');
    expect(renderer).toContain("void playItem(episode)");
    expect(renderer).toContain("state.playerEpisodeBrowserRequestId += 1");
  });

  it("keeps episode UI hiccups bounded and makes player close silence-first", async () => {
    const [renderer, bridge, player] = await Promise.all([
      readFile("src/renderer/app.ts", "utf8"),
      readFile("src/main/services/libMpvElectronBridge.ts", "utf8"),
      readFile("src/main/services/mpvPlayer.ts", "utf8"),
    ]);
    const closePlayer = renderer.slice(
      renderer.indexOf("async function closePlayer()"),
      renderer.indexOf("window.jellyfin.playback.subscribe"),
    );
    expect(closePlayer.indexOf("window.jellyfin.playback.stop")).toBeLessThan(closePlayer.indexOf("syncPlayerViewport(false)"));
    expect(renderer).toContain("focus({ preventScroll: true })");
    expect(renderer).toContain("const scrollTop = playerCenter.scrollTop");
    expect(bridge).toContain("const PRESENTATION_ACK_TIMEOUT_MS = 5_000");
    expect(bridge).toContain('producer.command(["set", "pause", "yes"])');
    expect(bridge).toContain('producer.command(["stop"])');
    const nativeStop = player.slice(player.indexOf("async stop("), player.indexOf("async clear()"));
    expect(nativeStop.indexOf('command(["quit"])')).toBeLessThan(nativeStop.indexOf('this.report("stop"'));
    expect(nativeStop).toContain("this.libMpvHost?.stop()");
  });

  it("presents playback started by Companion Remote in the desktop player shell", async () => {
    const renderer = await readFile("src/renderer/app.ts", "utf8");
    expect(renderer).toContain("async function presentExternallyStartedPlayback");
    expect(renderer).toContain('playerMeta.textContent = "Started from Companion Remote"');
    expect(renderer).toContain("if (externallyStarted) void presentExternallyStartedPlayback(playback)");
    expect(renderer).toContain("dismissedPlaybackId = playbackId");
  });

  it("keeps Watch now stable and checks progressive eligibility only on selection", async () => {
    const renderer = await readFile("src/renderer/app.ts", "utf8");
    expect(renderer).toContain("const progressiveAttemptAvailable");
    expect(renderer).toContain('play.className = "primary"');
    expect(renderer).toContain("Watch now checks whether enough video has buffered.");
    expect(renderer).toContain('showToast(selected.state === "paused"');
    expect(renderer).toContain('"Still buffering. Try Watch now again shortly."');
    expect(renderer).toContain("progressiveOnly,");
    expect(renderer).toContain("...(presentation.progressiveOnly ? { progressiveOnly: true } : {})");
  });

  it("adds a local-only Downloaded library from verified offline-playable copies", async () => {
    const [html, renderer] = await Promise.all([
      readFile("src/renderer/index.html", "utf8"),
      readFile("src/renderer/app.ts", "utf8"),
    ]);
    expect(renderer).toContain('const DOWNLOADED_LIBRARY_ID = "seeing-stone:downloaded"');
    expect(renderer).toContain("state.offlinePlayable.length");
    expect(renderer).toContain("state.offlinePlayable.map((entry) => entry.item)");
    expect(renderer).toContain("syncDownloadedLibrary();");
    expect(renderer).toContain("openDetails(selected, { alreadyLoaded: true })");
    expect(html).toContain('id="selectDownloadedButton"');
    expect(html).toContain('id="deleteSelectedDownloadedButton"');
    expect(html).toContain('id="downloadedFollowedSeriesList"');
    expect(renderer).toContain("async function deleteSelectedDownloads()");
    expect(renderer).toContain("window.jellyfin.smartDownloads.skip({ downloadId: download.downloadId })");
    expect(renderer).toContain("window.jellyfin.downloads.delete({ downloadId: download.downloadId })");
    expect(renderer).toContain("for (const series of state.smartDownloads.series)");
    const downloadSubscription = renderer.slice(
      renderer.indexOf("window.jellyfin.downloads.subscribe"),
      renderer.indexOf("window.jellyfin.smartDownloads.subscribe"),
    );
    expect(downloadSubscription).toContain("completedMembershipChanged");
    expect(downloadSubscription).toContain('state.selectedLibraryId !== DOWNLOADED_LIBRARY_ID');
  });

  it("gives home episode artwork and series titles separate navigation targets", async () => {
    const renderer = await readFile("src/renderer/app.ts", "utf8");
    expect(renderer).toContain("linkEpisodeSeries: true");
    expect(renderer).toContain("row.linkEpisodeSeries ? openEpisodeSeriesFromCard : undefined");
    expect(renderer).toContain("seriesButton.dataset.seriesLink = item.seriesId!");
    expect(renderer).toContain('button.setAttribute("aria-label", `Open episode ${item.name}`)');
    expect(renderer).toContain("async function openEpisodeSeriesFromCard");
    expect(renderer).toContain("preferredSeasonId: episode.seasonId");
  });

  it("bundles local fonts, responsive layouts, reduced motion, and visible focus", async () => {
    const styles = await readFile("src/renderer/styles.css", "utf8");
    expect(styles).toContain('./assets/fonts/InterVariable.woff2');
    expect(styles).toContain('./assets/fonts/Spectral-Regular.ttf');
    expect(styles).toContain('@media (max-width: 1120px)');
    expect(styles).toContain('@media (max-width: 880px)');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(styles).toMatch(/button:focus-visible,[\s\S]*?outline:\s*2px solid var\(--accent\)/);
  });

  it("exposes licenses from the generated inventory and removes temporary branding", async () => {
    const [html, renderer, security] = await Promise.all([
      readFile("src/renderer/index.html", "utf8"),
      readFile("src/renderer/app.ts", "utf8"),
      readFile("src/main/electronSecurity.ts", "utf8"),
    ]);
    expect(html).toContain('id="licensesPanel"');
    expect(renderer).toContain("window.jellyfin.licenses.list()");
    expect(`${html}\n${renderer}`).not.toContain("LocalFirst");
    expect(security).toContain('".woff2": "font/woff2"');
    expect(security).toContain('".ttf": "font/ttf"');
  });

  it("offers sanitized clean-machine diagnostics with controlled copy and save actions", async () => {
    const [html, renderer, preload] = await Promise.all([
      readFile("src/renderer/index.html", "utf8"),
      readFile("src/renderer/app.ts", "utf8"),
      readFile("src/preload/index.ts", "utf8"),
    ]);
    for (const id of [
      "loginCleanMachineDiagnosticsButton",
      "cleanMachineDiagnosticsButton",
      "cleanMachineDiagnosticsPanel",
      "cleanMachineDiagnosticsChecks",
      "copyCleanMachineDiagnosticsButton",
      "saveCleanMachineDiagnosticsButton",
    ]) expect(html).toContain(`id="${id}"`);
    expect(renderer).toContain("window.jellyfin.diagnostics.getCleanMachine()");
    expect(renderer).toContain("window.jellyfin.diagnostics.copyCleanMachine()");
    expect(renderer).toContain("window.jellyfin.diagnostics.saveCleanMachine()");
    expect(preload).not.toMatch(/filePath|driverName|gpuDevice|nativeHandle/);
  });

  it("keeps controls visible whenever focus is inside them", async () => {
    const styles = await readFile("src/renderer/styles.css", "utf8");
    const renderer = await readFile("src/renderer/app.ts", "utf8");
    expect(styles).toContain('.player-controls:not(:focus-within)');
    expect(renderer).toContain('!playerControls.contains(document.activeElement)');
    expect(renderer).toContain('playerView.addEventListener("focusin", markPlayerActivity)');
  });

  it("shows fixed built-in libmpv engine details in production while retaining development selectors", async () => {
    const [html, renderer] = await Promise.all([
      readFile("src/renderer/index.html", "utf8"),
      readFile("src/renderer/app.ts", "utf8"),
    ]);
    for (const id of ["playerAdapterSelectSetting", "profileAdapterSelectSetting"]) {
      expect(html).toContain(`id="${id}" class=`);
    }
    for (const id of ["playerAdapterFixed", "profileAdapterFixed"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("Built-in playback engine");
    expect(renderer).toContain("preference.adapterSelectionAvailable");
    expect(renderer).toContain('classList.toggle("is-hidden", !selectionAvailable)');
    expect(renderer).toContain('classList.toggle("is-hidden", selectionAvailable)');
  });

  it("offers an explicit server catalog refresh while keeping show libraries paginated", async () => {
    const [html, renderer] = await Promise.all([
      readFile("src/renderer/index.html", "utf8"),
      readFile("src/renderer/app.ts", "utf8"),
    ]);
    expect(html).toContain('id="refreshLibrariesButton"');
    expect(html).toContain("Refresh Media Libraries");
    expect(renderer).toContain("state.libraryCache.clear()");
    expect(renderer).toContain('options.requestExactTotal === true || type === "Series"');
    expect(renderer).toContain("refreshMediaLibraries()");
  });

  it("provides a control-safe cinema fullscreen with idle restoration behavior", async () => {
    const [styles, renderer, preload] = await Promise.all([
      readFile("src/renderer/styles.css", "utf8"),
      readFile("src/renderer/app.ts", "utf8"),
      readFile("src/preload/index.ts", "utf8"),
    ]);
    expect(styles).toContain('--cinema-control-band: 56px');
    expect(styles).toContain('--cinema-control-band: 3px');
    expect(styles).toContain('.player-view[data-fullscreen="true"] .player-rail');
    expect(styles).toContain('.player-view[data-fullscreen="true"] .session-panel');
    expect(styles).toContain('.player-view[data-fullscreen="true"] .player-metadata');
    expect(styles).toContain('grid-template-rows: minmax(0, 1fr) var(--cinema-control-band)');
    expect(styles).toContain('[data-controls-overlay="true"]');
    expect(styles).toContain('--cinema-control-band: 0px');
    expect(styles).toContain('position: absolute');
    expect(renderer).toContain('playerView.dataset.activeAdapter = preference.active');
    expect(renderer).toContain('playerAdapterPreference?.active === "libmpv"');
    expect(renderer).toContain('playerFrame.append(playerControls)');
    expect(renderer).toContain('window.addEventListener("pointermove"');
    expect(preload).toContain('libmpvSurface.style.zIndex = "1"');
    expect(preload).toContain('libmpvBackSurface.style.zIndex = "2"');
    expect(preload).not.toContain("libmpvSurfaceLayer");
    expect(styles).toMatch(/\.player-viewport \{[^}]*isolation: isolate[^}]*z-index: 0/s);
    expect(styles).toContain('.player-view.is-controls-idle[data-fullscreen="true"]');
    expect(styles).toContain('cursor: none');
    expect(styles).toContain('[data-controls-overlay="true"] .player-timeline-row');
    expect(styles).toContain('[data-controls-overlay="true"] #playerTimeline');
    expect(styles).toMatch(/\[data-controls-overlay="true"\] \.player-controls:not\(:focus-within\) \{\s*display: none;/);
    expect(renderer).toContain('playback.phase === "playing" && playback.paused === false');
    expect(renderer).toContain('playerViewport.addEventListener("click"');
    expect(renderer).toContain('playerViewport.addEventListener("dblclick"');
    expect(renderer).toContain("if (!playbackForPlayer()?.fullscreen) return");
    expect(renderer).toContain("if (playbackForPlayer()?.fullscreen) void togglePlayerPaused()");
    expect(renderer).toContain("playerViewportClickTimer = null");
    expect(renderer).toContain('if (playbackForPlayer()?.fullscreen) togglePlayerFullscreen()');
    expect(renderer).toContain('requestAnimationFrame(() => requestAnimationFrame(schedulePlayerViewport))');
  });

  it("uses available windowed width while reserving enough height for controls", async () => {
    const styles = await readFile("src/renderer/styles.css", "utf8");
    expect(styles).toContain("--windowed-player-width: min(100%, max(420px, calc(177.78vh - 450px)))");
    expect(styles).toMatch(/\.seeing-frame \{[^}]*max-width: none[^}]*width: var\(--windowed-player-width\)/s);
    expect(styles).toMatch(/\.player-controls \{[^}]*max-width: none[^}]*width: var\(--windowed-player-width\)/s);
    expect(styles).toMatch(/\.player-metadata \{[^}]*max-width: none[^}]*width: var\(--windowed-player-width\)/s);
    expect(styles).not.toContain(".player-viewport { max-height: calc(100vh - 330px); }");
  });

  it("keeps compact playback options reachable through the real settings surface", async () => {
    const [html, styles, renderer] = await Promise.all([
      readFile("src/renderer/index.html", "utf8"),
      readFile("src/renderer/styles.css", "utf8"),
      readFile("src/renderer/app.ts", "utf8"),
    ]);
    expect(html).toContain('role="dialog" aria-labelledby="playerSettingsTitle"');
    expect(html).toContain("Open playback diagnostics");
    expect(styles).not.toContain(".compact-control:nth-of-type(2)");
    expect(styles).toContain(".player-settings-grid { grid-template-columns: 1fr; }");
    expect(renderer).toContain("playerSettingsRateSelect.addEventListener");
    expect(renderer).toContain("playerSettingsAudioSelect.addEventListener");
    expect(renderer).toContain("playerSettingsSubtitleSelect.addEventListener");
    expect(renderer).toContain("window.jellyfin.playback.setAdapterPreference");
    expect(renderer).toContain("closePlayerSettings()");
  });

  it("keeps a readable fallback reason visible after libmpv initialization fails", async () => {
    const [html, styles, renderer] = await Promise.all([
      readFile("src/renderer/index.html", "utf8"),
      readFile("src/renderer/styles.css", "utf8"),
      readFile("src/renderer/app.ts", "utf8"),
    ]);
    expect(html).toContain('id="playerFallbackNotice"');
    expect(html).toContain('id="playerFallbackNoticeMessage"');
    expect(styles).toContain(".player-fallback-notice");
    expect(renderer).toContain('playerFallbackNotice.classList.remove("is-hidden")');
    expect(renderer).toContain("await refreshPlayerAdapterPreference();");
    expect(html).toContain("The saved Libmpv selection has not changed");
  });

  it("does not rebuild dynamic panel content for every position tick", async () => {
    const renderer = await readFile("src/renderer/app.ts", "utf8");
    expect(renderer).toContain("let playerStructuralRenderKey");
    expect(renderer).toContain("if (forceStructure || structureKey !== playerStructuralRenderKey)");
    expect(renderer).toContain("const advancedOpen = Boolean");
    expect(renderer).toContain("const activeAction = activeElement?.dataset.sessionAction");
  });

  it("keeps Watch Party timing controls in the local Earlier/Later sign convention", async () => {
    const renderer = await readFile("src/renderer/app.ts", "utf8");
    expect(renderer).toContain('earlier.addEventListener("click", () => { void setWatchPartySyncOffset(Math.min(2000, offset + 100), earlier); });');
    expect(renderer).toContain('later.addEventListener("click", () => { void setWatchPartySyncOffset(Math.max(-2000, offset - 100), later); });');
    expect(renderer).toContain('reset.addEventListener("click", () => { void setWatchPartySyncOffset(0, reset); });');
  });

  it("preserves a visible safe terminal state after forced player termination", async () => {
    const renderer = await readFile("src/renderer/app.ts", "utf8");
    expect(renderer).toContain("const lostActivePlayback");
    expect(renderer).toContain('playback.phase === "disconnected"');
    expect(renderer).toContain("void syncPlayerViewport(false)");
    expect(renderer).toContain("Replay available");
    expect(renderer).toContain("await playItem(state.playbackItem)");
    expect(renderer).not.toContain('playerView.classList.add("is-hidden");\n  document.body.classList.remove("is-playing");\n  void syncPlayerViewport(false);\n  state.lastFocusElement?.focus?.();');
  });

  it("reconciles the native host on player scrolling and hides it outside the scrollport", async () => {
    const renderer = await readFile("src/renderer/app.ts", "utf8");
    expect(renderer).toContain('playerCenter.addEventListener("scroll", schedulePlayerViewport');
    expect(renderer).toContain("const fullyInsideScrollport = bounds.left >= scrollport.left");
    expect(renderer).toContain("visible: visible && fullyInsideScrollport");
  });

  it("keeps the offline catalog network-free by rendering cached placeholders", async () => {
    const renderer = await readFile("src/renderer/app.ts", "utf8");
    expect(renderer).toContain('}, "Play offline", false)');
    expect(renderer).toContain("if (loadArtwork)");
    expect(renderer).toContain('image.classList.add("is-hidden")');
  });

  it("revalidates open library views so newly added server items appear without restarting", async () => {
    const renderer = await readFile("src/renderer/app.ts", "utf8");
    expect(renderer).toContain("await refreshLibrary(library, true)");
    expect(renderer).toContain("!state.libraryRequestGate.isCurrent(requestToken)");
    expect(renderer).toContain("window.setInterval(() => { void refreshVisibleCatalog(); }, CATALOG_REFRESH_INTERVAL_MS)");
    expect(renderer).toContain('window.addEventListener("focus", () => { void refreshVisibleCatalog(); })');
    expect(renderer).toContain('document.addEventListener("visibilitychange"');
    expect(renderer).toContain("if (!document.hidden) void refreshVisibleCatalog()");
  });

  it("hides a stale trickplay image before requesting the newly targeted sprite", async () => {
    const renderer = await readFile("src/renderer/app.ts", "utf8");
    const schedule = renderer.slice(renderer.indexOf("function scheduleTrickplaySprite"), renderer.indexOf("function renderPlayerState"));
    expect(schedule.indexOf('previewPendingUrl = "";')).toBeLessThan(schedule.indexOf("setTimeout"));
    expect(schedule.indexOf('playerTimelinePreviewImage.classList.add("is-hidden")')).toBeLessThan(schedule.indexOf("setTimeout"));
  });

  it("builds both library rails from every server-provided user view", async () => {
    const [renderer, api] = await Promise.all([
      readFile("src/renderer/app.ts", "utf8"),
      readFile("src/main/services/jellyfinApi.ts", "utf8"),
    ]);
    expect(renderer).toContain("function navigationLibraries()");
    expect(renderer).toContain("navigation.map((library) => createLibraryNavigationButton(library, false))");
    expect(renderer).toContain("navigation.map((library) => createLibraryNavigationButton(library, true))");
    expect(renderer).toContain("label.textContent = library.name");
    expect(api).toContain('type === "Mixed" ? "Movie,Series,Video,MusicVideo" : type');
    expect(renderer).toContain("button.disabled = itemType === null");
    expect(renderer).toContain('collectionType !== "boxsets" && collectionType !== "livetv"');
  });

  it("exposes Smart Downloads through series details and the local download manager", async () => {
    const [html, renderer] = await Promise.all([
      readFile("src/renderer/index.html", "utf8"),
      readFile("src/renderer/app.ts", "utf8"),
    ]);
    expect(html).toContain('id="detailSmartDownloadsButton"');
    expect(html).toContain('id="smartDownloadsList"');
    expect(html).toContain('id="smartDownloadEpisodeLimit"');
    expect(html).toContain('id="smartUnfollowDialog"');
    expect(renderer).toContain("window.jellyfin.smartDownloads.follow");
    expect(renderer).toContain("window.jellyfin.smartDownloads.checkNow");
    expect(renderer).toContain('download.smartManaged ? "Smart download" : ""');
    expect(renderer).toContain('skip.textContent = download.canDelete ? "Remove & skip" : "Skip episode"');
  });

  it("offers sanitized movie version selection across playback, downloads, and diagnostics", async () => {
    const [html, renderer, preload] = await Promise.all([
      readFile("src/renderer/index.html", "utf8"),
      readFile("src/renderer/app.ts", "utf8"),
      readFile("src/preload/index.ts", "utf8"),
    ]);
    for (const id of ["detailVersionControl", "detailVersionSelect", "detailVersionNote"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain("Auto / Best Available");
    expect(renderer).toContain("window.jellyfin.mediaSources.getVersions");
    expect(renderer).toContain("preferredMediaSourceId");
    expect(renderer).toContain('{ label: "Version", value: diagnostics.versionLabel }');
    expect(preload).toContain("mediaSourcesGetVersions");
    expect(`${html}\n${renderer}\n${preload}`).not.toMatch(/api_key|AccessToken|X-Emby-Token/);
  });

  it("keeps essential text and state colors at readable contrast", async () => {
    const styles = await readFile("src/renderer/styles.css", "utf8");
    const token = (name: string): string => {
      const match = styles.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"));
      if (!match) throw new Error(`Missing color token ${name}`);
      return match[1];
    };
    const channel = (value: number): number => {
      const normalized = value / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (hex: string): number => {
      const value = Number.parseInt(hex.slice(1), 16);
      return 0.2126 * channel((value >> 16) & 255) + 0.7152 * channel((value >> 8) & 255) + 0.0722 * channel(value & 255);
    };
    const ratio = (foreground: string, background: string): number => {
      const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (values[0] + 0.05) / (values[1] + 0.05);
    };
    const background = token("ss-obsidian");
    for (const foreground of ["text", "muted", "ss-lavender", "ss-blue", "ss-green", "ss-amber", "ss-rose"]) {
      expect(ratio(token(foreground), background), `${foreground} against ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
