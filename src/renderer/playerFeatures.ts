import { featurePosition, type FeatureInput, type FeatureState } from "../shared/playerFeatures";
import { mountPartyReactions } from "./partyReactions";

/** Room UI keeps its inputs and official iframe mounted while live state changes. */
export function mountPlayerFeatures(parent: HTMLElement): void {
  if (!window.jellyfin.playerFeatures) return;
  const panel = document.createElement("section"); panel.className = "player-features";
  panel.innerHTML = `<h1>Seeing Stone rooms</h1>
    <p>Persistent movie nights with a shared queue, readiness checks and chat.</p>
    <p data-role="status" role="status" aria-live="polite">Refresh to find rooms on your server.</p>
    <div class="feature-row"><label>Room name <input data-role="name" maxlength="80" placeholder="Movie night" required></label><button data-command="create">Create room</button><button data-command="refresh">Refresh rooms</button></div>
    <div data-role="rooms" class="feature-list"></div>
    <div data-role="joined" hidden>
      <div class="feature-row"><h2 data-role="title"></h2><button data-command="leave">Leave room</button><button data-command="delete">Delete room</button></div>
      <p data-role="phase" class="feature-phase" aria-live="polite"></p>
      <div data-role="members" class="feature-list"></div>
      <p data-role="preflight"></p><button data-command="retry">Retry preparation</button>
      <div data-role="youtube" hidden><div data-role="youtube-surface" class="party-reaction-surface"><iframe title="Official YouTube room player" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div><button data-command="prime">Load YouTube player</button><p>YouTube handles ads and availability. The room waits until the selected video is ready.</p></div>
      <div class="feature-row"><button data-action="play">Play together</button><button data-action="pause">Pause</button><button data-action="continue">Continue with ready viewers</button><button data-command="skip">Skip intro / recap together</button><button data-action="next">Next in queue</button></div>
      <div class="feature-row"><label>Seek to seconds <input data-role="seek" type="number" min="0" max="86400" step="1" value="0" required></label><button data-command="seek">Seek together</button></div>
      <details><summary>Room settings</summary><div class="feature-row"><label><input data-setting="host-only" type="checkbox"> Host controls playback</label><label><input data-setting="wait-for-all" type="checkbox"> Wait when someone buffers</label><label><input data-setting="auto-next" type="checkbox"> Next video countdown</label><label><input data-setting="minimum" type="checkbox"> Allow starting alone</label></div></details>
      <h3>Shared queue</h3><div class="feature-row"><label>Search library <input data-role="search" maxlength="200" placeholder="Movie or episode title"></label><button data-command="search">Search</button></div>
      <div data-role="results" class="feature-list" role="status" aria-live="polite"></div>
      <div class="feature-row"><label>YouTube link <input data-role="url" type="url" maxlength="2048" placeholder="https://www.youtube.com/watch?v=…"></label><button data-command="youtube-add">Add YouTube video</button><button data-action="sort-votes">Order upcoming videos by votes</button></div>
      <div data-role="queue" class="feature-list"></div>
      <details><summary>Prepare for movie night</summary><p>Download the Jellyfin videos in this queue on this computer, including available subtitles. This uses your download storage and connection.</p><button data-action="prepare">Invite everyone to prepare</button><button data-command="prepare">Download this queue on my computer</button><p data-role="downloads"></p></details>
      <details><summary>My subtitle timing</summary><p>Applies to the currently selected subtitle track. Positive values show subtitles later. Saved for your account and this media version.</p><label>Delay in seconds <input data-role="delay" type="number" min="-120" max="120" step="0.1" value="0" required></label><button data-command="timing">Save timing</button></details>
      <h3>Room conversation</h3><div data-role="messages" class="feature-log" aria-label="Room conversation"></div>
      <div data-role="reactions"></div>
      <div class="feature-row"><label>Message <input data-role="message" maxlength="500" placeholder="Say something…"></label><button data-command="chat">Send</button><button data-command="comment">Comment at this moment</button></div>
      <details><summary>Session troubleshooting</summary><p>Recent room events help explain waits and playback changes.</p><div data-role="events" class="feature-log"></div></details>
    </div>`;
  parent.prepend(panel);
  const homeMarker = document.createComment("Seeing Stone room panel"); parent.insertBefore(homeMarker, panel);
  const playerView = document.getElementById("playerView")!;
  const sidebar = document.getElementById("sessionPanel")!;
  const playerSlot = document.createElement("div"); playerSlot.className = "session-panel-content feature-player-slot"; sidebar.append(playerSlot);
  const el = <T extends HTMLElement = HTMLElement>(role: string): T => panel.querySelector<T>(`[data-role="${role}"]`)!;
  const value = (role: string) => el<HTMLInputElement>(role).value;
  let state: FeatureState | null = null;
  let roomId: string | null = null;
  let queueSignature = ""; let messageSignature = ""; let eventsSignature = ""; let roomsSignature = ""; let searchRevision = 0;
  const pendingCommands = new Set<string>();
  const frame = panel.querySelector<HTMLIFrameElement>("iframe")!;
  let frameKey = ""; let videoId = ""; let reportedVideo = ""; let playerReady = false;
  let playerState = -1; let position = 0; let duration = 0; let stableDuration = 0; let lastControl = 0; let lastSeek = 0;
  let lastMessage = 0; let youtubeError = false;
  const reactions = mountPartyReactions({
    pickerParent: el("reactions"), nativeSurface: document.getElementById("playerFrame"),
    nativeControls: document.querySelector("#playerControls .player-options"),
    youtubeSurface: el("youtube-surface"), playerView,
    send: async text => { render(await window.jellyfin.playerFeatures.command({ operation: "message", kind: "reaction", text })); },
  });
  function locatePanel(): void {
    const inPlayer = Boolean(state?.room && !playerView.classList.contains("is-hidden"));
    sidebar.toggleAttribute("data-feature-room", inPlayer);
    if (inPlayer && panel.parentElement !== playerSlot) playerSlot.append(panel);
    if (!inPlayer && panel.parentElement !== parent) homeMarker.after(panel);
  }
  new MutationObserver(locatePanel).observe(playerView, { attributes: true, attributeFilter: ["class"] });
  const yt = (func: string, args: unknown[] = []) => frame.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "https://www.youtube.com");
  const button = (text: string, callback: () => void, disabled = false): HTMLButtonElement => {
    const b = document.createElement("button"); b.type = "button"; b.textContent = text; b.disabled = disabled; b.addEventListener("click", callback); return b;
  };
  const line = (text: string) => { const p = document.createElement("p"); p.textContent = text; return p; };
  async function send(input: FeatureInput): Promise<boolean> {
    const key = JSON.stringify(input);
    if (pendingCommands.has(key)) return false;
    pendingCommands.add(key);
    try { render(await window.jellyfin.playerFeatures.command(input)); return true; }
    catch (error) { el("status").textContent = error instanceof Error ? error.message : "That request could not be completed."; return false; }
    finally { pendingCommands.delete(key); }
  }
  function render(next: FeatureState): void {
    state = next; const room = next.room;
    locatePanel();
    reactions.update(next);
    el("status").textContent = next.error || (room ? `${room.name} · ${next.connection}` : next.connection === "connected" ? "Choose a room or create one." : next.connection === "signed-out" ? "Sign in to use server rooms." : "Seeing Stone Player Features needs to be available on your server.");
    el("joined").hidden = !room;
    el("rooms").hidden = Boolean(room);
    el("name").closest<HTMLElement>(".feature-row")!.hidden = Boolean(room);
    const changedRoom = roomId !== (room?.id ?? null);
    roomId = room?.id ?? null;
    if (changedRoom) {
      queueSignature = ""; messageSignature = ""; eventsSignature = ""; searchRevision++; el("results").replaceChildren();
      el<HTMLInputElement>("message").value = "";
    }
    const roomListSignature = JSON.stringify([next.rooms, Boolean(room), next.connection]);
    if (roomsSignature !== roomListSignature) {
      roomsSignature = roomListSignature;
      el("rooms").replaceChildren(...next.rooms.map(r => {
        const row = document.createElement("div"); row.className = "feature-row";
        row.append(line(`${r.name} · ${r.connected} connected`), button("Join", () => void send({ operation: "join", roomId: r.id }), Boolean(room) || next.connection !== "connected")); return row;
      }));
      if (!next.rooms.length && next.connection === "connected") el("rooms").append(line("No rooms yet. Create one to start a movie night."));
    }
    panel.querySelector<HTMLButtonElement>('[data-command="create"]')!.disabled = Boolean(room);
    if (!room) { if (frameKey) { frame.removeAttribute("src"); frameKey = ""; } return; }
    el("title").textContent = room.name;
    el("members").replaceChildren(...room.members.map(m => line(`${m.name}${m.host ? " (host)" : ""} · ${m.connected ? m.ready ? "ready" : m.state : "disconnected"}${m.source ? ` · ${m.source}` : ""}${m.issue ? ` · ${m.issue}` : ""}`)));
    el("preflight").textContent = [next.local.preparation, next.local.delivery, `${next.local.subtitles} subtitle track(s)`, next.local.issue].filter(Boolean).join(" · ");
    el("downloads").textContent = next.local.downloads;
    if (document.activeElement !== el("delay")) el<HTMLInputElement>("delay").value = String(next.local.delaySeconds);
    panel.querySelector<HTMLButtonElement>('[data-command="delete"]')!.disabled = !room.owner;
    for (const input of panel.querySelectorAll<HTMLInputElement>("[data-setting]")) {
      input.disabled = !room.owner;
      input.checked = input.dataset.setting === "host-only" ? room.hostOnly : input.dataset.setting === "wait-for-all" ? room.waitForAll : input.dataset.setting === "auto-next" ? room.autoNext : room.minimumParticipants === 1;
    }
    for (const b of panel.querySelectorAll<HTMLButtonElement>("[data-action]")) b.disabled = b.dataset.action === "prepare" || b.dataset.action === "continue" ? !room.owner : room.hostOnly && !room.owner;
    const hostControlsPlayback = room.hostOnly && !room.owner;
    el<HTMLInputElement>("seek").disabled = hostControlsPlayback;
    panel.querySelector<HTMLButtonElement>('[data-command="seek"]')!.disabled = hostControlsPlayback;
    panel.querySelector<HTMLButtonElement>('[data-command="skip"]')!.disabled = hostControlsPlayback || room.media?.kind !== "jellyfin";
    const signature = JSON.stringify([room.queue, room.hostOnly, room.owner]);
    if (queueSignature !== signature) {
      queueSignature = signature;
      el("queue").replaceChildren(...room.queue.map((q, i) => {
        const row = document.createElement("div"); row.className = "feature-row";
        const action = (action: "vote" | "play-item" | "remove") => void send({ operation: "action", action: { action, queueItemId: q.id } });
        row.append(line(`${i === 0 ? "Now: " : ""}${q.media.title} · ${q.votes} vote(s)`), button(q.voted ? "Remove vote" : "Vote", () => action("vote")));
        if (i > 0) row.append(button("Prepare this video", () => action("play-item"), room.hostOnly && !room.owner));
        row.append(button("Remove", () => action("remove"), room.hostOnly && !room.owner)); return row;
      }));
    }
    const messages = JSON.stringify(room.messages);
    if (messageSignature !== messages) { messageSignature = messages; const log = el("messages"); const bottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30; log.replaceChildren(...room.messages.map(m => line(`${m.author}${m.positionTicks === null ? "" : ` @ ${Math.floor(m.positionTicks / 10_000_000)}s`}: ${m.text}`))); if (bottom) log.scrollTop = log.scrollHeight; }
    const events = JSON.stringify(room.events);
    if (eventsSignature !== events) { eventsSignature = events; el("events").replaceChildren(...room.events.slice(-80).reverse().map(e => line(`${new Date(e.at).toLocaleTimeString()} · ${e.text}`))); }
    const key = room.media?.kind === "youtube" ? `${room.id}:${room.timeline.generation}` : "";
    el("youtube").hidden = !key;
    if (key !== frameKey) {
      frameKey = key; videoId = room.media?.kind === "youtube" ? room.media.itemId : ""; reportedVideo = ""; playerReady = false; playerState = -1; position = 0; duration = 0; stableDuration = 0; youtubeError = false; lastMessage = 0;
      if (key) frame.src = `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?enablejsapi=1&autoplay=0&playsinline=1&controls=0&rel=0`;
      else frame.removeAttribute("src");
    }
    updatePhase();
  }
  function updatePhase(): void {
    const r = state?.room; if (!r) return;
    const until = r.timeline.nextAt ?? r.timeline.startAt;
    const label = `${r.media?.title ?? "Add a video below"} · ${r.timeline.phase}${until === null ? "" : ` in ${Math.max(0, Math.ceil((until - Date.now()) / 1000))}s`}`;
    if (el("phase").textContent !== label) el("phase").textContent = label;
  }
  async function search(): Promise<void> {
    const revision = ++searchRevision; const query = value("search").trim();
    if (!query) { el("results").replaceChildren(); return; }
    el("results").replaceChildren(line("Searching your library…"));
    try {
      const items = await window.jellyfin.search.query({ query }); if (revision !== searchRevision) return;
      const playable = items.filter(i => ["Movie", "Episode", "Video"].includes(i.type)).slice(0, 20);
      el("results").replaceChildren(...playable.map(item => {
        const row = document.createElement("div"); row.className = "feature-row"; row.append(line(item.name));
        const choose = button("Choose version", () => {
          choose.disabled = true;
          void window.jellyfin.mediaSources.getCapabilities({ itemId: item.id }).then(cap => {
            if (revision !== searchRevision) return;
            const select = document.createElement("select"); select.setAttribute("aria-label", `Version of ${item.name}`);
            for (const s of cap.sources) { const option = document.createElement("option"); option.value = s.id; option.textContent = s.name || [s.container, s.height ? `${s.height}p` : null, s.videoCodec].filter(Boolean).join(" · ") || "Original"; select.append(option); }
            row.append(select, button("Add to room", () => void send({ operation: "add", kind: "jellyfin", itemId: item.id, mediaSourceId: select.value }), cap.sources.length === 0)); choose.remove();
          }).catch(() => { if (revision === searchRevision) { choose.disabled = false; el("status").textContent = "Could not load the versions for that video. Try Choose version again."; } });
        }); row.append(choose); return row;
      }));
      if (!playable.length) el("results").append(line("No playable videos match your search. Try another title."));
    } catch { if (revision === searchRevision) el("results").replaceChildren(line("Library search failed. Select Search to try again.")); }
  }
  panel.addEventListener("click", event => {
    const b = (event.target as HTMLElement).closest<HTMLButtonElement>("button"); if (!b) return;
    if (b.dataset.action) { void send({ operation: "action", action: { action: b.dataset.action as "play" } }); return; }
    const op = b.dataset.command;
    if (op === "create") { const input = el<HTMLInputElement>("name"); input.value = input.value.trim(); if (input.reportValidity()) void send({ operation: "create", name: input.value }); }
    else if (op === "search") void search();
    else if (op === "youtube-add") void send({ operation: "add", kind: "youtube", itemId: value("url") });
    else if (op === "seek") { if (el<HTMLInputElement>("seek").reportValidity()) void send({ operation: "action", action: { action: "seek", positionTicks: Math.round(Number(value("seek")) * 10_000_000) } }); }
    else if (op === "timing") { if (el<HTMLInputElement>("delay").reportValidity()) void send({ operation: "timing", delaySeconds: Number(value("delay")) }); }
    else if (op === "chat" || op === "comment") {
      const draft = value("message"); const text = draft.trim(); const sentRoom = roomId;
      if (text) void send({ operation: "message", kind: op, text }).then(sent => {
        if (sent && roomId === sentRoom && value("message") === draft) el<HTMLInputElement>("message").value = "";
      });
    }
    else if (op === "prime") yt("playVideo");
    else if (op === "delete") {
      const room = state?.room;
      if (room?.owner && window.confirm(`Delete “${room.name}”? This removes the room and its shared queue for everyone.`)) void send({ operation: "delete" });
    }
    else if (op === "refresh" || op === "leave" || op === "prepare" || op === "retry" || op === "skip") void send({ operation: op });
  });
  el<HTMLInputElement>("search").addEventListener("input", () => { searchRevision++; el("results").replaceChildren(); });
  panel.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.isComposing || !(event.target instanceof HTMLInputElement)) return;
    const command = ({ name: "create", search: "search", message: "chat", url: "youtube-add", seek: "seek", delay: "timing" } as Record<string, string>)[event.target.dataset.role ?? ""];
    if (command) { event.preventDefault(); event.stopPropagation(); panel.querySelector<HTMLButtonElement>(`[data-command="${command}"]`)?.click(); }
  });
  panel.addEventListener("change", event => {
    const input = event.target as HTMLInputElement; const setting = input.dataset.setting;
    if (setting === "minimum") void send({ operation: "action", action: { action: "minimum", minimumParticipants: input.checked ? 1 : 2 } });
    else if (setting === "host-only" || setting === "wait-for-all" || setting === "auto-next") void send({ operation: "action", action: { action: setting, enabled: input.checked } });
  });
  frame.addEventListener("load", () => { if (frameKey) frame.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: "seeingStoneFeatureFrame" }), "https://www.youtube.com"); });
  window.addEventListener("message", event => {
    if (!frameKey || event.origin !== "https://www.youtube.com" || event.source !== frame.contentWindow) return;
    let data: unknown = event.data; if (typeof data === "string") { try { data = JSON.parse(data); } catch { return; } }
    if (!data || typeof data !== "object") return;
    const message = data as { event?: string; info?: unknown }; lastMessage = Date.now();
    if (message.event === "onReady") playerReady = true;
    if (message.event === "onError") youtubeError = true;
    if (message.event === "onStateChange" && typeof message.info === "number") playerState = message.info;
    if (message.event === "infoDelivery" && message.info && typeof message.info === "object") {
      const info = message.info as { currentTime?: number; duration?: number; playerState?: number; videoData?: { video_id?: string } };
      if (Number.isFinite(info.currentTime)) position = Math.max(0, Math.min(86400, info.currentTime!));
      if (Number.isFinite(info.playerState)) playerState = info.playerState!;
      if (Number.isFinite(info.duration) && info.duration! > 0 && info.duration! <= 86400) { stableDuration = Math.abs(info.duration! - duration) < 0.25 ? stableDuration + 1 : 0; duration = info.duration!; }
      if (typeof info.videoData?.video_id === "string") reportedVideo = info.videoData.video_id;
    }
  });
  setInterval(() => {
    updatePhase(); const room = state?.room; if (!room || !frameKey) return;
    const safe = playerReady && reportedVideo === videoId && stableDuration >= 2 && Date.now() - lastMessage < 4000;
    const playing = room.timeline.playing && (room.timeline.startAt === null || Date.now() >= room.timeline.startAt);
    if (state?.connection !== "connected") { yt("pauseVideo"); return; }
    if (safe && playerState !== 0) {
      const target = featurePosition(room) / 10_000_000;
      if (Math.abs(position - target) > 1.5 && Date.now() - lastSeek > 4000 && playerState !== 3) { yt("seekTo", [Math.min(duration, target), true]); lastSeek = Date.now(); }
      if (Date.now() - lastControl > 1000 && (playing ? playerState !== 1 && playerState !== 3 : playerState !== 2)) { yt(playing ? "playVideo" : "pauseVideo"); lastControl = Date.now(); }
    }
    void window.jellyfin.playerFeatures.command({ operation: "youtube-state", generation: room.timeline.generation, videoId, state: youtubeError ? "error" : !safe ? "loading" : playerState === 0 ? "ended" : playerState === 3 ? "buffering" : playerState === 1 ? "playing" : "paused", positionTicks: Math.round(position * 10_000_000), durationTicks: Math.round(duration * 10_000_000) }).catch(() => undefined);
  }, 250);
  window.jellyfin.playerFeatures.subscribe(render);
}
