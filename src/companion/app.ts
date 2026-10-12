import type { CompanionCommand, CompanionLibrarySort, CompanionLibrarySummary, CompanionLiveTvChannel, CompanionLiveTvGuide, CompanionMediaSummary } from "../shared/companionContracts";
import { CompanionRequestError, getLibraries, getLibrary, getLiveTvGuide, getSeries, getSession, longPoll, pair, search, sendCommand, type RuntimeSession } from "./api";
import { CompanionModel } from "./state";
import { initializeYouTube } from "./youtube";

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const model = new CompanionModel();
let session: RuntimeSession | null = null;
let webSocket: WebSocket | null = null;
let reconnectIndex = 0;
let reconnectTimer = 0;
let searchTimer = 0;
let pairingTicket: string | null = null;
let browseLibraries: CompanionLibrarySummary[] = [];
let activeLibraryRef: string | null = null;
let activeSeries: { itemRef: string; name: string } | null = null;
let browseNextOffset: number | null = null;
let browseRequestId = 0;
let browseLoadedItems = 0;
let liveTvGuide: CompanionLiveTvGuide | null = null;
let liveTvGuideRequestId = 0;
let liveTvSearchTimer = 0;
let bootstrapRequest: Promise<void> | null = null;
let queueSignature = "";
const editingRanges = new Set<string>();
const openYouTube = initializeYouTube(async (value) => {
  if (!session || byId<HTMLFieldSetElement>("remoteControls").disabled) throw new Error("Reconnect the phone remote before adding videos.");
  await sendCommand(session, value);
});

