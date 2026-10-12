"use strict";
// Uses only the OS-protected account already saved in the isolated IPTV beta profile.
const { join, resolve } = require("node:path");
const { writeFileSync } = require("node:fs");
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require("node:child_process").spawnSync(require("electron"), [__filename], { cwd: resolve(__dirname, ".."), env, windowsHide: true, stdio: "inherit", timeout: 240000 });
  process.exitCode = result.status ?? 1;
} else run().catch(() => { console.error("Live account check failed; no upstream details exposed."); require("electron").app.exit(1); });

async function run() {
  const { app } = require("electron");
  app.setPath("userData", join(app.getPath("appData"), "Seeing Stone"));
  const created = new Promise(resolveWindow => app.once("browser-window-created", (_event, window) => resolveWindow(window)));
  let testPlayer;
  const startupErrors = [];
  const { MpvPlayerService } = require("../dist/main/services/mpvPlayer.js");
  const start = MpvPlayerService.prototype.start;
  MpvPlayerService.prototype.start = async function (...args) { testPlayer = this; try { return await start.apply(this, args); } catch (error) { startupErrors.push(error.code ?? "ENGINE_STARTUP_FAILED"); throw error; } };
  require("../dist/main/index.js");
  const window = await created;
  const js = source => window.webContents.executeJavaScript(source);
  const wait = async predicate => {
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) { if (await js(predicate).catch(() => false)) return true; await new Promise(r => setTimeout(r, 250)); }
    return false;
  };
  if (!await wait("!!window.iptv && !!document.querySelector('.iptv-screen')")) throw new Error();
  await js("document.getElementById('loginIptvButton').click()");
  if (!await wait("!!document.querySelector('.iptv-item h3') && document.querySelector('.iptv-screen [data-role=page-status]')?.textContent.includes('Page 1')")) throw new Error();
  const report = { checkedAt: new Date().toISOString(), guideProgrammes: 0, attempts: [], playback: false };
  for (const query of process.env.IPTV_CHECK_QUERY ? [process.env.IPTV_CHECK_QUERY] : ["CNN", "SKY NEWS", "BBC NEWS"]) {
    await js(`(() => { const input = document.querySelector('.iptv-screen [data-role=search]'); input.value=${JSON.stringify(query)}; input.dispatchEvent(new Event('input')); })()`);
    const expectedTitle = await js(`(async () => { const provider = (await window.iptv.list())[0].provider; return (await window.iptv.catalogue({providerId:provider.providerId,contentType:'live',query:${JSON.stringify(query)}})).items[0]?.name ?? null; })()`);
    if (!expectedTitle || !await wait(`document.querySelector('.iptv-item h3')?.textContent === ${JSON.stringify(expectedTitle)} && !!document.querySelector('.iptv-watch')`)) { report.attempts.push({ query, failure: expectedTitle ? "Catalogue UI did not finish searching" : "No matching channel" }); continue; }
    const scheduleCount = await js(`(async () => { const provider = (await window.iptv.list())[0].provider; const page = await window.iptv.catalogue({providerId:provider.providerId,contentType:'live',query:${JSON.stringify(query)}}); if (!page.items.length) return 0; const schedule = await window.iptv.schedule({providerId:provider.providerId,channelId:page.items[0].identity.itemId}); return schedule.programmes.length; })()`).catch(() => 0);
    report.guideProgrammes = Math.max(report.guideProgrammes, scheduleCount);
    await wait("!!document.querySelector('.iptv-now-playing') && !document.querySelector('.iptv-now-playing').textContent.includes('Checking')");
    const currentProgrammeVisible = await js("document.querySelector('.iptv-now-playing')?.textContent.includes('Now:') ?? false");
    await js("document.querySelector('.iptv-watch')?.click()");
    const playing = await wait("window.jellyfin.playback.getState().then(s => s.phase === 'playing' && !!s.iptvIdentity && s.diagnostics?.videoOutputHealthy === true)");
    const state = await js("window.jellyfin.playback.getState()");
    report.attempts.push({ query, playing, phase: state.phase, videoCodec: state.diagnostics?.videoCodec ?? null, resolution: state.diagnostics?.resolution ?? null, audioTracks: state.audioTracks.length, videoOutputHealthy: state.diagnostics?.videoOutputHealthy ?? null, currentProgrammeVisible, startupErrors: [...startupErrors] });
    if (playing) {
      report.playback = true;
      await new Promise(r => setTimeout(r, 3000));
      writeFileSync(join(__dirname, "../artifacts/iptv-beta/real-live-playing.png"), (await window.webContents.capturePage()).toPNG());
      await testPlayer.command(["screenshot-to-file", join(__dirname, "../artifacts/iptv-beta/real-live-decoded.png"), "video"]);
      report.decodedFrameCapture = true;
    }
    await js("document.getElementById('closePlayerButton').click()");
    await wait("window.jellyfin.playback.getState().then(s => !s.playbackId || s.phase === 'stopped')");
    await js("document.getElementById('loginIptvButton').click()");
    if (playing && report.guideProgrammes) break;
  }
  console.log(JSON.stringify(report));
  writeFileSync(join(__dirname, "../artifacts/iptv-beta/live-account-check.json"), JSON.stringify(report, null, 2));
  window.close();
}
