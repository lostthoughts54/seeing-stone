"use strict";
// Called by iptv-beta-acceptance with its isolated profile and loopback IPTV fixture.
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { writeFileSync } = require("node:fs");

module.exports = async function auditNavigation({ window, js, waitFor, testBuild, output, providerId }) {
  const { ipcMain } = require("electron");
  const { IPC } = require(join(testBuild, "shared/contracts.js"));
  const library = { id: "fixture-movies", name: "My Movies", collectionType: "movies" };
  const movie = { id: "fixture-movie", name: "Navigation fixture", type: "Movie", overview: "Navigation acceptance",
    productionYear: 2026, premiereYear: 2026, officialRating: null, communityRating: null, runTimeTicks: 600000000,
    genres: [], people: [], primaryImageAspectRatio: null, imageTags: {}, backdropImageTag: null,
    parentThumbItemId: null, parentThumbImageTag: null, seriesId: null, seriesName: null, parentIndexNumber: null,
    indexNumber: null, userData: { played: false, playbackPositionTicks: 0, playedPercentage: 0 }, hasTrailer: false, playable: true };
  const safeSession = { authenticated: true, persistence: "none", user: { id: "fixture-user", name: "Fixture viewer" },
    server: { id: "fixture-server", name: "Fixture Jellyfin", address: "http://127.0.0.1", version: "10.11.11" } };
  const mock = (channel, handler) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, async (_event, input) => ({ ok: true, data: await handler(input) })); };
  mock(IPC.serverConnect, () => ({ connectionId: "fixture-connection" }));
  mock(IPC.sessionLogin, () => safeSession);
  let homeDelay = 350;
  mock(IPC.homeGet, async () => {
    await new Promise(resolve => setTimeout(resolve, homeDelay));
    return { libraries: [library], resumeItems: [], nextUpItems: [], latestRows: [{ library, items: [movie] }] };
  });
  mock(IPC.librariesList, () => [library]);
  mock(IPC.browseGet, () => ({ items: [movie], totalRecordCount: 1 }));
  mock(IPC.searchQuery, () => [movie]);
  mock(IPC.itemsGetDetails, () => movie);

  const visible = id => `!document.getElementById('${id}').classList.contains('is-hidden')`;
  const click = id => js(`document.getElementById('${id}').click()`);
  const assertRoute = async (id, button) => {
    await waitFor(visible(id));
    assert.deepEqual(await js(`Array.from(document.querySelectorAll('#contentScroller > .view')).filter(el => !el.classList.contains('is-hidden')).map(el => el.id)`), [id]);
    if (button) assert.equal(await js(`document.getElementById('${button}').getAttribute('aria-current')`), "page");
    assert.equal(await js("document.querySelectorAll('dialog[open]').length"), 0);
  };
  // Guest navigation retains a route into Jellyfin and never exposes dead server links.
  assert.equal(await js("document.getElementById('navHomeButton').disabled"), true);
  await click("headerJellyfinSignInButton");
  await waitFor(visible("loginView"));
  await click("loginIptvButton");
  await assertRoute("iptvView", "navIptvButton");
  await click("headerJellyfinSignInButton");
  await js("document.getElementById('serverUrlInput').value='http://127.0.0.1'; document.getElementById('usernameInput').value='fixture'; document.getElementById('loginForm').requestSubmit()");
  await waitFor("!document.getElementById('mainView').classList.contains('is-hidden') && !document.getElementById('navHomeButton').disabled");
  await click("navIptvButton");
  await new Promise(resolve => setTimeout(resolve, 600));
  await assertRoute("iptvView", "navIptvButton");
  homeDelay = 0;
  await js(`document.querySelector('[data-role=provider-select]').value=${JSON.stringify(providerId)}; document.querySelector('[data-role=provider-select]').dispatchEvent(new Event('change'))`);
  await waitFor("document.querySelectorAll('.iptv-item').length > 0");
  // Preserve IPTV type, search, category and page across sidebar navigation.
  await js("document.querySelector('[data-role=search]').value='日本'; document.querySelector('[data-role=search]').dispatchEvent(new Event('input'))");
  await waitFor("document.querySelectorAll('.iptv-item').length === 1");
  for (const [button, view] of [["navHomeButton", "homeView"], ["navDownloadsButton", "downloadsView"], ["navLiveTvButton", "liveTvView"], ["navWatchPartiesButton", "watchPartiesView"]]) {
    await click(button); await assertRoute(view, button);
    await click("navIptvButton"); await assertRoute("iptvView", "navIptvButton");
    assert.equal(await js("document.querySelector('.iptv-screen [data-role=search]').value"), "日本");
  }
  await click("navCompanionButton"); await waitFor(visible("companionPanel"));
  await click("closeCompanionButton"); await assertRoute("iptvView", "navIptvButton");
  await js("document.querySelector('#mainLibraryNavigation button').click()");
  await assertRoute("libraryView");
  await waitFor("document.querySelector('#libraryGrid .media-card')");
  await js("document.querySelector('#libraryGrid .media-card').click()");
  await assertRoute("detailsView");
  await click("detailsBackButton"); await assertRoute("libraryView");
  await click("navIptvButton");
  await js("document.getElementById('searchInput').value='fixture'; document.getElementById('searchInput').dispatchEvent(new Event('input')); document.getElementById('navDownloadsButton').click()");
  await new Promise(resolve => setTimeout(resolve, 450));
  await assertRoute("downloadsView", "navDownloadsButton");
  await js("document.getElementById('searchInput').value='fixture'; document.getElementById('searchInput').dispatchEvent(new Event('input'))");
  await assertRoute("searchView");
  await js("document.getElementById('searchInput').value=''; document.getElementById('searchInput').dispatchEvent(new Event('input'))");
  await assertRoute("downloadsView", "navDownloadsButton");
  // The original regression: a player-rail destination must not reopen IPTV over it.
  for (const [route, view, button] of [["home", "homeView", "navHomeButton"], ["iptv", "iptvView", "navIptvButton"], ["downloads", "downloadsView", "navDownloadsButton"], ["live-tv", "liveTvView", "navLiveTvButton"], ["watch-parties", "watchPartiesView", "navWatchPartiesButton"], ["companion", "iptvView", "navIptvButton"], ["library", "libraryView", null]]) {
    await click("navIptvButton");
    await waitFor("!!document.querySelector('.iptv-watch')");
    await js("document.querySelector('.iptv-watch').click()");
    await waitFor("window.jellyfin.playback.getState().then(state => state.phase === 'playing' && !!state.iptvIdentity)");
    if (route === "home") {
      await js("document.getElementById('playerView').querySelector('[data-player-route=now-playing]').click()");
      assert.equal(await js("document.getElementById('playerView').classList.contains('is-hidden')"), false);
    }
    if (route === "library") await js("document.querySelector('#playerLibraryNavigation button').click()");
    else await js(`document.getElementById('playerView').querySelector('[data-player-route="${route}"]').click()`);
    await waitFor("document.getElementById('playerView').classList.contains('is-hidden')");
    await assertRoute(view, button);
    if (route === "companion") { await waitFor(visible("companionPanel")); await click("closeCompanionButton"); }
  }
  await click("navIptvButton");
  writeFileSync(join(output, "navigation-desktop.png"), (await window.webContents.capturePage()).toPNG());
  window.setMinimumSize(400, 600); window.setSize(700, 900);
  await new Promise(resolve => setTimeout(resolve, 250));
  await click("mobileHomeButton"); await assertRoute("homeView", "navHomeButton");
  await click("mobileIptvButton"); await assertRoute("iptvView", "mobileIptvButton");
  assert.equal(await js("document.querySelector('.iptv-screen').scrollWidth <= document.querySelector('.iptv-screen').clientWidth + 1"), true);
  assert.equal(await js("document.querySelector('.iptv-main').clientWidth > document.querySelector('.iptv-screen').clientWidth * .85"), true);
  await js("document.getElementById('toast').classList.add('is-hidden')");
  writeFileSync(join(output, "navigation-narrow.png"), (await window.webContents.capturePage()).toPNG());
  window.setSize(420, 850);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await js("document.querySelector('.iptv-main').clientWidth > document.querySelector('.iptv-screen').clientWidth * .85"), true);
  assert.equal(await js("document.querySelector('.iptv-screen').scrollWidth <= document.querySelector('.iptv-screen').clientWidth + 1"), true);
  assert.equal(await js("document.querySelector('.iptv-pagination').getBoundingClientRect().bottom <= document.querySelector('.mobile-nav').getBoundingClientRect().top"), true);
  writeFileSync(join(output, "navigation-small.png"), (await window.webContents.capturePage()).toPNG());
  console.log("Navigation acceptance passed: guest/signed-in routes, all sidebar destinations, details/back, search races, IPTV playback exits, and narrow-window navigation.");
};
