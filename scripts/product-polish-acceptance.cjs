"use strict";
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { join, resolve, sep } = require("node:path");
const output = resolve(__dirname, "../artifacts/product-polish");

if (!process.versions.electron) {
  mkdirSync(output, { recursive: true });
  const env = { ...process.env, POLISH_PROFILE: mkdtempSync(join(output, "profile-")) };
  delete env.ELECTRON_RUN_AS_NODE;
  let child;
  try {
    child = spawnSync(require("electron"), [__filename], { env, windowsHide: true, stdio: "inherit", timeout: 120000 });
  } finally {
    const profile = resolve(env.POLISH_PROFILE);
    if (!profile.startsWith(output + sep + "profile-")) throw Error("Refusing unexpected fixture cleanup path");
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} else main().catch(error => { console.error(error); require("electron").app.exit(1); });

async function main() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", process.env.POLISH_PROFILE);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("force-prefers-reduced-motion");
  await app.whenReady();
  const window = new BrowserWindow({ width: 1440, height: 950, show: false, webPreferences: {
    preload: join(__dirname, "product-polish-preload.cjs"), sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  const errors = [];
  window.webContents.on("console-message", details => { if (details.level === "error") errors.push(details.message); });
  const js = async source => {
    try { return await window.webContents.executeJavaScript(source); }
    catch (error) { throw new Error(`${source}\n${errors.join("\n")}\n${error.message}`); }
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async source => {
    for (let i = 0; i < 150; i++) { if (await js(source)) return; await wait(30); }
    throw Error(`Timed out: ${source}\n${errors.join("\n")}`);
  };
  const click = id => js(`document.getElementById(${JSON.stringify(id)}).click()`);
  const capture = async filename => {
    await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    await wait(100);
    writeFileSync(join(output, filename), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  };
  await window.loadFile(resolve(__dirname, "../dist/renderer/index.html"));
  await until("document.querySelectorAll('#homeRows .media-card').length >= 2");
  const passed = [];
  assert.deepEqual(await js("Array.from(document.querySelectorAll('[id]')).map(el=>el.id).filter((id,i,all)=>all.indexOf(id)!==i)"), []);
  passed.push("All desktop element IDs are unique");
  await capture("home-wide.png");

  await js("document.querySelector('#homeRows .media-card').click()");
  await until("!!document.querySelector('#episodeList .retry-state button')");
  await js("document.querySelector('#episodeList .retry-state button').click()");
  await until("document.querySelector('#episodeList .retry-state')?.textContent.includes('Episodes')");
  await js("document.querySelector('#episodeList .retry-state button').click()");
  await until("!!document.querySelector('#episodeList .episode-title-button')");
  passed.push("Season and episode failures recover using inline Retry");
  await capture("series-wide.png");
  await js("document.querySelector('#episodeList .episode-title-button').click()");
  await until("document.getElementById('detailTitle').textContent === 'The Hidden Gate'");
  await click("detailsBackButton");
  await until("document.getElementById('detailTitle').textContent === 'The Shattered Vale'");
  await click("detailsBackButton");
  assert.equal(await js("document.getElementById('homeView').classList.contains('is-hidden')"), false);
  passed.push("Nested episode details return through the series to the original route");

  await click("navDownloadsButton");
  await until("document.querySelectorAll('#downloadsList .download-card').length === 2");
  assert.equal(await js("document.querySelector('#downloadsList .download-card strong').textContent"), "A Distant Light");
  await js("document.getElementById('downloadsSort').value='oldest'; document.getElementById('downloadsSort').dispatchEvent(new Event('change'))");
  assert.equal(await js("document.querySelector('#downloadsList .download-card strong').textContent"), "The Hidden Gate");
  await js("window.savedDownloadButton=document.querySelector('#downloadsList button'); savedDownloadButton.focus(); window.polishFixture.progress()");
  assert.equal(await js("savedDownloadButton.isConnected && document.activeElement === savedDownloadButton"), true);
  passed.push("Download sorting respects creation order; progress retains focused controls");
  await capture("downloads-wide.png");

  await js("document.getElementById('navCompanionButton').focus(); document.getElementById('navCompanionButton').click()");
  await until("!document.getElementById('companionPanel').classList.contains('is-hidden')");
  await js("document.getElementById('closeCompanionButton').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}))");
  assert.equal(await js("document.getElementById('companionPanel').contains(document.activeElement) && document.activeElement.id !== 'closeCompanionButton'"), true);
  await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
  assert.equal(await js("document.activeElement.id"), "navCompanionButton");
  await click("profileButton"); await click("licensesButton"); await click("closeLicensesButton");
  assert.equal(await js("document.activeElement.id"), "profileButton");
  passed.push("Dialogs trap Tab and return focus to a visible trigger");

  await click("navHomeButton");
  await js("window.polishFixture.delayDetails(200); document.querySelector('#homeRows .media-card').click(); document.getElementById('navDownloadsButton').click()");
  await wait(300);
  assert.equal(await js("document.getElementById('downloadsView').classList.contains('is-hidden')"), false);
  passed.push("Late details responses do not change the destination route");

  const search = async (query, options) => js(`window.polishFixture.configureSearch(${JSON.stringify(options)}); document.getElementById('searchInput').value=${JSON.stringify(query)}; document.getElementById('searchInput').dispatchEvent(new Event('input'))`);
  await search("fixture", { televisionDelay: 900, channels: true });
  await until("document.querySelectorAll('[data-search-source=library] .media-card').length === 2");
  assert.equal(await js("document.querySelector('[data-search-source=live-tv]').getAttribute('aria-busy')"), "true");
  await js("window.savedSearchCard=document.querySelector('[data-search-source=library] .media-card'); savedSearchCard.focus()");
  await until("!!document.querySelector('[data-search-source=live-tv] .live-tv-channel')");
  assert.equal(await js("savedSearchCard.isConnected && document.activeElement === savedSearchCard"), true);
  passed.push("Library search renders before a slow guide and keeps focus when TV results arrive");
  await capture("search-wide.png");

  await search("library failure", { mediaFails: true, channels: true });
  await until("!!document.querySelector('[data-search-source=library] .retry-state button') && !!document.querySelector('[data-search-source=live-tv] .live-tv-channel')");
  const tvCalls = await js("window.polishFixture.calls().filter(c=>c==='search:live-tv').length");
  await js("window.savedTvResult=document.querySelector('[data-search-source=live-tv] .live-tv-channel'); window.polishFixture.configureSearch({}); const retry=document.querySelector('[data-search-source=library] .retry-state button');retry.focus();retry.click();retry.click()");
  await until("document.querySelectorAll('[data-search-source=library] .media-card').length === 2");
  assert.equal(await js("savedTvResult.isConnected && document.activeElement.id==='searchInput'"), true);
  assert.equal(await js("window.polishFixture.calls().filter(c=>c==='search:live-tv').length"), tvCalls);
  passed.push("Failed library search preserves TV results and retries only the failed source");

  await search("guide failure", { televisionFails: true });
  await until("!!document.querySelector('[data-search-source=live-tv] .retry-state button') && !!document.querySelector('[data-search-source=library] .media-card')");
  await js("window.savedSearchCard=document.querySelector('[data-search-source=library] .media-card');savedSearchCard.focus();window.polishFixture.configureSearch({channels:true});document.querySelector('[data-search-source=live-tv] .retry-state button').click()");
  await until("!!document.querySelector('[data-search-source=live-tv] .live-tv-channel')");
  assert.equal(await js("savedSearchCard.isConnected && document.activeElement===savedSearchCard"), true);
  passed.push("Failed guide search preserves usable library results and recovers independently");

  await search("missing title", { emptyMedia: true });
  await until("document.querySelector('[data-search-source=library]')?.textContent.includes('No movies, shows, or episodes match')");
  assert.equal(await js("document.getElementById('searchRows').textContent.includes('Nothing to show yet.')"), false);
  passed.push("Empty searches explain that the requested title did not match");

  await search("old search", { mediaDelay: 800, mediaFails: true });
  await until("document.getElementById('searchTitle').textContent.includes('old search')");
  await search("new search", { emptyMedia: true });
  await until("document.querySelector('[data-search-source=library]')?.textContent.includes('match \"new search\"')");
  await wait(900);
  assert.equal(await js("!!document.querySelector('#searchRows .retry-state')"), false);
  passed.push("Late failures cannot overwrite a newer search");

  await js("document.querySelector('#mainLibraryNavigation [data-library-id=\"polish-library\"]').click()");
  await until("document.querySelectorAll('#libraryGrid .media-card').length === 2");
  assert.equal(await js("document.getElementById('libraryView').classList.contains('is-hidden')"), false);
  await click("libraryFiltersButton");
  await until("!!document.querySelector('#filter-section-genres input[data-filter-value=Mystery]')");
  assert.equal(await js("getComputedStyle(document.getElementById('filter-section-people')).display"), "none");
  assert.equal(await js("window.polishFixture.calls().filter(c=>c==='choices:people').length"), 0);
  await js("document.querySelector('#filter-section-genres input[data-filter-value=Mystery]').click();document.querySelector('[aria-controls=filter-section-people]').click()");
  await until("!!document.querySelector('#filter-section-people input[data-filter-value=off-page-person]')");
  await js("document.querySelector('#filter-section-people input[data-filter-value=off-page-person]').click()");
  await until("document.getElementById('libraryFilterChips').textContent.includes('Off-page Actor')");
  assert.equal(await js("window.polishFixture.calls().filter(c=>c.startsWith('browse:')).some(c=>{const q=JSON.parse(c.slice(7));return q.genres?.includes('Mystery')&&q.personIds?.includes('off-page-person')})"), true);
  assert.equal(await js("!!document.querySelector('#filter-section-genres .filter-option-count')"), false);
  assert.equal(await js("document.getElementById('libraryView').classList.contains('is-hidden') || document.getElementById('libraryFilterDrawer').classList.contains('is-hidden')"), false);
  await capture("library-wide-filters.png");
  passed.push("Library-wide genre and people choices apply filters beyond the current media page");
  await click("clearLibraryFiltersButton");
  await js("document.querySelector('#filter-section-quick input').click()");
  await until("document.querySelectorAll('#libraryFilterChips button').length === 1");
  await click("closeLibraryFiltersButton");
  await js("const chip=document.querySelector('#libraryFilterChips button');chip.focus();chip.click()");
  await wait(100);
  assert.equal(await js("document.activeElement.id"), "libraryFiltersButton");
  passed.push("Removing the last library filter keeps keyboard focus on Filters");

  await click("navHomeButton");
  await js("document.querySelectorAll('#homeRows .media-card')[1].click()");
  await until("document.getElementById('detailTitle').textContent === 'A Distant Light'");
  await click("detailPlayButton");
  await until("!document.getElementById('playerView').classList.contains('is-hidden')");
  await until("window.seeingStoneVisualAcceptance.getPlayback().phase === 'playing'");
  await js("document.activeElement.blur(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true}))");
  assert.equal(await js("window.seeingStoneVisualAcceptance.getPlayback().fullscreen"), false);
  await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',repeat:true,bubbles:true,cancelable:true}))");
  assert.equal(await js("window.seeingStoneVisualAcceptance.getPlayback().paused"), false);
  await js("const disclosure=document.createElement('details'); disclosure.id='polishDisclosure';disclosure.innerHTML='<summary>Room settings</summary>';document.getElementById('playerControls').append(disclosure);window.summaryEvent=new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true});disclosure.firstElementChild.dispatchEvent(summaryEvent)");
  assert.equal(await js("summaryEvent.defaultPrevented"), false);
  await js("document.getElementById('polishDisclosure').remove()");
  await capture("player-wide.png");
  passed.push("Modified and repeated playback shortcuts leave transport unchanged");
  await js("document.getElementById('playerOverview').style.minHeight='1200px'; document.getElementById('playerCenter').scrollTop=250; document.getElementById('playerCenter').dispatchEvent(new Event('scroll'))");
  await until("window.seeingStoneVisualAcceptance.getViewportInputs().at(-1)?.visible === false");
  await click("closePlayerButton");
  await click("detailPlayButton");
  await until("window.seeingStoneVisualAcceptance.getPlayback().phase === 'playing' && window.seeingStoneVisualAcceptance.getViewportInputs().at(-1)?.visible === true");
  assert.equal(await js("document.getElementById('playerCenter').scrollTop"), 0);
  await js("window.seeingStoneVisualAcceptance.clearViewportInputs(); window.dispatchEvent(new Event('focus'))");
  await until("window.seeingStoneVisualAcceptance.getViewportInputs().at(-1)?.visible === true");
  passed.push("Starting after scrolling reveals the video; window focus refreshes its native viewport");
  await js("document.getElementById('playerOverview').style.minHeight=''");
  await click("closePlayerButton");
  await js("document.getElementById('detailPlayButton').click();document.getElementById('closePlayerButton').click()");
  await wait(150);
  assert.equal(await js("document.getElementById('playerView').classList.contains('is-hidden') && window.seeingStoneVisualAcceptance.getPlayback().playbackId === null"), true);
  passed.push("Closing before playback presentation settles cancels the pending start");

  for (const width of [980, 700, 420]) {
    window.setSize(width, 850); await wait(100);
    await click("navDownloadsButton");
    assert.equal(await js("document.documentElement.scrollWidth <= innerWidth && document.getElementById('downloadsView').scrollWidth <= document.getElementById('contentScroller').clientWidth + 1"), true);
    await capture(`downloads-${width}.png`);
  }
  passed.push("Downloads fit 980px, 700px and 420px windows");
  await js("window.polishFixture.finishDownloads()");
  await until("!!document.querySelector('#mainLibraryNavigation [data-library-id=\"seeing-stone:downloaded\"]')");
  await js("document.querySelector('#mainLibraryNavigation [data-library-id=\"seeing-stone:downloaded\"]').click()");
  await until("!document.getElementById('selectDownloadedButton').disabled");
  await click("selectDownloadedButton");
  await until("!!document.querySelector('.downloaded-record-select')");
  await js("window.savedSelection=document.querySelector('.downloaded-record-select');savedSelection.focus();savedSelection.click()");
  assert.equal(await js("savedSelection.isConnected && document.activeElement===savedSelection && savedSelection.checked && savedSelection.getAttribute('aria-label').includes('Select ')"), true);
  assert.equal(await js("document.getElementById('deleteSelectedDownloadedButton').textContent"), "Delete selected (1)");
  await click("selectAllDownloadedButton");
  assert.equal(await js("savedSelection.isConnected && savedSelection.checked"), true);
  assert.equal(await js("document.getElementById('deleteSelectedDownloadedButton').textContent"), "Delete selected (2)");
  passed.push("Downloaded selection has an accessible name and retains its controls while selecting");
  await click("profileButton"); await click("logoutButton");
  await until("!document.getElementById('loginView').classList.contains('is-hidden')");
  await capture("login-420.png");
  await js("document.getElementById('serverUrlInput').value='http://127.0.0.1';document.getElementById('usernameInput').value='Fixture';document.getElementById('loginForm').requestSubmit();document.getElementById('loginForm').requestSubmit()");
  await wait(250);
  assert.equal(await js("window.polishFixture.calls().filter(c=>c==='login').length"), 1);
  passed.push("Repeated sign-in submits make one authentication request");
  assert.deepEqual(errors, []);
  writeFileSync(join(output, "result.json"), JSON.stringify({ passed, errors }, null, 2));
  console.log(`Product polish acceptance: ${passed.length} checks passed.`, passed);
  app.exit(0);
}
