"use strict";
// Isolated renderer regression fixture: no application profile, server or rebuild.
const { resolve, join } = require("node:path");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { pathToFileURL } = require("node:url");
const root = resolve(__dirname, "..");
const output = join(root, "artifacts/product-polish-modules");

if (!process.versions.electron) {
  mkdirSync(output, { recursive: true });
  require("esbuild").buildSync({
    stdin: { contents: ["playerFeatures", "iptv", "iptvMiniGuide", "youtubeSettings"].map(name => `export * from './src/renderer/${name}.ts';`).join("\n"), resolveDir: root },
    bundle: true, format: "iife", globalName: "PolishUI", outfile: join(output, "fixture.js"),
  });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require("node:child_process").spawnSync(require("electron"), [__filename, "--fixture-child"], { env, windowsHide: true, timeout: 45000, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  void run().catch(error => { console.error(error); require("electron").app.exit(1); });
}

async function run() {
  const { app, BrowserWindow } = require("electron");
  if (!process.argv.includes("--fixture-child")) throw new Error("Fixture wrapper required.");
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch("disable-gpu");
  app.setPath("userData", join(output, "electron-profile"));
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ["https://*/*", "http://*/*"] }, (_details, callback) => callback({ cancel: true }));
  writeFileSync(join(output, "fixture.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(join(root, "src/renderer/styles.css"))}"><link rel="stylesheet" href="fixture.css"><style>body{overflow:auto;background:#080f18;color:white}#contentScroller{height:850px}.is-hidden{display:none!important}</style></head><body><main id="watch"></main><section id="playerView" class="is-hidden"><aside id="sessionPanel"></aside></section><main id="contentScroller"></main><section id="playerMiniGuide" class="player-mini-guide"></section><form id="youtubeApiKeyForm"><input id="youtubeApiKeyInput"><button id="youtubeSaveKeyButton">Save</button><button id="youtubeRemoveKeyButton" type="button">Remove</button><p id="youtubeApiKeyStatus"></p></form></body></html>`);
  await window.loadFile(join(output, "fixture.html"));
  await window.webContents.executeJavaScript(readFileSync(join(output, "fixture.js"), "utf8"));
  const report = await window.webContents.executeJavaScript(`(async () => {
    const checks = [];
    const assert = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
    const settle = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
    const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
    const media = { kind: 'jellyfin', itemId: '1'.repeat(32), mediaSourceId: 'source', title: 'Film', durationTicks: 36000000000, version: 'fixture' };
    const room = { id: 'a'.repeat(32), name: 'Movie night', serverNow: Date.now(), owner: true, hostOnly: false, waitForAll: true, minimumParticipants: 2, autoNext: true,
      timeline: { version: 1, generation: 1, positionTicks: 0, playing: false, anchoredAt: Date.now(), startAt: null, nextAt: null, phase: 'waiting', targetRevision: 1 }, media,
      queue: [], members: [], messages: [], events: [] };
    const state = { connection: 'connected', error: null, rooms: [], local: { preparation: 'Ready', issue: null, delivery: 'Direct play', subtitles: 0, delaySeconds: 0, downloads: '' }, room };
    let render; let calls = []; let command = async () => state;
    window.jellyfin = { playerFeatures: { subscribe(listener) { render = listener; listener(state); return () => {}; }, command(input) { calls.push(input); return command(input); } }, search: { async query() { return []; } } };
    PolishUI.mountPlayerFeatures(document.getElementById('watch'));
    const panel = document.querySelector('.player-features');
    const message = panel.querySelector('[data-role=message]');
    const send = panel.querySelector('[data-command=chat]');
    command = async () => { throw new Error('Connection interrupted'); };
    message.value = 'Keep my message'; send.click(); await settle();
    assert(message.value === 'Keep my message', 'Failed chat keeps its draft');
    const pending = deferred(); command = () => pending.promise; calls = [];
    send.click(); send.click(); await settle();
    assert(calls.length === 1, 'Repeated send dispatches only once');
    message.value = 'A newer draft'; pending.resolve(state); await settle();
    assert(message.value === 'A newer draft', 'Send completion preserves newer typing');
    command = async () => state; calls = [];
    message.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await settle();
    assert(calls[0]?.text === 'A newer draft' && message.value === '', 'Enter submits and clears successful chat');
    calls = [];
    const seek = panel.querySelector('[data-role=seek]'); seek.value = '';
    panel.querySelector('[data-command=seek]').click(); await settle();
    assert(seek.validity.valueMissing && calls.length === 0, 'Empty room seek cannot jump playback to zero');
    const delay = panel.querySelector('[data-role=delay]'); delay.closest('details').open = true; delay.value = '';
    panel.querySelector('[data-command=timing]').click(); await settle();
    assert(delay.validity.valueMissing && calls.length === 0, 'Empty subtitle timing cannot reset the saved delay');
    room.owner = false; room.hostOnly = true; render(state);
    panel.querySelector('[data-command=seek]').click(); panel.querySelector('[data-command=skip]').click(); await settle();
    assert(seek.disabled && panel.querySelector('[data-command=seek]').disabled && panel.querySelector('[data-command=skip]').disabled && calls.length === 0, 'Host-only guests cannot invoke room seek or skip');
    room.owner = true; room.hostOnly = false; render(state);
    assert(!seek.disabled && !panel.querySelector('[data-command=seek]').disabled && !panel.querySelector('[data-command=skip]').disabled, 'Host regains room seek and skip controls');
    let phaseUpdates = 0;
    const phaseObserver = new MutationObserver(records => { phaseUpdates += records.length; });
    phaseObserver.observe(panel.querySelector('[data-role=phase]'), { childList: true, characterData: true, subtree: true });
    render(state); await settle(300); phaseObserver.disconnect();
    assert(phaseUpdates === 0, 'Unchanged room phase does not repeat live announcements');
    const originalConfirm = window.confirm; let confirmation = ''; calls = [];
    window.confirm = text => { confirmation = text; return false; }; panel.querySelector('[data-command=delete]').click(); await settle();
    assert(confirmation.includes(room.name) && confirmation.includes('everyone') && calls.length === 0, 'Cancelling room deletion preserves the shared room');
    window.confirm = () => true; panel.querySelector('[data-command=delete]').click(); await settle();
    assert(calls.length === 1 && calls[0].operation === 'delete', 'Confirmed room deletion dispatches once'); window.confirm = originalConfirm;
    const query = panel.querySelector('[data-role=search]'); query.value = 'Missing film';
    query.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await settle();
    assert(panel.querySelector('[data-role=results]').textContent.includes('No playable videos'), 'Room search explains empty results');
    const staleSearch = deferred(); window.jellyfin.search.query = () => staleSearch.promise;
    panel.querySelector('[data-command=search]').click(); query.value = 'Different title'; query.dispatchEvent(new Event('input'));
    staleSearch.reject(new Error('Old query failed')); await settle();
    assert(panel.querySelector('[data-role=results]').textContent === '', 'Stale search errors do not replace current input state');
    state.room = null; state.rooms = [{ id: room.id, name: room.name, connected: 1, updatedAt: 1, title: 'Film' }]; render(state);
    const join = panel.querySelector('[data-role=rooms] button'); join.focus(); render(state);
    assert(document.activeElement === join, 'Room polling preserves keyboard focus');
    document.getElementById('watch').hidden = true;

    const channel = (itemId, providerId = 'provider-a') => ({ identity: { providerId, contentType: 'live', itemId }, name: itemId, groupId: 'news', groupName: 'News', channelNumber: null, favourite: false, hidden: false });
    let catalogueCalls = []; let catalogue = async input => ({ items: [channel('One', input.providerId), channel('Two', input.providerId)], nextCursor: null });
    const provider = { provider: { providerId: 'provider-a', name: 'Fixture TV', kind: 'xtream' }, phase: 'ready', message: 'Connected', imported: 2, counts: { live: 2, movie: 0, series: 0 }, lastSuccessfulAt: '2026-01-01T00:00:00Z' };
    window.iptv = { catalogue(input) { catalogueCalls.push(input); return catalogue(input); }, async schedule() { return { programmes: [{ title: 'Evening news', description: 'Local stories and weather.', startUtc: new Date(Date.now() - 60000).toISOString(), endUtc: new Date(Date.now() + 3600000).toISOString() }], fetchedAt: new Date().toISOString(), stale: false }; }, async list() { return [provider]; }, async groups() { return [{ id: 'news', name: 'News', count: 2 }]; } };
    const guideRoot = document.getElementById('playerMiniGuide');
    const mini = PolishUI.mountIptvMiniGuide(guideRoot, () => {}, () => mini.close());
    mini.open(channel('One')); await settle();
    const oldSearch = guideRoot.querySelector('input'); oldSearch.value = 'Old'; oldSearch.dispatchEvent(new Event('input'));
    mini.open(channel('One', 'provider-b')); const mark = catalogueCalls.length; await settle(300);
    assert(!catalogueCalls.slice(mark).some(call => call.providerId === 'provider-a'), 'Reopening mini guide cancels old debounced searches');
    const miniSearch = guideRoot.querySelector('input'); miniSearch.focus();
    mini.handleKey(new KeyboardEvent('keydown', { key: 'ArrowDown' , bubbles: true }));
    // handleKey receives a real event target through the application event listener.
    const keyListener = event => mini.handleKey(event); guideRoot.addEventListener('keydown', keyListener);
    miniSearch.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    assert(document.activeElement.dataset.channelId === 'One', 'Down arrow enters mini guide channel list');
    miniSearch.focus(); miniSearch.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    assert(document.activeElement.dataset.channelId === 'Two', 'Up arrow enters at last channel');
    catalogue = async () => { throw Object.assign(new Error('Snapshot changed'), { code: 'IPTV_SNAPSHOT_STALE' }); };
    const staleMark = catalogueCalls.length; mini.open(channel('One')); await settle();
    assert(catalogueCalls.length - staleMark === 2 && !guideRoot.querySelector('[data-retry]').hidden, 'Stale mini-guide cursors retry once then expose Retry');
    catalogue = async input => ({ items: [channel('Recovered', input.providerId)], nextCursor: null });
    guideRoot.querySelector('[data-retry]').click(); await settle();
    assert(guideRoot.querySelector('.iptv-mini-channel').textContent.includes('Recovered') && guideRoot.querySelector('[data-retry]').hidden, 'Mini-guide Retry restores browsing');
    mini.close(); guideRoot.hidden = true; guideRoot.classList.add('is-hidden');

    // Hidden Chromium windows can suppress intersection delivery. Observe these
    // synthetic rows immediately; focus behaviour still runs against real DOM.
    window.IntersectionObserver = class {
      constructor(callback) { this.callback = callback; this.targets = new Set(); }
      observe(target) { this.targets.add(target); queueMicrotask(() => { if (this.targets.has(target)) this.callback([{ target, isIntersecting: true }], this); }); }
      unobserve(target) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); }
    };
    const iptv = PolishUI.mountIptv(async () => {}, () => {}); iptv.element.classList.remove('is-hidden'); iptv.setVisible(true); await settle();
    const category = iptv.element.querySelector('[data-role=group]'); category.value = 'news'; category.dispatchEvent(new Event('change')); await settle();
    provider.lastSuccessfulAt = '2026-01-02T00:00:00Z'; await settle(1600);
    assert(category.value === 'news' && catalogueCalls.at(-1).groupId === 'news', 'Provider refresh keeps the selected category');
    iptv.element.querySelector('[data-action=guide]').click(); window.scrollTo(0, 0); await settle(300);
    const programme = iptv.element.querySelector('.iptv-guide-programme');
    assert(programme, 'Observed guide rows receive programme details');
    programme.click(); iptv.element.querySelector('[data-role=programme-details] button:last-child').click();
    assert(document.activeElement === programme && iptv.element.querySelector('[data-role=programme-details]').hidden, 'Closing programme details restores its guide cell focus');
    programme.click(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert(document.activeElement === programme && iptv.element.querySelector('[data-role=programme-details]').hidden, 'Escape closes programme details and restores focus');
    iptv.element.querySelector('[data-action=providers]').click();
    assert(!iptv.element.classList.contains('is-guide-mode') && iptv.element.classList.contains('show-providers'), 'Manage providers opens from programme guide');
    catalogue = async () => { throw new Error('Provider unavailable'); };
    iptv.element.querySelector('[data-role=search]').value = 'Missing'; iptv.element.querySelector('[data-role=search]').dispatchEvent(new Event('input')); await settle(300);
    assert(!iptv.element.querySelector('[data-action=retry]').hidden && iptv.element.querySelector('[data-role=catalogue]').getAttribute('aria-busy') === 'false', 'Catalogue errors offer Retry and release loading state');
    catalogue = async input => ({ items: [channel('Recovered', input.providerId)], nextCursor: null });
    iptv.element.querySelector('[data-action=retry]').click(); await settle();
    assert(iptv.element.querySelector('[data-role=catalogue]').textContent.includes('Recovered'), 'Catalogue Retry restores results');
    iptv.setVisible(false);

    const staleSettings = deferred();
    const settings = PolishUI.mountYouTubeSettings({ getYouTubeSearchSettings: () => staleSettings.promise, async setYouTubeApiKey() { return { source: 'saved', storageUnavailable: false }; } });
    void settings.load(); document.getElementById('youtubeApiKeyInput').value = 'A'.repeat(30);
    document.getElementById('youtubeApiKeyForm').dispatchEvent(new Event('submit', { cancelable: true })); await settle();
    staleSettings.resolve({ source: 'none', storageUnavailable: false }); await settle();
    assert(!document.getElementById('youtubeRemoveKeyButton').disabled && document.getElementById('youtubeApiKeyStatus').textContent.includes('Key saved'), 'Older settings loads cannot overwrite a saved API key');
    window.polishFixture = { state, room, render, iptv, mini, channel };
    return checks;
  })()`);
  const layouts = [];
  window.setContentSize(420, 900);
  for (const textScale of [100, 200]) {
    await window.webContents.executeJavaScript(`(() => {
      document.documentElement.style.fontSize = '${textScale}%';
      const fixture = window.polishFixture;
      fixture.state.room = fixture.room; fixture.render(fixture.state);
      document.getElementById('watch').hidden = false;
      document.getElementById('contentScroller').hidden = true;
      document.getElementById('youtubeApiKeyForm').hidden = true;
      window.scrollTo(0, 0);
    })()`);
    await new Promise(resolve => setTimeout(resolve, 80));
    layouts.push(await window.webContents.executeJavaScript(`({ kind: 'room-${textScale}', width: innerWidth, scrollWidth: document.documentElement.scrollWidth })`));
    writeFileSync(join(output, `room-420-text-${textScale}.png`), (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript(`(() => {
      document.getElementById('watch').hidden = true;
      const miniRoot = document.getElementById('playerMiniGuide'); miniRoot.hidden = false; miniRoot.classList.remove('is-hidden');
      window.polishFixture.mini.open(window.polishFixture.channel('World News HD'));
    })()`);
    await new Promise(resolve => setTimeout(resolve, 80));
    layouts.push(await window.webContents.executeJavaScript(`(() => { const root = document.getElementById('playerMiniGuide'); return { kind: 'mini-${textScale}', width: innerWidth, scrollWidth: document.documentElement.scrollWidth, guideWidth: root.clientWidth, guideScrollWidth: root.scrollWidth }; })()`));
    writeFileSync(join(output, `mini-guide-420-text-${textScale}.png`), (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript("window.polishFixture.mini.close(); document.getElementById('playerMiniGuide').hidden = true; document.getElementById('playerMiniGuide').classList.add('is-hidden');");
  }
  writeFileSync(join(output, "layout.json"), JSON.stringify(layouts, null, 2));
  writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2));
  console.log(`Product polish module fixture passed: ${report.length} checks.`);
  for (const check of report) console.log(`  ${check}`);
  app.exit(0);
}
