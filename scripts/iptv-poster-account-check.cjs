"use strict";
const { join, resolve } = require("node:path");
const { writeFileSync } = require("node:fs");
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require("node:child_process").spawnSync(require("electron"), [__filename], { cwd: resolve(__dirname, ".."), env, windowsHide: true, stdio: "inherit", timeout: 180000 });
  process.exitCode = result.status ?? 1;
} else run().catch(() => { console.error("Poster check failed; no upstream details exposed."); require("electron").app.exit(1); });
async function run() {
  const { app } = require("electron");
  app.setPath("userData", join(app.getPath("appData"), "Seeing Stone"));
  const created = new Promise(resolveWindow => app.once("browser-window-created", (_event, window) => resolveWindow(window)));
  require("../dist/main/index.js");
  const window = await created;
  const js = source => window.webContents.executeJavaScript(source);
  const wait = async predicate => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) { if (await js(predicate).catch(() => false)) return; await new Promise(r => setTimeout(r, 300)); }
    throw new Error();
  };
  await wait("!!window.iptv && !!document.querySelector('.iptv-screen')");
  await js("document.getElementById('loginIptvButton').click()");
  await wait("!!document.querySelector('.iptv-item h3')");
  const report = {};
  for (const [type, query] of [["movie", "Harry Potter"], ["series", "The Office"]]) {
    await js(`document.querySelector('.iptv-screen [data-type=${type}]').click()`);
    await wait("!!document.querySelector('.iptv-poster-card')");
    await js(`(() => { const input = document.querySelector('.iptv-screen [data-role=search]'); input.value=${JSON.stringify(query)}; input.dispatchEvent(new Event('input')); })()`);
    await wait(`document.querySelector('.iptv-poster-card h3')?.textContent.toLowerCase().includes(${JSON.stringify(query.toLowerCase())})`);
    await wait("document.querySelectorAll('.iptv-poster-art img:not([hidden])').length >= 2");
    await new Promise(r => setTimeout(r, 1500));
    report[type] = await js("({cards: document.querySelectorAll('.iptv-poster-card').length, loaded: document.querySelectorAll('.iptv-poster-art img:not([hidden])').length, opaqueImages: [...document.querySelectorAll('.iptv-poster-art img:not([hidden])')].every(img => img.src.startsWith('data:image/')), overflow: document.querySelector('.iptv-screen').scrollWidth > document.querySelector('.iptv-screen').clientWidth})");
    writeFileSync(join(__dirname, `../artifacts/iptv-beta/${type}-posters.png`), (await window.webContents.capturePage()).toPNG());
  }
  writeFileSync(join(__dirname, "../artifacts/iptv-beta/poster-account-check.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); window.close();
}
