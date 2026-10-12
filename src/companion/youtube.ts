import type { CompanionCommand, CompanionYouTubePage, CompanionYouTubeState } from "../shared/companionContracts";
import { browseYouTube, getYouTubeState } from "./api";

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export function initializeYouTube(send: (command: CompanionCommand) => Promise<void>): () => Promise<void> {
  let state: CompanionYouTubeState | null = null;
  let query = "";
  let nextPageToken: string | null = null;
  let requestId = 0;
  let loaded = false;
  let adding = false;
  let loading = false;
  let stateRequestId = 0;
  let refreshingState = false;
  let controlling = false;
  let queueSignature = "";
  const titles = new Map<string, string>();
  const message = (error: unknown): string => error instanceof Error ? error.message : "YouTube is unavailable. Please try again.";

  function refreshButtons(): void {
    byId<HTMLButtonElement>("youtubeMore").disabled = loading;
    document.querySelectorAll<HTMLButtonElement>("#youtubeResults button, #youtubeLinkForm button, #youtubeQueue button").forEach((button) => {
      button.disabled = adding || controlling || !state?.room?.controllable;
    });
    document.querySelectorAll<HTMLButtonElement>("#youtubeTransport button").forEach(button => {
      button.disabled = adding || controlling || !state?.room?.controllable || !state.room.videoId;
    });
    byId<HTMLButtonElement>("youtubeNext").disabled ||= (state?.room?.queue.length ?? 0) < 2;
  }

  async function refreshState(): Promise<void> {
    const id = ++stateRequestId;
    refreshingState = true;
    try {
      const value = await getYouTubeState();
      if (id !== stateRequestId) return;
      state = value;
      const roomLabel = value.room ? `Room: ${value.room.name}` : "Open or join a YouTube room in Watch Parties on the desktop to add videos.";
      if (byId("youtubeRoom").textContent !== roomLabel) byId("youtubeRoom").textContent = roomLabel;
      const room = value.room;
      byId("youtubeNowPlaying").textContent = room?.videoId ? titles.get(room.videoId) ?? `YouTube video · ${room.videoId}` : "Nothing playing";
      const seconds = Math.floor(room?.positionSeconds ?? 0);
      byId("youtubePlaybackStatus").textContent = room?.videoId ? `${room.controllable ? room.playing ? "Playing" : "Paused" : "Controls unavailable — check the desktop room"} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "Playback runs on the desktop.";
      byId("youtubePlayPause").textContent = room?.playing ? "Pause" : "Play";
      byId("youtubeSetup").classList.toggle("hidden", value.searchConfigured);
      const queue = byId("youtubeQueue");
      const signature = JSON.stringify([value.room?.id, value.room?.queue, [...titles]]);
      if (signature !== queueSignature) {
        queueSignature = signature;
        queue.replaceChildren();
        for (const [index, item] of (value.room?.queue ?? []).entries()) {
          const row = document.createElement("li");
          row.textContent = `${index === 0 ? "Current: " : ""}${titles.get(item.videoId) ?? `YouTube video · ${item.videoId}`}`;
          const actions = document.createElement("div");
          actions.className = "youtube-queue-actions";
          const addAction = (label: string, action: "play" | "remove" | "move-up" | "move-down") => {
            const button = document.createElement("button");
            button.type = "button"; button.textContent = label;
            button.setAttribute("aria-label", `${label}: ${titles.get(item.videoId) ?? `YouTube video ${item.videoId}`}`);
            const targetRoom = value.room!.id;
            button.addEventListener("click", () => void perform({ type: "youtube-queue", roomId: targetRoom, queueItemId: item.queueItemId, action }));
            actions.append(button);
          };
          if (index > 0) addAction("Play now", "play");
          if (index > 1) addAction("Move up", "move-up");
          if (index > 0 && index < value.room!.queue.length - 1) addAction("Move down", "move-down");
          addAction("Remove", "remove");
          row.append(actions);
          queue.append(row);
        }
        if (!value.room?.queue.length) queue.textContent = "No videos in the room queue.";
      }
    } catch (error) {
      if (id !== stateRequestId) return;
      state = null;
      byId("youtubeRoom").textContent = message(error);
      byId("youtubePlaybackStatus").textContent = "Disconnected. Playback controls are unavailable.";
    }
    if (id === stateRequestId) refreshingState = false;
    refreshButtons();
  }

  async function add(videoUrl: string, playNow = false): Promise<void> {
    if (adding || controlling || !state?.room?.controllable) return;
    adding = true;
    refreshButtons();
    byId("youtubeActionStatus").textContent = "Adding…";
    try {
      await send({ type: "youtube-add", videoUrl, roomId: state.room.id, playNow });
      byId("youtubeActionStatus").textContent = playNow ? "Sent to the desktop player." : "Added to the YouTube room queue.";
    } catch (error) { byId("youtubeActionStatus").textContent = message(error); }
    finally { adding = false; await refreshState(); }
  }

  async function perform(command: Extract<CompanionCommand, { type: "youtube-control" | "youtube-queue" }>) {
    if (controlling || adding || !state?.room?.controllable) return;
    controlling = true;
    stateRequestId++;
    refreshButtons();
    byId("youtubeActionStatus").textContent = "Sending…";
    try { await send(command); byId("youtubeActionStatus").textContent = "Sent to the YouTube room."; }
    catch (error) { byId("youtubeActionStatus").textContent = message(error); }
    finally { controlling = false; await refreshState(); }
  }

  function control(action: Extract<CompanionCommand, { type: "youtube-control" }>["action"]) {
    const room = state?.room;
    if (room?.queue[0]) void perform({ type: "youtube-control", roomId: room.id, queueItemId: room.queue[0].queueItemId, action });
  }

  function appendResults(page: CompanionYouTubePage): void {
    const list = byId("youtubeResults");
    for (const video of page.items) {
      // Decode API title entities as text; never insert API content as HTML.
      const title = video.title.replace(/&(?:amp|quot|#39|lt|gt);/g, (entity) => ({ "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">" })[entity]!);
      titles.set(video.videoId, title);
      const card = document.createElement("article");
      card.className = "media-card";
      const thumbnail = document.createElement("img");
      thumbnail.src = `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`;
      thumbnail.alt = "";
      thumbnail.loading = "lazy";
      thumbnail.referrerPolicy = "no-referrer";
      const heading = document.createElement("strong");
      heading.textContent = title;
      const channel = document.createElement("span");
      channel.textContent = video.channelTitle;
      const actions = document.createElement("div");
      actions.className = "actions";
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Add to queue";
      button.setAttribute("aria-label", `Add ${title} to queue`);
      button.addEventListener("click", () => void add(`https://www.youtube.com/watch?v=${video.videoId}`));
      actions.append(button);
      const play = document.createElement("button");
      play.type = "button"; play.textContent = "Play now";
      play.setAttribute("aria-label", `Play ${title} now`);
      play.addEventListener("click", () => void add(`https://www.youtube.com/watch?v=${video.videoId}`, true));
      actions.append(play);
      card.append(thumbnail, heading, channel, actions);
      list.append(card);
    }
    refreshButtons();
  }

  async function load(more = false): Promise<void> {
    if (more && (loading || !nextPageToken)) return;
    const id = ++requestId;
    loading = true;
    if (!more) {
      query = byId<HTMLInputElement>("youtubeSearch").value.trim();
      nextPageToken = null;
      byId("youtubeResults").replaceChildren();
      byId("youtubeMore").classList.add("hidden");
    }
    refreshButtons();
    byId("youtubeBrowseStatus").textContent = "Loading YouTube videos…";
    try {
      const page = await browseYouTube(query, more ? nextPageToken ?? "" : "");
      if (id !== requestId) return;
      loaded = true;
      nextPageToken = page.nextPageToken;
      appendResults(page);
      byId("youtubeMore").classList.toggle("hidden", !nextPageToken);
      byId("youtubeBrowseStatus").textContent = byId("youtubeResults").childElementCount ? (query ? `Results for “${query}”` : "Popular on YouTube · United States") : "No videos found. Try another search.";
    } catch (error) {
      if (id === requestId) byId("youtubeBrowseStatus").textContent = message(error);
    } finally {
      if (id === requestId) { loading = false; refreshButtons(); }
    }
  }

  byId("youtubeSearchForm").addEventListener("submit", (event) => { event.preventDefault(); void load(); });
  byId("youtubePopular").addEventListener("click", () => { byId<HTMLInputElement>("youtubeSearch").value = ""; void load(); });
  byId("youtubeMore").addEventListener("click", () => void load(true));
  byId("youtubeRefresh").addEventListener("click", () => void refreshState());
  byId("youtubeLinkForm").addEventListener("submit", (event) => { event.preventDefault(); void add(byId<HTMLInputElement>("youtubeLink").value.trim()); });
  byId("youtubeLinkPlay").addEventListener("click", () => {
    if (byId<HTMLFormElement>("youtubeLinkForm").reportValidity()) void add(byId<HTMLInputElement>("youtubeLink").value.trim(), true);
  });
  byId("youtubePlayPause").addEventListener("click", () => control(state?.room?.playing ? "pause" : "play"));
  byId("youtubeNext").addEventListener("click", () => control("next"));
  byId("youtubeRestart").addEventListener("click", () => control("restart"));
  byId("youtubeBack").addEventListener("click", () => control("back"));
  byId("youtubeForward").addEventListener("click", () => control("forward"));
  window.setInterval(() => {
    if (!document.hidden && !byId("youtubeView").classList.contains("hidden") && !adding && !controlling && !refreshingState) void refreshState();
  }, 2000);
  return async () => { await refreshState(); if (!loaded && state?.searchConfigured) await load(); };
}
