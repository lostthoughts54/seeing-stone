"use strict";
// Runs the production room renderer and packaged markup against isolated local state.
const { resolve, join } = require("node:path");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const { WebSocket } = require("ws");
const root = resolve(__dirname, "..");
const output = join(root, "artifacts/desktop-youtube-focus");
let browser;
let socket;
void run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { socket?.close(); browser?.kill(); });

async function run() {
  mkdirSync(output, { recursive: true });
  const appSource = readFileSync(join(root, "src/renderer/app.ts"), "utf8");
  const start = appSource.indexOf("const youtubeRenderedRegions =");
  const end = appSource.indexOf("function reconcileYouTubePlayer()", start);
  if (start < 0 || end < start) throw new Error("Production YouTube renderer boundaries were not found.");
  const productionRenderer = require("esbuild").transformSync(appSource.slice(start, end), { loader: "ts", target: "es2022" }).code;
  const sourceHtml = readFileSync(join(root, "src/renderer/index.html"), "utf8");
  const sectionStart = sourceHtml.indexOf('<section class="youtube-together"');
  const sectionEnd = sourceHtml.indexOf('<div class="watch-party-divider"', sectionStart);
  if (sectionStart < 0 || sectionEnd < sectionStart) throw new Error("YouTube room markup was not found.");
  writeFileSync(join(output, "fixture.html"), '<!doctype html><html lang="en"><head><meta charset="utf-8"><style>.is-hidden{display:none!important}body{font:16px system-ui}button,input,textarea{font:inherit}button{margin:4px}</style></head><body><main>' + sourceHtml.slice(sectionStart, sectionEnd) + '</main></body></html>');
  browser = spawn(process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${join(output, "chrome-profile")}`, "about:blank"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome startup timed out")), 15000);
    browser.once("error", reject);
    browser.stderr.on("data", chunk => {
      const match = chunk.toString().match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolvePromise(match[1]); }
    });
  });
  const pages = await (await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`)).json();
  socket = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
  await new Promise((resolvePromise, reject) => { socket.once("open", resolvePromise); socket.once("error", reject); });
  let sequence = 0;
  const pending = new Map();
  socket.on("message", raw => {
    const value = JSON.parse(raw);
    const waiter = pending.get(value.id);
    if (waiter) { pending.delete(value.id); clearTimeout(waiter.timer); value.error ? waiter.reject(new Error(JSON.stringify(value.error))) : waiter.resolve(value.result); }
  });
  const cdp = (method, params = {}) => new Promise((resolvePromise, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10000);
    pending.set(id, { resolve: resolvePromise, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await cdp("Page.enable");
  await cdp("Network.enable");
  await cdp("Network.setBlockedURLs", { urls: ["http://*", "https://*"] });
  await cdp("Page.navigate", { url: pathToFileURL(join(output, "fixture.html")).href });
  await evaluate(`new Promise(resolve => { const check = () => document.getElementById('youtubeRoomList') ? resolve() : setTimeout(check, 20); check(); })`);
  const checks = await evaluate(`(async () => {
    const checks = [];
    const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
    const el = id => document.getElementById(id);
    const [youtubeCreateButton, youtubeRefreshButton, youtubeRoomPanel, youtubeRoomList, youtubeRoomStatus, youtubeQueue, youtubeHandoffPanel, youtubeInviteToken, youtubeJoinedName, youtubeMembers, youtubeHandoffButton, youtubeNextButton, youtubePlayerShell, youtubeControls, youtubePlayPauseButton, youtubeLeaveButton, youtubeVideoUrlInput] = ['youtubeCreateButton', 'youtubeRefreshButton', 'youtubeRoomPanel', 'youtubeRoomList', 'youtubeRoomStatus', 'youtubeQueue', 'youtubeHandoffPanel', 'youtubeInviteToken', 'youtubeJoinedName', 'youtubeMembers', 'youtubeHandoffButton', 'youtubeNextButton', 'youtubePlayerShell', 'youtubeControls', 'youtubePlayPauseButton', 'youtubeLeaveButton', 'youtubeVideoUrlInput'].map(el);
    const state = { youtubeRooms: { connection: 'connected', error: null, openRooms: [
      { roomId: 'room-a', name: 'Room A', connectedMemberCount: 1, memberCount: 1 },
      { roomId: 'room-b', name: 'Room B', connectedMemberCount: 2, memberCount: 3 }
    ], room: null }, watchParties: null };
    let youtubeFrameVideoId = null, youtubeFrameQueueId = null;
    const actions = [], frames = [];
    const resetYouTubeFrame = videoId => { youtubeFrameVideoId = videoId; frames.push(videoId); };
    const joinYouTubeRoom = async roomId => { actions.push(['join', roomId]); };
    const joinYouTubeHandoff = async groupId => { actions.push(['handoff', groupId]); };
    const openHome = () => actions.push(['home']);
    let onQueueAction = null;
    const updateYouTubeQueue = async (queueItemId, action, button) => {
      button.disabled = true;
      actions.push(['queue', queueItemId, action]);
      await Promise.resolve();
      onQueueAction?.();
      renderYouTubeRoom();
      button.disabled = false;
    };
    ${productionRenderer}
    renderYouTubeRoom();
    const join = youtubeRoomList.querySelector('button'); join.focus();
    for (let index = 0; index < 5; index++) {
      state.youtubeRooms.openRooms = structuredClone(state.youtubeRooms.openRooms).map(room => ({ ...room, expiresAtUnixMs: Date.now() + index }));
      renderYouTubeRoom();
    }
    check(document.activeElement === join && join.isConnected, 'unchanged room polls retain Join focus and DOM');
    state.youtubeRooms.openRooms[0].connectedMemberCount = 2; renderYouTubeRoom();
    check(document.activeElement.dataset.youtubeFocusKey === 'room:room-a' && youtubeRoomList.textContent.includes('2 connected'), 'room counts refresh while focus follows room identity');
    state.youtubeRooms.openRooms.shift(); renderYouTubeRoom();
    check(document.activeElement.dataset.youtubeFocusKey === 'room:room-b', 'removed room moves focus to the remaining room');
    document.activeElement.click(); await Promise.resolve();
    check(JSON.stringify(actions.pop()) === JSON.stringify(['join', 'room-b']), 'rebuilt Join still targets the right room');
    const room = state.youtubeRooms.room = { inviteToken: 'joined', name: 'Friday videos', transition: null,
      members: [{ displayName: 'Viewer', connected: true, status: 'playing', lastSeenAtUnixMs: 1 }],
      timeline: { videoId: 'repeated-id', playing: false, positionSeconds: 10, version: 1 },
      queue: [
        { queueItemId: 'first', videoId: 'repeated-id', addedBy: 'Viewer' },
        { queueItemId: 'second', videoId: 'repeated-id', addedBy: 'Viewer' },
        { queueItemId: 'third', videoId: 'third-video', addedBy: 'Viewer' }
      ] };
    renderYouTubeRoom();
    const queueControl = youtubeQueue.querySelector('[data-youtube-focus-key="queue:second:play"]'); queueControl.focus();
    const firstMember = youtubeMembers.firstChild;
    const firstQueueRow = youtubeQueue.firstChild;
    const observer = new MutationObserver(() => {});
    observer.observe(youtubeRoomPanel, { childList: true, subtree: true });
    for (let index = 0; index < 5; index++) {
      room.serverNowUnixMs = Date.now() + index; room.members[0].lastSeenAtUnixMs++; room.timeline.positionSeconds++;
      room.queue.forEach(item => { item.addedAtUnixMs = index; });
      renderYouTubeRoom();
    }
    check(queueControl.isConnected && document.activeElement === queueControl && youtubeQueue.firstChild === firstQueueRow, 'clock-only polls retain queue controls and focus');
    check(youtubeMembers.firstChild === firstMember, 'presence timestamps do not replace member nodes');
    check(observer.takeRecords().length === 0, 'unchanged visible room values do not repeatedly mutate live-region text');
    observer.disconnect();
    room.timeline.playing = true; renderYouTubeRoom();
    check(youtubePlayPauseButton.textContent === 'Pause' && document.activeElement === queueControl, 'timeline controls still update without rebuilding the queue');
    room.members[0].status = 'buffering'; renderYouTubeRoom();
    check(youtubeMembers.textContent.includes('buffering') && document.activeElement === queueControl, 'visible member status changes still update');
    queueControl.click(); await new Promise(resolve => setTimeout(resolve, 0));
    check(JSON.stringify(actions.pop()) === JSON.stringify(['queue', 'second', 'play']), 'duplicate video occurrences retain distinct queue action targets');
    check(document.activeElement === queueControl, 'completed queue action restores focus after its button was temporarily disabled');
    onQueueAction = () => { room.queue = [room.queue[0], room.queue[2], room.queue[1]]; };
    youtubeQueue.querySelector('[data-youtube-focus-key="queue:second:move-down"]').focus();
    document.activeElement.click(); await new Promise(resolve => setTimeout(resolve, 0));
    check(document.activeElement.dataset.youtubeFocusGroup === 'second' && !document.activeElement.disabled, 'asynchronous queue reorder restores focus to the same item');
    onQueueAction = () => { youtubeVideoUrlInput.focus(); };
    const removeAfterReorder = youtubeQueue.querySelector('[data-youtube-focus-key="queue:second:remove"]');
    removeAfterReorder.focus(); removeAfterReorder.click(); await new Promise(resolve => setTimeout(resolve, 0));
    check(document.activeElement === youtubeVideoUrlInput, 'queue completion does not steal focus from another control');
    onQueueAction = null;
    room.queue = [room.queue[0], room.queue[2], room.queue[1]]; renderYouTubeRoom();
    const focusedMove = youtubeQueue.querySelector('[data-youtube-focus-key="queue:third:move-up"]'); focusedMove.focus();
    room.queue = [room.queue[0], room.queue[2], room.queue[1]]; renderYouTubeRoom();
    check(document.activeElement.dataset.youtubeFocusGroup === 'third' && !document.activeElement.disabled, 'reordering retains focus in the same item when its old action becomes disabled');
    check(youtubeQueue.querySelector('[data-youtube-focus-key="queue:second:move-up"]').getAttribute('aria-label') === 'Move up: repeated-id', 'arrow queue controls have descriptive accessible names');
    youtubeQueue.querySelector('[data-youtube-focus-key="queue:third:remove"]').focus();
    room.queue = room.queue.filter(item => item.queueItemId !== 'third'); renderYouTubeRoom();
    check(youtubeQueue.contains(document.activeElement) && document.activeElement.dataset.youtubeFocusGroup === 'second', 'removing a focused queue row moves focus to a surviving row');
    room.transition = { groupId: 'party-a', groupName: 'Movie night', announcedBy: 'Viewer', announcedAtUnixMs: 1 };
    renderYouTubeRoom();
    const handoff = youtubeHandoffPanel.querySelector('button'); handoff.focus();
    room.transition.announcedAtUnixMs++; renderYouTubeRoom();
    check(document.activeElement === handoff && handoff.isConnected, 'unchanged handoff polls preserve keyboard focus');
    state.watchParties = { joinedGroup: { groupId: 'PARTY-A' } }; renderYouTubeRoom();
    check(document.activeElement.textContent === 'Browse Jellyfin library', 'handoff participation changes update the action and preserve focus');
    document.activeElement.click(); check(actions.pop()[0] === 'home', 'updated handoff button uses its current action');
    room.transition = null; renderYouTubeRoom();
    check(document.activeElement === youtubeHandoffButton, 'removed handoff restores focus to its visible launch button');
    youtubeQueue.querySelector('[data-youtube-focus-key="queue:second:remove"]').focus();
    room.queue = []; renderYouTubeRoom();
    check(document.activeElement === youtubeVideoUrlInput && youtubeNextButton.disabled && youtubeQueue.textContent.includes('empty'), 'empty queue offers the add-video field as a focus fallback');
    room.queue = [{ queueItemId: 'replacement', videoId: 'new-video', addedBy: 'Viewer' }]; room.timeline.videoId = 'new-video'; renderYouTubeRoom();
    check(frames.at(-1) === 'new-video' && youtubeFrameQueueId === 'replacement', 'replacement media still refreshes the playback frame');
    youtubeQueue.replaceChildren(); renderYouTubeRoom();
    check(youtubeQueue.querySelectorAll('.youtube-queue-item').length === 1, 'signed-out DOM clearing cannot leave a stale render cache');
    youtubeQueue.querySelector('button').focus(); state.youtubeRooms.room = null; renderYouTubeRoom();
    check(document.activeElement === youtubeCreateButton && youtubeRoomPanel.classList.contains('is-hidden') && frames.at(-1) === null, 'leaving a room clears playback and restores visible focus');
    return checks;
  })()`);
  writeFileSync(join(output, "result.json"), JSON.stringify({ passed: checks.length, checks }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
}