function extractTicket(): void {
  const match = location.hash.match(/^#\/pair\?(.+)$/);
  if (!match) return;
  pairingTicket = new URLSearchParams(match[1]).get("ticket");
  history.replaceState(null, "", `${location.pathname}${location.search}#/pair`);
}

function formatTicks(ticks: number): string {
  const seconds = Math.max(0, Math.floor(ticks / 10_000_000));
  const minutes = Math.floor(seconds / 60);
  return seconds >= 3600
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function setConnection(text: string, stale = false): void {
  setStatus("connection", text);
  byId<HTMLFieldSetElement>("remoteControls").disabled = stale;
}

function setStatus(id: string, text: string): void {
  const element = byId(id);
  if (element.textContent !== text) element.textContent = text;
}

async function command(value: CompanionCommand): Promise<void> {
  if (!session || byId<HTMLFieldSetElement>("remoteControls").disabled) return;
  byId("commandStatus").textContent = "";
  try {
    await sendCommand(session, value);
  } catch (error) {
    byId("commandStatus").textContent = error instanceof Error ? error.message : "The command could not be sent.";
    if (!(error instanceof CompanionRequestError) || error.status === 401 || error.status === 409) await bootstrap();
  }
}

function render(): void {
  const state = model.bootstrap;
  if (!state || !session) return;
  const player = state.player;
  const watchParty = state.watchParty;
  session.bootstrap = state;
  byId("nowPlayingTitle").textContent = player.media?.name ?? "Nothing playing";
  byId("mediaDetail").textContent = player.media?.seriesName
    ? [player.media.seriesName, player.media.seasonNumber !== null ? `S${player.media.seasonNumber}` : "", player.media.episodeNumber !== null ? `E${player.media.episodeNumber}` : ""].filter(Boolean).join(" · ")
    : player.media?.type ?? "";
  setStatus("playbackStatus", player.buffering || player.phase === "buffering" ? "Buffering…"
    : player.phase === "loading" ? "Loading on the desktop…"
    : player.phase === "error" ? "Playback could not continue. Check the desktop for details."
    : player.phase === "idle" || player.phase === "stopped" ? "Choose something from Browse, Up Next, or Live TV to play on your desktop."
    : player.phase === "ended" ? "Playback finished." : "");
  const seekInput = byId<HTMLInputElement>("seek");
  const seekableUntil = player.seekableUntilTicks ?? player.durationTicks;
  if (!editingRanges.has("seek")) {
    seekInput.max = String(Math.max(1, seekableUntil));
    seekInput.value = String(Math.min(player.positionTicks, seekableUntil || 1));
    seekInput.setAttribute("aria-valuetext", player.seekableUntilTicks === null
      ? formatTicks(player.positionTicks)
      : `${formatTicks(player.positionTicks)}; available through ${formatTicks(seekableUntil)}`);
  }
  seekInput.disabled = !player.controls.canSeek;
  if (!editingRanges.has("seek")) byId("position").textContent = formatTicks(player.positionTicks);
  byId("duration").textContent = formatTicks(player.durationTicks);
  byId("playPause").textContent = player.paused ? "Play" : "Pause";
  byId("playPause").setAttribute("aria-label", player.paused ? "Play" : "Pause");
  byId<HTMLButtonElement>("playPause").disabled = !player.controls.canPlayPause;
  byId<HTMLButtonElement>("stop").disabled = !player.controls.canStop;
  byId<HTMLButtonElement>("seekBack").disabled = !player.controls.canSeek;
  byId<HTMLButtonElement>("seekForward").disabled = !player.controls.canSeek;
  if (!editingRanges.has("volume")) {
    byId<HTMLInputElement>("volume").value = String(player.volume);
    byId("volume").setAttribute("aria-valuetext", `${player.volume}%`);
  }
  byId("mute").textContent = player.muted ? "Unmute" : "Mute";
  byId<HTMLButtonElement>("previous").disabled = !(player.controls.canPrevious || player.controls.canPreviousChannel);
  byId<HTMLButtonElement>("next").disabled = !(player.controls.canNext || player.controls.canNextChannel);
  byId("previous").textContent = player.live ? "Channel −" : "‹‹";
  byId("next").textContent = player.live ? "Channel +" : "››";
  byId("previous").setAttribute("aria-label", player.live ? "Previous channel" : "Previous item");
  byId("next").setAttribute("aria-label", player.live ? "Next channel" : "Next item");
  byId("goLive").classList.toggle("hidden", !player.controls.canGoLive);
  const skipSegment = byId<HTMLButtonElement>("skipSegment");
  const skipSegmentFocused = document.activeElement === skipSegment;
  skipSegment.classList.toggle("hidden", player.skipSegment === null);
  if (!player.skipSegment && skipSegmentFocused) byId<HTMLButtonElement>("playPause").focus({ preventScroll: true });
  if (player.skipSegment) {
    skipSegment.textContent = player.skipSegment.label;
    skipSegment.disabled = !player.skipSegment.enabled;
    skipSegment.title = player.skipSegment.enabled
      ? player.skipSegment.label
      : `${player.skipSegment.label} is unavailable until more of the download is ready.`;
    skipSegment.setAttribute("aria-label", skipSegment.title);
  }
  const timing = byId("watchPartyTiming");
  timing.classList.toggle("hidden", !watchParty.joined);
  if (watchParty.joined) {
    const phaseLabel = watchParty.phase === "waiting-for-participant" ? "Waiting for another participant"
      : watchParty.phase === "preparing" ? "Loading video on this computer"
      : watchParty.phase === "buffering" ? "Buffering video on this computer"
      : watchParty.phase === "retrying" ? "Retrying readiness confirmation"
      : watchParty.phase === "ready" ? "This computer is ready—waiting for everyone"
      : watchParty.phase === "starting" ? "Starting…"
      : watchParty.phase === "error" ? "This computer could not prepare playback"
      : watchParty.phase === "playing" ? "Playing together" : "Watch party joined";
    setStatus("watchPartyPreparation", phaseLabel);
    const offset = watchParty.localSyncOffsetMilliseconds;
    byId("watchPartyOffset").textContent = offset === 0 ? "In sync" : `${Math.abs(offset)} ms ${offset > 0 ? "earlier" : "later"}`;
    byId<HTMLButtonElement>("watchPartyEarlier").disabled = offset >= 2000;
    byId<HTMLButtonElement>("watchPartyLater").disabled = offset <= -2000;
    byId<HTMLButtonElement>("watchPartyReset").disabled = offset === 0;
  }
  populateTracks("audioTrack", player.audioTracks, false);
  populateTracks("subtitleTrack", player.subtitleTracks, true);
  renderQueue();
}

function populateTracks(id: string, tracks: Array<{ id: number; label: string; selected: boolean }>, allowOff: boolean): void {
  const select = byId<HTMLSelectElement>(id);
  const signature = JSON.stringify(tracks);
  if (select.dataset.tracks === signature) return;
  select.dataset.tracks = signature;
  select.replaceChildren();
  select.disabled = tracks.length === 0;
  if (!allowOff && !tracks.length) select.add(new Option("No audio tracks available", ""));
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
  const episodeNumber = media.type === "episode" ? [
    media.seasonNumber === 0 ? "Special" : media.seasonNumber !== null ? `S${media.seasonNumber}` : "",
    media.episodeNumber !== null ? `E${media.episodeNumber}` : "",
  ].filter(Boolean).join(" ") : "";
  detail.textContent = [media.seriesName, episodeNumber, media.productionYear].filter(Boolean).join(" · ") || media.type;
  const actions = document.createElement("div");
  actions.className = "actions";
  if (media.type === "series") {
    const episodes = document.createElement("button");
    episodes.textContent = "Episodes";
    episodes.setAttribute("aria-label", `Browse episodes of ${media.name}`);
    episodes.addEventListener("click", () => { void openSeries(media); });
    actions.append(episodes);
    article.append(title, detail, actions);
    return article;
  }
  for (const [label, placement] of [["Play", "play-now"], ["Next", "play-next"], ["Queue", "queue-end"]] as const) {
    const button = document.createElement("button");
    button.textContent = label;
    button.setAttribute("aria-label", `${label === "Next" ? "Play next:" : label === "Queue" ? "Add to queue:" : "Play"} ${media.name}`);
    button.disabled = !media.playable;
    button.addEventListener("click", () => void command({ type: "send-item", itemRef: media.itemRef, placement, resumeMode: "start-over" }));
    actions.append(button);
  }
  article.append(title, detail, actions);
  return article;
}

function renderQueue(): void {
  const queue = model.bootstrap!.queue;
  const signature = JSON.stringify(queue);
  if (signature === queueSignature) return;
  queueSignature = signature;
  const upcomingEntries = queue.entries.filter((entry) => entry.state === "upcoming");
  const list = byId<HTMLOListElement>("queueList");
  list.replaceChildren();
  byId("queueMessage").textContent = queue.blockedReason === "watchparty" ? "Queue editing is paused during this watch party."
    : !queue.entries.length ? "Your queue is empty. Choose Next or Queue from Browse to add something."
    : !upcomingEntries.length ? "Nothing else queued. Add something from Browse to keep watching." : "";
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

function renderLibraryTabs(): void {
  const tabs = byId("libraryTabs");
  tabs.replaceChildren();
  for (const library of browseLibraries) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = library.name;
    button.setAttribute("aria-pressed", String(library.itemRef === activeLibraryRef));
    button.addEventListener("click", () => {
      clearTimeout(searchTimer);
      activeLibraryRef = library.itemRef;
      activeSeries = null;
      byId<HTMLInputElement>("search").value = "";
      renderLibraryTabs();
      tabs.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });
      void loadBrowse();
    });
    tabs.append(button);
  }
}

