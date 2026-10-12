import type { FeatureRoom, FeatureState } from "../shared/playerFeatures";

export const partyReactions = [
  { emoji: "👏", label: "Applause" }, { emoji: "😂", label: "Laugh" },
  { emoji: "❤️", label: "Love" }, { emoji: "😮", label: "Wow" },
  { emoji: "😢", label: "Sad" }, { emoji: "🔥", label: "Fire" },
] as const;
type Message = FeatureRoom["messages"][number];

/** Seed from history on entry; only animate newly received, recent reactions. */
export class PartyReactionFeed {
  private context = "";
  private seen = new Set<string>();
  take(room: FeatureRoom | null): Message[] {
    const context = room ? `${room.id}:${room.timeline.generation}` : "";
    const messages = room?.messages ?? [];
    const changed = context !== this.context;
    if (changed) this.seen.clear();
    const fresh: Message[] = [];
    for (const message of messages) {
      if (this.seen.has(message.id)) continue;
      this.seen.add(message.id);
      if (!changed && message.kind === "reaction" && message.generation === room!.timeline.generation
        && room!.serverNow - message.createdAt >= -1000 && room!.serverNow - message.createdAt <= 5000
        && partyReactions.some(reaction => reaction.emoji === message.text)) fresh.push(message);
    }
    this.context = context;
    // Keep recent IDs across overlapping poll/command snapshots without growing forever.
    while (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!);
    return fresh.slice(-8);
  }
}

export function mountPartyReactions(options: {
  pickerParent: HTMLElement;
  nativeSurface: HTMLElement | null;
  nativeControls: HTMLElement | null;
  youtubeSurface: HTMLElement;
  playerView: HTMLElement;
  send: (emoji: string) => Promise<void>;
}): { update: (state: FeatureState) => void } {
  const feed = new PartyReactionFeed();
  const layer = document.createElement("div"); layer.className = "party-reaction-layer";
  layer.setAttribute("aria-hidden", "true");
  let state: FeatureState | null = null;
  let context = ""; let hidden = false; let busy = false; let cooldownUntil = 0;
  let sequence = 0;
  const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  const pickers: HTMLElement[] = [];
  const reactionButtons: HTMLButtonElement[] = [];
  const toggles: HTMLButtonElement[] = [];
  const statuses: HTMLElement[] = [];
  function clear(): void { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); layer.replaceChildren(); }
  function updateControls(): void {
    const available = state?.connection === "connected" && Boolean(state.room?.media);
    for (const button of reactionButtons) button.disabled = !available || busy || Date.now() < cooldownUntil;
    for (const toggle of toggles) { toggle.textContent = hidden ? "Show reactions" : "Hide reactions"; toggle.setAttribute("aria-pressed", String(hidden)); }
    for (const picker of pickers) picker.hidden = !state?.room;
  }
  async function react(emoji: string): Promise<void> {
    if (busy || Date.now() < cooldownUntil || state?.connection !== "connected" || !state.room?.media) return;
    const sentContext = context;
    busy = true; cooldownUntil = Date.now() + 600; updateControls();
    for (const status of statuses) status.textContent = "";
    try { await options.send(emoji); }
    catch { if (context === sentContext) for (const status of statuses) status.textContent = "Reaction could not be sent. Try again."; }
    finally { busy = false; updateControls(); setTimeout(updateControls, Math.max(0, cooldownUntil - Date.now())); }
  }
  function picker(parent: HTMLElement, compact = false): void {
    const bar = document.createElement("div"); bar.className = "party-reaction-picker"; bar.hidden = true;
    bar.setAttribute("role", "group"); bar.setAttribute("aria-label", "Watch party reactions");
    for (const { emoji, label } of partyReactions) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = emoji;
      button.dataset.reaction = emoji; button.title = label; button.setAttribute("aria-label", `React: ${label}`);
      button.addEventListener("click", event => { event.stopPropagation(); void react(emoji); });
      reactionButtons.push(button); bar.append(button);
    }
    const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "party-reaction-toggle";
    toggle.addEventListener("click", () => { hidden = !hidden; clear(); updateControls(); });
    toggles.push(toggle); bar.append(toggle);
    const status = document.createElement("span"); status.className = "party-reaction-status"; status.setAttribute("role", "status");
    statuses.push(status); bar.append(status);
    if (compact) {
      const menu = document.createElement("details"); menu.className = "party-reaction-menu"; menu.hidden = true;
      const summary = document.createElement("summary"); summary.textContent = "React"; summary.setAttribute("aria-label", "Watch party reactions");
      menu.append(summary, bar); parent.prepend(menu); pickers.push(menu);
      menu.addEventListener("toggle", () => {
        if (!menu.open) return;
        bar.style.transform = "";
        const bounds = bar.getBoundingClientRect();
        const shift = bounds.left < 8 ? 8 - bounds.left : bounds.right > window.innerWidth - 8 ? window.innerWidth - 8 - bounds.right : 0;
        bar.style.transform = `translateX(${shift}px)`;
      });
      menu.addEventListener("keydown", event => { if (event.key === "Escape") { event.stopPropagation(); menu.open = false; summary.focus(); } });
      bar.hidden = false;
    } else { parent.append(bar); pickers.push(bar); }
  }
  picker(options.pickerParent);
  if (options.nativeControls) picker(options.nativeControls, true);
  function burst(message: Message): void {
    while (layer.childElementCount >= 8) {
      const oldest = layer.firstElementChild as HTMLElement;
      clearTimeout(timers.get(oldest)); timers.delete(oldest); oldest.remove();
    }
    const bubble = document.createElement("div"); bubble.className = "party-reaction-burst";
    bubble.style.setProperty("--reaction-lane", String(sequence++ % 4));
    const emoji = document.createElement("span"); emoji.className = "party-reaction-emoji"; emoji.textContent = message.text;
    const author = document.createElement("span"); author.className = "party-reaction-author"; author.textContent = message.author;
    bubble.append(emoji, author); layer.append(bubble);
    timers.set(bubble, setTimeout(() => { bubble.remove(); timers.delete(bubble); }, 2800));
  }
  return { update(next) {
    state = next;
    const nextContext = next.room ? `${next.room.id}:${next.room.timeline.generation}` : "";
    if (context !== nextContext || next.connection !== "connected") { clear(); for (const status of statuses) status.textContent = ""; }
    context = nextContext;
    updateControls();
    const fresh = feed.take(next.room);
    const youtube = next.room?.media?.kind === "youtube";
    const surface = youtube ? options.youtubeSurface : options.nativeSurface;
    if (surface && layer.parentElement !== surface) { clear(); surface.append(layer); }
    const visible = youtube || !options.playerView.classList.contains("is-hidden");
    if (!next.room?.media || next.connection !== "connected" || hidden || !visible || document.hidden) { clear(); return; }
    for (const message of fresh) burst(message);
  } };
}
