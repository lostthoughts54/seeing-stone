import type { IptvCatalogueItem } from "../shared/iptv";
import { sameChannel } from "./iptvChannelHistory";
import "./iptvMiniGuide.css";

export function mountIptvMiniGuide(root: HTMLElement, watch: (item: IptvCatalogueItem) => void, close: () => void) {
  let active = false;
  let generation = 0;
  let openGeneration = 0;
  let timer: ReturnType<typeof setTimeout>;

  function open(current: IptvCatalogueItem): void {
    clearTimeout(timer);
    const opened = ++openGeneration;
    active = true;
    root.dataset.mode = "iptv";
    root.innerHTML = `<header><strong>IPTV · Mini guide</strong><input type="search" aria-label="Search IPTV channels" placeholder="Search channels" maxlength="256"><button type="button" data-favourites aria-pressed="false">Favourites</button><button type="button" data-close>Close</button></header><div class="iptv-mini-status" role="status"></div><div class="iptv-mini-channels" aria-label="IPTV channels"></div><footer><button type="button" data-previous>Previous</button><span>Keep watching while you browse</span><button type="button" data-retry hidden>Retry</button><button type="button" data-next>Next</button></footer>`;
    const search = root.querySelector<HTMLInputElement>("input")!;
    const status = root.querySelector<HTMLElement>(".iptv-mini-status")!;
    const rows = root.querySelector<HTMLElement>(".iptv-mini-channels")!;
    const previous = root.querySelector<HTMLButtonElement>("[data-previous]")!;
    const next = root.querySelector<HTMLButtonElement>("[data-next]")!;
    const retry = root.querySelector<HTMLButtonElement>("[data-retry]")!;
    const favourites = root.querySelector<HTMLButtonElement>("[data-favourites]")!;
    let favouritesOnly = false;
    let page = 0;
    let cursors: Array<string | undefined> = [undefined];
    let nextCursor: string | null = null;
    async function load(restartStale = true): Promise<void> {
      if (!active || opened !== openGeneration) return;
      const request = ++generation;
      status.textContent = "Loading channels…";
      previous.disabled = next.disabled = true; retry.hidden = true; nextCursor = null;
      rows.setAttribute("aria-busy", "true");
      rows.replaceChildren();
      try {
        const result = await window.iptv.catalogue({ providerId: current.identity.providerId, contentType: "live", query: search.value.trim() || undefined, favouritesOnly, cursor: cursors[page], limit: 20 });
        if (!active || request !== generation) return;
        nextCursor = result.nextCursor;
        status.textContent = result.items.length ? `Page ${page + 1} · Select a channel to watch` : "No matching channels";
        previous.disabled = page === 0;
        next.disabled = !nextCursor;
        const scheduleTargets: Array<{ item: IptvCatalogueItem; text: HTMLElement }> = [];
        for (const item of result.items) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "iptv-mini-channel";
          button.dataset.channelId = item.identity.itemId;
          const playing = sameChannel(current.identity, item.identity);
          button.setAttribute("aria-current", String(playing));
          const name = document.createElement("strong");
          name.textContent = `${item.channelNumber ? `${item.channelNumber} · ` : ""}${item.name}${playing ? " · Watching" : ""}`;
          const text = document.createElement("span");
          text.textContent = "Loading programme…";
          button.append(name, text);
          button.addEventListener("click", () => { if (!playing) watch(item); });
          rows.append(button);
          scheduleTargets.push({ item, text });
        }
        // Bound concurrent guide requests; closing or searching cancels further work.
        let index = 0;
        const worker = async (): Promise<void> => {
          while (active && request === generation && index < scheduleTargets.length) {
            const { item, text } = scheduleTargets[index++];
            try {
              const schedule = await window.iptv.schedule({ providerId: item.identity.providerId, channelId: item.identity.itemId });
              if (!active || request !== generation) return;
              const now = Date.now();
              const programmes = [...schedule.programmes].sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));
              const present = programmes.find(p => Date.parse(p.startUtc) <= now && Date.parse(p.endUtc) > now);
              const upcoming = programmes.find(p => Date.parse(p.startUtc) > now);
              text.textContent = [present ? `Now: ${present.title}` : "Programme unavailable", upcoming ? `Next: ${upcoming.title}` : ""].filter(Boolean).join(" · ");
            } catch { if (active && request === generation) text.textContent = "Programme unavailable"; }
          }
        };
        void Promise.all([worker(), worker()]);
      } catch (error) {
        if (active && request === generation) {
          if ((error as { code?: string })?.code === "IPTV_SNAPSHOT_STALE" && restartStale) { page = 0; cursors = [undefined]; await load(false); return; }
          status.textContent = "Channels could not be loaded. Select Retry to try again."; previous.disabled = page === 0; retry.hidden = false;
        }
      } finally {
        if (active && request === generation) rows.setAttribute("aria-busy", "false");
      }
    }
    const reset = (): void => { page = 0; cursors = [undefined]; void load(); };
    search.addEventListener("input", () => {
      clearTimeout(timer); generation++; previous.disabled = next.disabled = true; retry.hidden = true;
      rows.replaceChildren(); status.textContent = "Searching channels…"; timer = setTimeout(reset, 250);
    });
    favourites.addEventListener("click", () => { clearTimeout(timer); favouritesOnly = !favouritesOnly; favourites.setAttribute("aria-pressed", String(favouritesOnly)); reset(); });
    previous.addEventListener("click", () => { if (page > 0) { page--; void load(); } });
    next.addEventListener("click", () => { if (nextCursor) { cursors[++page] = nextCursor; void load(); } });
    retry.addEventListener("click", () => { void load(); });
    root.querySelector("[data-close]")!.addEventListener("click", close);
    void load();
    search.focus({ preventScroll: true });
  }
  return {
    open,
    isOpen: () => active,
    close: () => { active = false; generation++; openGeneration++; clearTimeout(timer); delete root.dataset.mode; },
    handleKey: (event: KeyboardEvent): boolean => {
      if (!active) return false;
      if (event.key === "Escape") { event.preventDefault(); close(); return true; }
      if (!root.contains(event.target as Node)) return false;
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !event.altKey && !event.ctrlKey && !event.metaKey) {
        const buttons = [...root.querySelectorAll<HTMLButtonElement>(".iptv-mini-channel")];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const target = index < 0 ? event.key === "ArrowDown" ? 0 : buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[target]?.focus();
        event.preventDefault();
      }
      return true;
    },
  };
}