async function initializeBrowse(): Promise<void> {
  if (!browseLibraries.length) {
    byId("browseStatus").textContent = "Loading libraries…";
    try {
      browseLibraries = await getLibraries();
    } catch (error) {
      byId("browseStatus").textContent = "";
      byId("browseList").textContent = error instanceof Error ? error.message : "Libraries unavailable.";
      return;
    }
    activeLibraryRef = activeLibraryRef ?? browseLibraries[0]?.itemRef ?? null;
    renderLibraryTabs();
  }
  await loadBrowse();
}

async function openSeries(media: CompanionMediaSummary): Promise<void> {
  clearTimeout(searchTimer);
  activeSeries = { itemRef: media.itemRef, name: media.name };
  byId<HTMLInputElement>("search").value = "";
  renderLibraryTabs();
  await loadBrowse();
}

async function loadBrowse(query = "", append = false): Promise<void> {
  query = query.trim();
  const requestId = ++browseRequestId;
  const list = byId("browseList");
  const activeControl = list.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  list.setAttribute("aria-busy", "true");
  if (!append) {
    list.textContent = "Loading…";
    browseLoadedItems = 0;
  }
  byId<HTMLButtonElement>("browseMore").classList.add("hidden");
  byId<HTMLButtonElement>("browseBack").classList.toggle("hidden", !activeSeries);
  byId<HTMLSelectElement>("browseSort").disabled = Boolean(activeSeries || query);
  try {
    const offset = append ? browseNextOffset ?? 0 : 0;
    const page = query
      ? await search(query)
      : activeSeries
        ? await getSeries(activeSeries.itemRef, offset)
        : activeLibraryRef
          ? await getLibrary(activeLibraryRef, byId<HTMLSelectElement>("browseSort").value as CompanionLibrarySort, offset)
          : { revision: "empty", items: [], nextOffset: null };
    if (requestId !== browseRequestId) return;
    if (append) list.append(...page.items.map(mediaCard));
    else list.replaceChildren(...page.items.map(mediaCard));
    browseLoadedItems += page.items.length;
    browseNextOffset = page.nextOffset;
    const selectedLibrary = browseLibraries.find((library) => library.itemRef === activeLibraryRef);
    byId("browseStatus").textContent = query
      ? `${browseLoadedItems} search result${browseLoadedItems === 1 ? "" : "s"}`
      : activeSeries
        ? `${activeSeries.name} · ${browseLoadedItems} episode${browseLoadedItems === 1 ? "" : "s"}`
        : `${selectedLibrary?.name ?? "Library"} · ${browseLoadedItems} item${browseLoadedItems === 1 ? "" : "s"}`;
    byId<HTMLButtonElement>("browseMore").classList.toggle("hidden", page.nextOffset === null || Boolean(query));
    if (!append && !page.items.length) list.textContent = "No items found.";
  } catch (error) {
    if (requestId !== browseRequestId) return;
    const message = error instanceof Error ? error.message : "Library unavailable.";
    if (!append) {
      const explanation = document.createElement("p");
      explanation.textContent = message;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Try again";
      retry.setAttribute("aria-label", activeSeries && !query ? `Retry episodes of ${activeSeries.name}` : "Retry library results");
      retry.addEventListener("click", () => {
        if (requestId !== browseRequestId) return;
        retry.disabled = true;
        void loadBrowse(query);
      });
      list.replaceChildren(explanation, retry);
    }
    byId("browseStatus").textContent = append ? `${message} Your loaded items are still available. Try Load more again.` : "";
    byId("browseMore").classList.toggle("hidden", !append || browseNextOffset === null);
  } finally {
    if (requestId === browseRequestId) {
      list.setAttribute("aria-busy", "false");
      if (activeControl && !activeControl.isConnected && document.activeElement === document.body
        && !byId("browseView").classList.contains("hidden")) {
        list.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
      }
    }
  }
}

function liveTvTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function appendLiveTvProgram(container: HTMLElement, program: CompanionLiveTvChannel["programs"][number]): void {
  const row = document.createElement("div");
  row.className = `live-tv-program${program.isLive ? " is-live" : ""}`;
  const time = document.createElement("time");
  time.dateTime = program.startUtc;
  time.textContent = liveTvTime(program.startUtc);
  const name = document.createElement("strong");
  name.textContent = program.name;
  row.append(time, name);
  container.append(row);
}

function liveTvChannelCard(channel: CompanionLiveTvChannel): HTMLElement {
  const card = document.createElement("article");
  card.className = `live-tv-channel-card${channel.isPlaying ? " is-playing" : ""}`;
  const heading = document.createElement("div");
  heading.className = "live-tv-channel-heading";
  const identity = document.createElement("div");
  const name = document.createElement("strong");
  const number = document.createElement("span");
  name.textContent = channel.name;
  number.textContent = channel.number ? `Channel ${channel.number}` : "Live channel";
  identity.append(name, number);
  const watch = document.createElement("button");
  watch.className = channel.isPlaying ? "" : "primary";
  watch.textContent = channel.isPlaying ? "Playing" : "Watch";
  watch.disabled = channel.isPlaying;
  watch.addEventListener("click", async () => {
    watch.disabled = true;
    watch.textContent = "Switching…";
    await command({ type: "start-live", channelRef: channel.channelRef });
    await loadLiveTvGuide();
  });
  heading.append(identity, watch);
  const programs = document.createElement("div");
  programs.className = "live-tv-programs";
  if (!channel.programs.length) {
    const unavailable = document.createElement("span");
    unavailable.className = "muted";
    unavailable.textContent = "No schedule information.";
    programs.append(unavailable);
  } else {
    for (const program of channel.programs.slice(0, 3)) appendLiveTvProgram(programs, program);
    if (channel.programs.length > 3) {
      const later = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = `${channel.programs.length - 3} later program${channel.programs.length === 4 ? "" : "s"}`;
      const laterPrograms = document.createElement("div");
      laterPrograms.className = "live-tv-programs";
      for (const program of channel.programs.slice(3)) appendLiveTvProgram(laterPrograms, program);
      later.append(summary, laterPrograms);
      programs.append(later);
    }
  }
  card.append(heading, programs);
  return card;
}

