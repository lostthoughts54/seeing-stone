import type { CompanionCommand, CompanionMediaSummary } from "../shared/companionContracts";
import { getHome, getSession, longPoll, pair, search, sendCommand, type RuntimeSession } from "./api";
import { CompanionModel } from "./state";

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const model = new CompanionModel();
let session: RuntimeSession | null = null;
let webSocket: WebSocket | null = null;
let reconnectIndex = 0;
let reconnectTimer = 0;
let searchTimer = 0;
let pairingTicket: string | null = null;

function extractTicket(): void {
  const match = location.hash.match(/^#\/pair\?(.+)$/);
  if (!match) return;
  pairingTicket = new URLSearchParams(match[1]).get("ticket");
  history.replaceState(null, "", `${location.pathname}${location.search}#/pair`);
}

function formatTicks(ticks: number): string {
  const seconds = Math.max(0, Math.floor(ticks / 10_000_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function setConnection(text: string, stale = false): void {
  byId("connection").textContent = text;
  document.querySelectorAll<HTMLButtonElement>("#remote button").forEach((button) => {
    if (!button.closest(".tabs")) button.disabled = stale;
  });
}

async function command(value: CompanionCommand): Promise<void> {
  if (!session) return;
  try {
    await sendCommand(session, value);
  } catch (error) {
    setConnection(error instanceof Error ? error.message : "The command could not be sent.");
    await bootstrap().catch(() => undefined);
  }
}

function render(): void {
  const state = model.bootstrap;
  if (!state || !session) return;
  const player = state.player;
  session.bootstrap = state;
  byId("nowPlayingTitle").textContent = player.media?.name ?? "Nothing playing";
  byId("mediaDetail").textContent = player.media?.seriesName
    ? [player.media.seriesName, player.media.seasonNumber !== null ? `S${player.media.seasonNumber}` : "", player.media.episodeNumber !== null ? `E${player.media.episodeNumber}` : ""].filter(Boolean).join(" · ")
    : player.media?.type ?? "";
  const seekInput = byId<HTMLInputElement>("seek");
  seekInput.max = String(Math.max(1, player.durationTicks));
  seekInput.value = String(Math.min(player.positionTicks, player.durationTicks || 1));
  seekInput.disabled = !player.controls.canSeek;
  byId("position").textContent = formatTicks(player.positionTicks);
  byId("duration").textContent = formatTicks(player.durationTicks);
  byId("playPause").textContent = player.paused ? "Play" : "Pause";
  byId<HTMLInputElement>("volume").value = String(player.volume);
  byId("mute").textContent = player.muted ? "Unmute" : "Mute";
  byId<HTMLButtonElement>("previous").disabled = !(player.controls.canPrevious || player.controls.canPreviousChannel);
  byId<HTMLButtonElement>("next").disabled = !(player.controls.canNext || player.controls.canNextChannel);
  byId("previous").textContent = player.live ? "Channel −" : "‹‹";
  byId("next").textContent = player.live ? "Channel +" : "››";
  byId("goLive").classList.toggle("hidden", !player.controls.canGoLive);
  populateTracks("audioTrack", player.audioTracks, false);
  populateTracks("subtitleTrack", player.subtitleTracks, true);
  renderQueue();
}

function populateTracks(id: string, tracks: Array<{ id: number; label: string; selected: boolean }>, allowOff: boolean): void {
  const select = byId<HTMLSelectElement>(id);
  select.replaceChildren();
  if (allowOff) select.add(new Option("Off", "", false, !tracks.some((track) => track.selected)));
  for (const track of tracks) select.add(new Option(track.label, String(track.id), false, track.selected));
}

function mediaCard(media: CompanionMediaSummary): HTMLElement {
  const article = document.createElement("article");
  article.className = "media-card";
  const title = document.createElement("strong");
  title.textContent = media.name;
  if (media.artworkRef) {
    const image = document.createElement("img");
    image.src = `/api/v1/artwork/${encodeURIComponent(media.artworkRef)}?size=small`;
    image.alt = "";
    image.loading = "lazy";
    article.append(image);
  }
  const detail = document.createElement("span");
  detail.className = "muted";
  detail.textContent = [media.seriesName, media.productionYear].filter(Boolean).join(" · ") || media.type;
  const actions = document.createElement("div");
  actions.className = "actions";
  for (const [label, placement] of [["Play", "play-now"], ["Next", "play-next"], ["Queue", "queue-end"]] as const) {
    const button = document.createElement("button");
    button.textContent = label;
    button.disabled = !media.playable;
    button.addEventListener("click", () => void command({ type: "send-item", itemRef: media.itemRef, placement, resumeMode: "start-over" }));
    actions.append(button);
  }
  article.append(title, detail, actions);
  return article;
}

function renderQueue(): void {
  const queue = model.bootstrap!.queue;
  const upcomingEntries = queue.entries.filter((entry) => entry.state === "upcoming");
  const list = byId<HTMLOListElement>("queueList");
  list.replaceChildren();
  byId("queueMessage").textContent = queue.blockedReason === "watchparty" ? "Queue editing is paused during this watch party." : "";
  byId<HTMLButtonElement>("clearQueue").disabled = !queue.editable || !queue.entries.some((entry) => entry.state === "upcoming");
  for (const entry of queue.entries) {
    const row = document.createElement("li");
    row.className = "media-card";
    const title = document.createElement("strong");
    title.textContent = entry.media.name;
    const entryState = document.createElement("span");
    entryState.className = "muted";
    entryState.textContent = entry.reserved ? "Starting…" : entry.state;
    row.append(title, entryState);
    if (entry.state === "upcoming") {
      const actions = document.createElement("div");
      actions.className = "actions";
      const play = document.createElement("button");
      play.textContent = "Play now";
      play.disabled = !queue.editable || entry.reserved;
      play.addEventListener("click", () => void command({ type: "queue-play-now", queueEntryId: entry.queueEntryId, expectedQueueRevision: queue.revision }));
      const remove = document.createElement("button");
      remove.textContent = "Remove";
      remove.disabled = !queue.editable || entry.reserved;
      remove.addEventListener("click", () => void command({ type: "queue-remove", queueEntryId: entry.queueEntryId, expectedQueueRevision: queue.revision }));
      const upcomingIndex = upcomingEntries.findIndex((candidate) => candidate.queueEntryId === entry.queueEntryId);
      const moveUp = document.createElement("button");
      moveUp.textContent = "Move up";
      moveUp.disabled = !queue.editable || entry.reserved || upcomingIndex <= 0;
      moveUp.addEventListener("click", () => void command({
        type: "queue-move",
        queueEntryId: entry.queueEntryId,
        beforeEntryId: upcomingEntries[upcomingIndex - 1]?.queueEntryId ?? null,
        expectedQueueRevision: queue.revision,
      }));
      const moveDown = document.createElement("button");
      moveDown.textContent = "Move down";
      moveDown.disabled = !queue.editable || entry.reserved || upcomingIndex < 0 || upcomingIndex >= upcomingEntries.length - 1;
      moveDown.addEventListener("click", () => void command({
        type: "queue-move",
        queueEntryId: entry.queueEntryId,
        beforeEntryId: upcomingEntries[upcomingIndex + 2]?.queueEntryId ?? null,
        expectedQueueRevision: queue.revision,
      }));
      actions.append(play, moveUp, moveDown, remove);
      row.append(actions);
    }
    list.append(row);
  }
}

async function loadBrowse(query = ""): Promise<void> {
  const list = byId("browseList");
  list.textContent = "Loading…";
  try {
    const page = query ? await search(query) : await getHome();
    list.replaceChildren(...page.items.map(mediaCard));
    if (!page.items.length) list.textContent = "No items found.";
  } catch (error) {
    list.textContent = error instanceof Error ? error.message : "Library unavailable.";
  }
}

function connectWebSocket(): void {
  if (!session || document.hidden) return;
  webSocket?.close();
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/v1/events`, `seeing-stone.v1.${session.webSocketTicket}`);
  webSocket = socket;
  socket.addEventListener("open", () => {
    clearTimeout(reconnectTimer);
    reconnectIndex = 0;
    setConnection("Connected");
  });
  socket.addEventListener("message", (event) => {
    try {
      const envelope = JSON.parse(String(event.data)) as { topic: string; payload: unknown };
      model.apply(envelope.topic, envelope.payload);
    } catch { /* Invalid push frames never reach the UI. */ }
  });
  socket.addEventListener("close", () => { if (webSocket === socket) scheduleReconnect(); });
}

function scheduleReconnect(): void {
  if (document.hidden) return;
  setConnection("Reconnecting…", Date.now() - model.lastContact > 10_000);
  const delays = [500, 1000, 2000, 5000, 10_000, 15_000];
  clearTimeout(reconnectTimer);
  const attempt = reconnectIndex++;
  reconnectTimer = window.setTimeout(() => {
    if (attempt >= delays.length && session) {
      void longPoll().then((value) => model.setBootstrap(value)).finally(() => void bootstrap());
    } else void bootstrap();
  }, delays[Math.min(attempt, delays.length - 1)] + Math.random() * 350);
}

async function bootstrap(): Promise<void> {
  try {
    session = await getSession();
    model.setBootstrap(session.bootstrap);
    byId("pairing").classList.add("hidden");
    byId("remote").classList.remove("hidden");
    setConnection("Connected");
    connectWebSocket();
  } catch {
    session = null;
    byId("remote").classList.add("hidden");
    byId("pairing").classList.remove("hidden");
    setConnection("Pairing required");
  }
}

extractTicket();
model.addEventListener("change", render);
byId<HTMLFormElement>("pairForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = byId<HTMLInputElement>("deviceName").value;
  const code = byId<HTMLInputElement>("pairCode").value;
  byId("pairError").textContent = "";
  void pair(pairingTicket ? { ticket: pairingTicket, name } : { code, name }).then(() => {
    pairingTicket = null;
    return bootstrap();
  }).catch((error) => { byId("pairError").textContent = error instanceof Error ? error.message : "Pairing failed."; });
});
document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((candidate) => candidate.removeAttribute("aria-current"));
    button.setAttribute("aria-current", "page");
    document.querySelectorAll(".view").forEach((view) => view.classList.add("hidden"));
    byId(`${button.dataset.view}View`).classList.remove("hidden");
    if (button.dataset.view === "browse") void loadBrowse();
  });
});
byId("playPause").addEventListener("click", () => void command({ type: "set-paused", paused: !model.bootstrap!.player.paused }));
byId("stop").addEventListener("click", () => void command({ type: "stop" }));
byId("previous").addEventListener("click", () => void command({ type: model.bootstrap?.player.live ? "previous-channel" : "previous" }));
byId("next").addEventListener("click", () => void command({ type: model.bootstrap?.player.live ? "next-channel" : "next" }));
byId("goLive").addEventListener("click", () => void command({ type: "go-live" }));
byId("seekBack").addEventListener("click", () => void command({ type: "seek-relative", seconds: -10 }));
byId("seekForward").addEventListener("click", () => void command({ type: "seek-relative", seconds: 30 }));
byId<HTMLInputElement>("seek").addEventListener("change", (event) => void command({ type: "seek", positionTicks: Number((event.target as HTMLInputElement).value) }));
byId<HTMLInputElement>("volume").addEventListener("change", (event) => void command({ type: "set-volume", volume: Number((event.target as HTMLInputElement).value) }));
byId("mute").addEventListener("click", () => void command({ type: "toggle-mute" }));
byId<HTMLSelectElement>("audioTrack").addEventListener("change", (event) => void command({ type: "select-audio", trackId: Number((event.target as HTMLSelectElement).value) }));
byId<HTMLSelectElement>("subtitleTrack").addEventListener("change", (event) => {
  const value = (event.target as HTMLSelectElement).value;
  void command({ type: "select-subtitle", trackId: value ? Number(value) : null });
});
byId("clearQueue").addEventListener("click", () => void command({ type: "queue-clear-upcoming", expectedQueueRevision: model.bootstrap!.queue.revision }));
byId<HTMLFormElement>("searchForm").addEventListener("submit", (event) => { event.preventDefault(); void loadBrowse(byId<HTMLInputElement>("search").value); });
byId<HTMLInputElement>("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void loadBrowse(byId<HTMLInputElement>("search").value), 300);
});
for (const eventName of ["pageshow", "online"] as const) window.addEventListener(eventName, () => void bootstrap());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { clearTimeout(reconnectTimer); webSocket?.close(); } else void bootstrap();
});
window.setInterval(() => { if (session && Date.now() - model.lastContact > 10_000) setConnection("Connection stale", true); }, 1000);
void bootstrap();