function renderLiveTvGuide(): void {
  const list = byId("liveTvGuideList");
  const status = byId("liveTvGuideStatus");
  if (!liveTvGuide || liveTvGuide.availability !== "available") {
    list.replaceChildren();
    status.textContent = liveTvGuide?.message || "Live TV is unavailable.";
    return;
  }
  const query = byId<HTMLInputElement>("liveTvSearch").value.normalize("NFC").trim().toLocaleLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  const matches = terms.length
    ? liveTvGuide.channels.filter((channel) => {
      const searchable = [channel.number, channel.name, ...channel.programs.map((program) => program.name)]
        .filter(Boolean).join(" ").toLocaleLowerCase();
      return terms.every((term) => searchable.includes(term));
    })
    : liveTvGuide.channels;
  const visible = matches.slice(0, 200);
  status.textContent = matches.length > visible.length
    ? `Showing ${visible.length} of ${matches.length} channels. Refine your search to see more.`
    : `${matches.length} ${matches.length === 1 ? "channel" : "channels"}`;
  if (!visible.length) {
    list.textContent = "No channels or programs match your search.";
    return;
  }
  list.replaceChildren(...visible.map(liveTvChannelCard));
}

async function loadLiveTvGuide(): Promise<void> {
  const requestId = ++liveTvGuideRequestId;
  byId<HTMLButtonElement>("refreshLiveTv").disabled = true;
  byId("liveTvGuideStatus").textContent = "Loading guide…";
  try {
    const guide = await getLiveTvGuide();
    if (requestId !== liveTvGuideRequestId) return;
    liveTvGuide = guide;
    renderLiveTvGuide();
  } catch (error) {
    if (requestId !== liveTvGuideRequestId) return;
    byId("liveTvGuideList").replaceChildren();
    byId("liveTvGuideStatus").textContent = error instanceof Error ? error.message : "The guide is unavailable.";
  } finally {
    if (requestId === liveTvGuideRequestId) byId<HTMLButtonElement>("refreshLiveTv").disabled = false;
  }
}

function connectWebSocket(): void {
  if (!session || document.hidden) return;
  webSocket?.close();
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/v1/events`, `seeing-stone.v3.${session.webSocketTicket}`);
  webSocket = socket;
  socket.addEventListener("open", () => {
    if (webSocket !== socket) return;
    clearTimeout(reconnectTimer);
    reconnectIndex = 0;
    setConnection("Connected");
  });
  socket.addEventListener("message", (event) => {
    if (webSocket !== socket) return;
    try {
      const envelope = JSON.parse(String(event.data)) as { topic: string; payload: unknown };
      model.apply(envelope.topic, envelope.payload);
      setConnection("Connected");
    } catch { /* Invalid push frames never reach the UI. */ }
  });
  socket.addEventListener("close", () => { if (webSocket === socket) scheduleReconnect(); });
}

function scheduleReconnect(): void {
  if (document.hidden) return;
  setConnection("Reconnecting…", true);
  const delays = [500, 1000, 2000, 5000, 10_000, 15_000];
  clearTimeout(reconnectTimer);
  const attempt = reconnectIndex++;
  reconnectTimer = window.setTimeout(() => {
    if (attempt >= delays.length && session) {
      void longPoll().then((value) => model.setBootstrap(value)).catch(() => undefined).finally(() => void bootstrap());
    } else void bootstrap();
  }, delays[Math.min(attempt, delays.length - 1)] + Math.random() * 350);
}

function bootstrap(): Promise<void> {
  if (bootstrapRequest) return bootstrapRequest;
  clearTimeout(reconnectTimer);
  bootstrapRequest = (async () => {
    try {
      const freshSession = await getSession();
      // An outstanding command may already have allocated a sequence in this epoch.
      if (session?.sessionEpoch === freshSession.sessionEpoch) {
        session.nextSequence = Math.max(session.nextSequence, freshSession.nextSequence);
        session.webSocketTicket = freshSession.webSocketTicket;
        session.csrfToken = freshSession.csrfToken;
      } else session = freshSession;
      model.setBootstrap(freshSession.bootstrap);
      byId("pairing").classList.add("hidden");
      byId("connectionRecovery").classList.add("hidden");
      byId("remote").classList.remove("hidden");
      setConnection("Connected");
      connectWebSocket();
    } catch (error) {
      if (error instanceof CompanionRequestError && error.status === 401) {
        session = null;
        const socket = webSocket;
        webSocket = null;
        socket?.close();
        browseLibraries = [];
        activeLibraryRef = null;
        activeSeries = null;
        byId("remote").classList.add("hidden");
        byId("connectionRecovery").classList.add("hidden");
        byId("pairing").classList.remove("hidden");
        setConnection("Pairing required", true);
      } else {
        byId("pairing").classList.add("hidden");
        byId("connectionRecovery").classList.toggle("hidden", Boolean(session));
        byId("connectionRecoveryMessage").textContent = "Cannot reach your desktop. Keep Seeing Stone open and connect this phone to the same private network. Retrying automatically…";
        scheduleReconnect();
      }
    }
  })().finally(() => { bootstrapRequest = null; });
  return bootstrapRequest;
}

extractTicket();
model.addEventListener("change", render);
byId<HTMLFormElement>("pairForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const submit = byId<HTMLButtonElement>("pairSubmit");
  if (submit.disabled) return;
  const name = byId<HTMLInputElement>("deviceName").value.trim();
  const code = byId<HTMLInputElement>("pairCode").value.trim();
  byId("pairError").textContent = "";
  if (!name || (!pairingTicket && !/^[0-9]{8}$/.test(code))) {
    byId("pairError").textContent = !name ? "Enter a name for this phone." : "Enter the 8-digit code shown on your desktop.";
    byId<HTMLInputElement>(!name ? "deviceName" : "pairCode").focus();
    return;
  }
  submit.disabled = true;
  submit.textContent = "Pairing…";
  void pair(pairingTicket ? { ticket: pairingTicket, name } : { code, name }).then(() => {
    pairingTicket = null;
    return bootstrap();
  }).catch((error) => {
    byId("pairError").textContent = error instanceof Error ? error.message : "Pairing failed.";
    if (error instanceof CompanionRequestError && error.status >= 400 && error.status < 500) pairingTicket = null;
  }).finally(() => { submit.disabled = false; submit.textContent = "Pair phone"; });
});
byId("retryConnection").addEventListener("click", () => void bootstrap());
document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((candidate) => candidate.removeAttribute("aria-current"));
    button.setAttribute("aria-current", "page");
    document.querySelectorAll(".view").forEach((view) => view.classList.add("hidden"));
    byId(`${button.dataset.view}View`).classList.remove("hidden");
    if (button.dataset.view === "browse") void initializeBrowse();
    if (button.dataset.view === "liveTv") void loadLiveTvGuide();
    if (button.dataset.view === "youtube") void openYouTube();
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
for (const id of ["seek", "volume"]) {
  const range = byId<HTMLInputElement>(id);
  range.addEventListener("pointerdown", () => editingRanges.add(id));
  range.addEventListener("keydown", (event) => {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) editingRanges.add(id);
  });
  range.addEventListener("input", () => {
    range.setAttribute("aria-valuetext", id === "seek" ? formatTicks(Number(range.value)) : `${range.value}%`);
    if (id === "seek") byId("position").textContent = formatTicks(Number(range.value));
  });
  for (const event of ["change", "blur", "pointercancel"]) range.addEventListener(event, () => editingRanges.delete(id));
}
byId("skipSegment").addEventListener("click", () => {
  const skipSegment = model.bootstrap?.player.skipSegment;
  if (skipSegment?.enabled) void command({ type: "seek", positionTicks: skipSegment.endTicks });
});
byId<HTMLInputElement>("volume").addEventListener("change", (event) => void command({ type: "set-volume", volume: Number((event.target as HTMLInputElement).value) }));
byId("mute").addEventListener("click", () => void command({ type: "toggle-mute" }));
byId("watchPartyEarlier").addEventListener("click", () => void command({
  type: "set-watchparty-sync-offset",
  offsetMilliseconds: Math.min(2000, model.bootstrap!.watchParty.localSyncOffsetMilliseconds + 100),
}));
byId("watchPartyLater").addEventListener("click", () => void command({
  type: "set-watchparty-sync-offset",
  offsetMilliseconds: Math.max(-2000, model.bootstrap!.watchParty.localSyncOffsetMilliseconds - 100),
}));
byId("watchPartyReset").addEventListener("click", () => void command({ type: "set-watchparty-sync-offset", offsetMilliseconds: 0 }));
byId<HTMLSelectElement>("audioTrack").addEventListener("change", (event) => void command({ type: "select-audio", trackId: Number((event.target as HTMLSelectElement).value) }));
byId<HTMLSelectElement>("subtitleTrack").addEventListener("change", (event) => {
  const value = (event.target as HTMLSelectElement).value;
  void command({ type: "select-subtitle", trackId: value ? Number(value) : null });
});
byId("clearQueue").addEventListener("click", () => void command({ type: "queue-clear-upcoming", expectedQueueRevision: model.bootstrap!.queue.revision }));
byId<HTMLFormElement>("searchForm").addEventListener("submit", (event) => { event.preventDefault(); clearTimeout(searchTimer); void loadBrowse(byId<HTMLInputElement>("search").value); });
byId<HTMLInputElement>("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void loadBrowse(byId<HTMLInputElement>("search").value), 300);
});
byId<HTMLSelectElement>("browseSort").addEventListener("change", () => { void loadBrowse(); });
byId("browseBack").addEventListener("click", () => {
  clearTimeout(searchTimer);
  activeSeries = null;
  byId<HTMLInputElement>("search").value = "";
  renderLibraryTabs();
  void loadBrowse();
});
byId("browseMore").addEventListener("click", () => {
  if (browseNextOffset !== null) void loadBrowse(byId<HTMLInputElement>("search").value, true);
});
byId("refreshLiveTv").addEventListener("click", () => { void loadLiveTvGuide(); });
byId<HTMLFormElement>("liveTvSearchForm").addEventListener("submit", (event) => { event.preventDefault(); renderLiveTvGuide(); });
byId<HTMLInputElement>("liveTvSearch").addEventListener("input", () => {
  clearTimeout(liveTvSearchTimer);
  liveTvSearchTimer = window.setTimeout(renderLiveTvGuide, 120);
});
window.addEventListener("pageshow", (event) => { if (event.persisted) void bootstrap(); });
window.addEventListener("online", () => void bootstrap());
window.addEventListener("offline", () => setConnection("Offline — check your Wi-Fi connection", true));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { clearTimeout(reconnectTimer); webSocket?.close(); } else void bootstrap();
});
window.setInterval(() => {
  if (session && !document.hidden && Date.now() - model.lastContact > 10_000) {
    setConnection("Reconnecting…", true);
    if (webSocket?.readyState === WebSocket.OPEN) { webSocket.close(); }
  }
}, 1000);
void bootstrap();
