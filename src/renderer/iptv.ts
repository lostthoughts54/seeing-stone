import { IPTV_CATALOGUE_PAGE_SIZES, IPTV_SEARCH_DEBOUNCE_MS, type IptvAccountTestStatus, type IptvCatalogueItem, type IptvGroup, type IptvSetup } from "../shared/iptv";
import "./iptv.css";
import { IptvChannelHistory, sameChannel } from "./iptvChannelHistory";
import { placeProgramInWindow, timeAxisLabels } from "./liveTvPresentation";
import { restoreVisibleFocus } from "./focus";

export function mountIptv(play: (item: IptvCatalogueItem) => Promise<void>, navigate: () => void) {
  const panel = document.createElement("section");
  panel.id = "iptvView";
  panel.className = "view iptv-screen is-hidden";
  let visible = false;
  let visibilityGeneration = 0;
  panel.setAttribute("aria-labelledby", "iptvHeading");
  panel.innerHTML = `
    <header class="iptv-header"><div><p class="eyebrow">Your providers</p><h1 id="iptvHeading">IPTV</h1><p data-role="summary" class="iptv-muted" role="status"></p></div><div class="iptv-provider-picker"><select data-role="provider-select" aria-label="IPTV provider"></select><button type="button" data-action="providers" aria-expanded="false">Manage providers</button></div></header>
    <div class="iptv-layout">
      <aside class="iptv-sidebar"><h2>Providers</h2><div data-role="providers"></div><button type="button" data-action="add">Add provider</button>
        <form data-role="setup" autocomplete="off">
          <h3>Connect your account</h3>
          <label>Provider type<select name="kind"><option value="xtream">Xtream account (including Trex)</option><option value="m3u">M3U playlist · live channels only</option></select></label>
          <label>Display name<input name="name" maxlength="120" placeholder="My IPTV" required></label>
          <label data-field="address">Provider address<input name="address" type="url" placeholder="https://provider.example:8080" required></label>
          <label data-field="username">Username<input name="username" autocomplete="off" required></label>
          <label data-field="password">Password<input name="password" type="password" autocomplete="new-password" required></label>
          <label data-field="playlistUrl" hidden>Playlist URL<input name="playlistUrl" type="url" placeholder="https://provider.example/list.m3u"></label>
          <p class="iptv-muted">Enter credentials here on your computer. Windows protects saved credentials. No Jellyfin login is required.</p>
          <button class="primary" type="submit">Save & test connection</button>
          <p data-role="setup-message" role="status"></p>
        </form>
        <div class="iptv-provider-heading"><div><h2 data-role="provider-name" hidden>Connect a provider to begin</h2><p data-role="status" role="status">Test your account and browse its available channels, movies and series.</p><p data-role="coverage" class="iptv-muted"></p></div><div class="iptv-actions"><button type="button" data-action="refresh" disabled>Test & refresh</button><button type="button" data-action="remove" disabled>Remove provider</button></div></div>
      </aside>
      <div class="iptv-main">
        <nav class="iptv-tabs" aria-label="IPTV catalogue"><button type="button" data-type="live" aria-pressed="true">Live TV</button><button type="button" data-type="movie" aria-pressed="false">Movies</button><button type="button" data-type="series" aria-pressed="false">Series</button></nav>
        <div class="iptv-filters"><label>Search catalogue<input type="search" data-role="search" placeholder="Channel name, number or title" maxlength="256"></label><label>Find categories<input type="search" data-role="category-search" placeholder="Type US, UK, sports…" maxlength="256"></label><label>Category<select data-role="group"><option value="">All categories</option></select></label></div>
        <div class="iptv-guide-controls" data-role="guide-controls"><button type="button" data-action="guide" aria-pressed="false">Programme guide</button><span data-role="guide-navigation" hidden><button type="button" data-action="earlier">Earlier</button><button type="button" data-action="now">Now</button><button type="button" data-action="later">Later</button></span><span data-role="guide-date" class="iptv-muted"></span></div>
        <section data-role="programme-details" class="iptv-programme-details" hidden aria-label="Programme details"></section>
        <div class="iptv-catalogue" data-role="catalogue" aria-label="IPTV catalogue"><p class="iptv-muted">Your catalogue will appear here after a successful connection.</p></div>
        <footer class="iptv-pagination"><label>Items per page<select data-role="page-size">${IPTV_CATALOGUE_PAGE_SIZES.map(size => `<option value="${size}">${size}</option>`).join("")}</select></label><button type="button" data-action="previous" disabled>Previous</button><span data-role="page-status" role="status"></span><button type="button" data-action="retry" hidden>Retry</button><button type="button" data-action="next" disabled>Next 50</button></footer>
      </div>
    </div>`;
  document.getElementById("contentScroller")!.append(panel);
  const element = <T extends HTMLElement>(selector: string) => panel.querySelector<T>(selector)!;
  const favouritesFilter = document.createElement("button");
  favouritesFilter.type = "button"; favouritesFilter.dataset.action = "favourites";
  favouritesFilter.textContent = "★ Favourites"; favouritesFilter.setAttribute("aria-pressed", "false");
  element<HTMLElement>("[data-role=guide-controls]").insertBefore(favouritesFilter, element<HTMLElement>("[data-role=guide-date]"));
  let favouritesOnly = false;
  const form = element<HTMLFormElement>("[data-role=setup]");
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
  const status = element<HTMLElement>("[data-role=status]");
  const coverage = element<HTMLElement>("[data-role=coverage]");
  const catalogue = element<HTMLElement>("[data-role=catalogue]");
  const search = element<HTMLInputElement>("[data-role=search]");
  const group = element<HTMLSelectElement>("[data-role=group]");
  const categorySearch = element<HTMLInputElement>("[data-role=category-search]");
  let categoryGroups: IptvGroup[] = [];
  const pageSize = element<HTMLSelectElement>("[data-role=page-size]");
  const previous = element<HTMLButtonElement>("[data-action=previous]");
  const next = element<HTMLButtonElement>("[data-action=next]");
  const retry = element<HTMLButtonElement>("[data-action=retry]");
  const refresh = element<HTMLButtonElement>("[data-action=refresh]");
  const remove = element<HTMLButtonElement>("[data-action=remove]");
  const setupMessage = element<HTMLElement>("[data-role=setup-message]");
  let selected = "";
  let type: "live" | "movie" | "series" = "live";
  let providers: IptvAccountTestStatus[] = [];
  let cursors: Array<string | undefined> = [undefined];
  let page = 0; let nextCursor: string | null = null; let request = 0; let groupRequest = 0;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let removeArmed = false;
  let lastSnapshot = "";
  let guideMode = false;
  let guideStart = Math.floor(Date.now() / 1800000) * 1800000;
  let pageItems: IptvCatalogueItem[] = [];
  let playingItem: IptvCatalogueItem | null = null;
  const history = new IptvChannelHistory();
  let guideGeneration = 0;
  let guideObserver: IntersectionObserver | null = null;
  let nowTimer: ReturnType<typeof setInterval> | undefined;
  const timeLabel = (value: string | number) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  function watch(item: IptvCatalogueItem): void { playingItem = item; setVisible(false); void play(item); }
  function favouriteButton(item: IptvCatalogueItem): HTMLButtonElement {
    const button = document.createElement("button"); button.type = "button"; button.className = "iptv-favourite";
    const render = () => {
      button.textContent = item.favourite ? "★" : "☆";
      button.setAttribute("aria-pressed", String(item.favourite));
      button.title = `${item.favourite ? "Remove from" : "Add to"} favourites: ${item.name}`;
      button.setAttribute("aria-label", button.title);
    };
    render();
    button.addEventListener("click", () => {
      const generation = guideGeneration;
      button.disabled = true;
      const favourite = !item.favourite;
      void window.iptv.favourite({ providerId: item.identity.providerId, channelId: item.identity.itemId, favourite }).then(() => {
        item.favourite = favourite;
        if (generation !== guideGeneration) return;
        render();
        resetPage(); catalogue.scrollTop = 0; void loadPage();
      }).catch(() => { if (generation === guideGeneration) element<HTMLElement>("[data-role=page-status]").textContent = "Could not save favourite. Please try again."; })
        .finally(() => { button.disabled = false; });
    });
    return button;
  }
  function programmeDetails(item: IptvCatalogueItem, programme: import("../shared/iptv").IptvChannelSchedule["programmes"][number], trigger: HTMLButtonElement): void {
    const details = element<HTMLElement>("[data-role=programme-details]"); details.replaceChildren(); details.hidden = false;
    const title = document.createElement("h3"); title.textContent = programme.title;
    const time = document.createElement("p"); time.textContent = `${item.name} · ${new Date(programme.startUtc).toLocaleString()} – ${timeLabel(programme.endUtc)}`;
    const description = document.createElement("p"); description.textContent = programme.description || "No description supplied.";
    const watchButton = document.createElement("button"); watchButton.type = "button"; watchButton.textContent = "Watch live"; watchButton.addEventListener("click", () => watch(item));
    const closeDetails = () => { details.hidden = true; restoreVisibleFocus(trigger, element<HTMLButtonElement>("[data-action=guide]")); };
    const close = document.createElement("button"); close.type = "button"; close.textContent = "Close details"; close.addEventListener("click", closeDetails);
    details.onkeydown = event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeDetails(); } };
    details.append(title, time, description, watchButton, close); close.focus();
  }
  function renderGuide(items: IptvCatalogueItem[]): void {
    const generation = guideGeneration;
    const end = guideStart + 3 * 3600000;
    element<HTMLElement>("[data-role=guide-date]").textContent = `${new Date(guideStart).toLocaleDateString()} · ${timeLabel(guideStart)}–${timeLabel(end)} · Local time`;
    const axis = document.createElement("div"); axis.className = "iptv-guide-axis";
    const label = document.createElement("span"); label.textContent = "Channel · Watch live"; axis.append(label);
    const times = document.createElement("div");
    for (const time of timeAxisLabels(guideStart, end)) { const tick = document.createElement("span"); tick.textContent = timeLabel(time); times.append(tick); }
    axis.append(times); catalogue.append(axis);
    const queue: Array<{ row: HTMLElement; item: IptvCatalogueItem }> = []; let active = 0;
    const drain = () => {
      while (active < 2 && queue.length && generation === guideGeneration && visible) {
        const entry = queue.shift()!; active++;
        const track = entry.row.querySelector<HTMLElement>(".iptv-guide-track")!;
        void window.iptv.schedule({ providerId: entry.item.identity.providerId, channelId: entry.item.identity.itemId }).then(schedule => {
          if (generation !== guideGeneration || !visible) return;
          track.replaceChildren();
          for (const programme of schedule.programmes) {
            const placement = placeProgramInWindow(programme, guideStart, end); if (!placement) continue;
            const cell = document.createElement("button"); cell.type = "button"; cell.className = "iptv-guide-programme";
            cell.style.left = `${placement.leftPercent}%`; cell.style.width = `${placement.widthPercent}%`;
            cell.textContent = `${timeLabel(programme.startUtc)} ${programme.title}`; cell.title = `${programme.title} · ${timeLabel(programme.startUtc)}–${timeLabel(programme.endUtc)}`;
            cell.addEventListener("click", () => programmeDetails(entry.item, programme, cell)); track.append(cell);
          }
          if (!track.children.length) track.textContent = "No schedule supplied for this time. Channel is still playable.";
          track.title = `${schedule.stale ? "Saved schedule · " : ""}Fetched ${new Date(schedule.fetchedAt).toLocaleString()}`;
        }).catch(() => { if (generation === guideGeneration) track.textContent = "Programme information unavailable. You can still watch live."; })
          .finally(() => { active--; drain(); });
      }
    };
    const pending = new Map<Element, IptvCatalogueItem>();
    guideObserver = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        const item = pending.get(entry.target); if (!item) continue;
        pending.delete(entry.target); guideObserver?.unobserve(entry.target); queue.push({ row: entry.target as HTMLElement, item });
      }
      drain();
    }, { root: catalogue, rootMargin: "120px" });
    for (const item of items) {
      const row = document.createElement("div"); row.className = "iptv-guide-row";
      const channel = document.createElement("button"); channel.type = "button"; channel.textContent = item.name; channel.title = `Watch ${item.name}`; channel.addEventListener("click", () => watch(item));
      const track = document.createElement("div"); track.className = "iptv-guide-track"; track.textContent = "Loading programme information…";
      const channelCell = document.createElement("div"); channelCell.className = "iptv-guide-channel";
      channelCell.append(channel, favouriteButton(item));
      row.append(channelCell, track); catalogue.append(row); pending.set(row, item); guideObserver.observe(row);
    }
  }
  const errorText = (error: unknown) => typeof error === "object" && error && "message" in error ? String(error.message) : "This request could not be completed. Please retry.";
  const setRemoveArmed = (armed: boolean) => { removeArmed = armed; remove.textContent = armed ? "Confirm removal" : "Remove provider"; };

  function resetPage(): void { page = 0; cursors = [undefined]; nextCursor = null; request++; previous.disabled = true; next.disabled = true; retry.hidden = true; catalogue.scrollTop = 0; }
  function resetFilters(): void { search.value = ""; categorySearch.value = ""; categoryGroups = []; group.replaceChildren(new Option("All categories", "")); resetPage(); setRemoveArmed(false); }
  function renderItems(items: IptvCatalogueItem[]): void {
    const expandedGuide = guideMode && type === "live";
    search.placeholder = expandedGuide ? "Channel or programme title (shown time range)" : "Channel name, number or title";
    if (expandedGuide) element<HTMLElement>("[data-role=guide-date]").textContent = `${new Date(guideStart).toLocaleDateString()} · ${timeLabel(guideStart)}–${timeLabel(guideStart + 3 * 3600000)} · Local time`;
    search.parentElement!.firstChild!.textContent = expandedGuide ? "Search channels and programmes" : "Search catalogue";
    panel.classList.toggle("is-guide-mode", expandedGuide);
    element<HTMLElement>("#iptvHeading").textContent = expandedGuide ? "Programme guide" : "IPTV";
    element<HTMLButtonElement>("[data-action=guide]").textContent = expandedGuide ? "Back to channels" : "Programme guide";
    pageItems = items; guideGeneration++; guideObserver?.disconnect();
    clearInterval(nowTimer);
    const nowRows: Array<{ row: HTMLElement; label: HTMLElement; item: IptvCatalogueItem }> = [];
    catalogue.replaceChildren();
    catalogue.classList.toggle("is-guide", guideMode && type === "live");
    catalogue.classList.toggle("is-poster-grid", type !== "live");
    element<HTMLElement>("[data-role=programme-details]").hidden = true;
    if (guideMode && type === "live" && items.length) { renderGuide(items); return; }
    if (!items.length) {
      const message = document.createElement("p"); message.className = "iptv-muted";
      message.textContent = !selected ? "Add a provider to start browsing channels, movies and series."
        : type === "live" && favouritesOnly ? "No favourites match these filters. Turn off Favourites to browse channels and use the star to save them."
        : search.value.trim() || group.value ? "No entries match your filters. Try another search or choose All categories."
        : "No entries are available yet. Check your provider connection or use Test & refresh.";
      catalogue.append(message);
    }
    if (type !== "live") { renderPosters(items); return; }
    for (const item of items) {
      const row = document.createElement("article"); row.className = "iptv-item";
      const icon = document.createElement("span"); icon.className = "iptv-item-icon"; icon.textContent = type === "live" ? "TV" : type === "movie" ? "FILM" : "SERIES";
      const text = document.createElement("div"); const title = document.createElement("h3"); title.textContent = item.name;
      const meta = document.createElement("p"); meta.textContent = [item.channelNumber, item.groupName].filter(Boolean).join(" · ") || "Uncategorised";
      text.append(title, meta); row.append(icon, text); catalogue.append(row);
      if (type === "live") {
        const watchButton = document.createElement("button"); watchButton.type = "button"; watchButton.className = "iptv-watch"; watchButton.textContent = "Watch live";
        watchButton.addEventListener("click", () => watch(item)); row.append(watchButton, favouriteButton(item));
        row.classList.add("is-playable"); row.addEventListener("click", (event) => { if (!(event.target as HTMLElement).closest("button")) watch(item); });
        const now = document.createElement("p"); now.className = "iptv-now-playing"; now.textContent = "Checking programme guide…"; text.append(now);
        nowRows.push({ row, label: now, item });
      }
    }
    if (nowRows.length) observeNowPlaying(nowRows);
  }
  function renderPosters(items: IptvCatalogueItem[]): void {
    const generation = guideGeneration;
    const pending = new Map<Element, { item: IptvCatalogueItem; image: HTMLImageElement; fallback: HTMLElement }>();
    const queue: Array<{ item: IptvCatalogueItem; image: HTMLImageElement; fallback: HTMLElement }> = [];
    let active = 0;
    const drain = () => {
      while (active < 4 && queue.length && generation === guideGeneration && visible) {
        const entry = queue.shift()!;
        const identity = entry.item.identity;
        if (identity.contentType !== "movie" && identity.contentType !== "series") continue;
        active++;
        void window.iptv.poster({ ...identity, contentType: identity.contentType }).then(value => {
          if (!value || generation !== guideGeneration || !visible) return;
          entry.image.onload = () => { entry.image.hidden = false; entry.fallback.hidden = true; };
          entry.image.onerror = () => { entry.image.hidden = true; entry.fallback.hidden = false; };
          entry.image.src = value;
        }).catch(() => undefined).finally(() => { active--; drain(); });
      }
    };
    guideObserver = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        const card = pending.get(entry.target); if (!card) continue;
        pending.delete(entry.target); guideObserver?.unobserve(entry.target); queue.push(card);
      }
      drain();
    }, { root: catalogue, rootMargin: "200px" });
    for (const item of items) {
      const card = document.createElement("article"); card.className = "iptv-item iptv-poster-card";
      const art = document.createElement("div"); art.className = "iptv-poster-art";
      const image = document.createElement("img"); image.alt = ""; image.decoding = "async"; image.hidden = true;
      const fallback = document.createElement("span"); fallback.className = "iptv-poster-fallback";
      fallback.textContent = item.name.split(/\s+/u).slice(0, 2).map(word => Array.from(word)[0] ?? "").join("").toLocaleUpperCase();
      fallback.setAttribute("aria-hidden", "true");
      art.append(fallback, image);
      const title = document.createElement("h3"); title.textContent = item.name; title.title = item.name;
      const meta = document.createElement("p"); meta.textContent = item.groupName || (type === "movie" ? "Movie" : "Series"); meta.title = meta.textContent;
      card.append(art, title, meta); catalogue.append(card);
      pending.set(card, { item, image, fallback }); guideObserver.observe(card);
    }
  }
  function observeNowPlaying(rows: Array<{ row: HTMLElement; label: HTMLElement; item: IptvCatalogueItem }>): void {
    const generation = guideGeneration;
    const pending = new Map(rows.map(entry => [entry.row, entry]));
    const queue: typeof rows = [];
    const loaded = new Map<HTMLElement, import("../shared/iptv").IptvChannelSchedule>();
    let active = 0;
    const show = (label: HTMLElement, schedule: import("../shared/iptv").IptvChannelSchedule) => {
      const now = Date.now();
      const programme = schedule.programmes.find(entry => Date.parse(entry.startUtc) <= now && Date.parse(entry.endUtc) > now);
      label.textContent = programme ? `${schedule.stale ? "Saved guide · " : ""}Now: ${programme.title} · until ${timeLabel(programme.endUtc)}` : "No current programme information";
      label.title = programme?.description ?? "You can still watch this channel without guide data.";
    };
    const drain = () => {
      while (active < 2 && queue.length && generation === guideGeneration && visible) {
        const entry = queue.shift()!; active++;
        void window.iptv.schedule({ providerId: entry.item.identity.providerId, channelId: entry.item.identity.itemId }).then(schedule => {
          if (generation !== guideGeneration || !visible) return;
          loaded.set(entry.label, schedule); show(entry.label, schedule);
        }).catch(() => { if (generation === guideGeneration) entry.label.textContent = "Programme information unavailable"; })
          .finally(() => { active--; drain(); });
      }
    };
    guideObserver = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        const row = pending.get(entry.target as HTMLElement); if (!row) continue;
        pending.delete(row.row); guideObserver?.unobserve(row.row); queue.push(row);
      }
      drain();
    }, { root: catalogue, rootMargin: "80px" });
    for (const entry of rows) guideObserver.observe(entry.row);
    nowTimer = setInterval(() => { if (generation === guideGeneration && visible) for (const [label, schedule] of loaded) show(label, schedule); }, 30000);
  }
  async function loadPage(restartStale = true): Promise<void> {
    if (!visible) return;
    const scrollTop = catalogue.scrollTop;
    const generation = ++request;
    previous.disabled = true; next.disabled = true; retry.hidden = true;
    if (!selected) { catalogue.setAttribute("aria-busy", "false"); element<HTMLElement>("[data-role=page-status]").textContent = ""; renderItems([]); return; }
    catalogue.setAttribute("aria-busy", "true");
    const programmeSearch = guideMode && type === "live" && Boolean(search.value.trim());
    const input = { providerId: selected, contentType: type, favouritesOnly: type === "live" && favouritesOnly, ...(search.value.trim() ? { query: search.value.trim() } : {}), ...(programmeSearch ? { programmeWindow: { startUtc: new Date(guideStart).toISOString(), endUtc: new Date(guideStart + 3 * 3600000).toISOString() } } : {}), ...(group.value ? { groupId: group.value } : {}), cursor: cursors[page], limit: Number(pageSize.value) };
    if (programmeSearch) { renderItems([]); catalogue.textContent = "Searching channel names and programme titles… The first search loads the provider’s full guide and may take a few minutes."; }
    element<HTMLElement>("[data-role=page-status]").textContent = "Loading…";
    try {
      const result = await window.iptv.catalogue(input);
      if (generation !== request || !visible) return;
      renderItems(result.items); catalogue.scrollTop = scrollTop; nextCursor = result.nextCursor;
      previous.disabled = page === 0; next.disabled = !nextCursor;
      element<HTMLElement>("[data-role=page-status]").textContent = result.items.length ? `Page ${page + 1} · ${result.items.length} entries` : "No entries";
    } catch (error) {
      if (generation !== request || !visible) return;
      if ((error as { code?: string })?.code === "IPTV_SNAPSHOT_STALE" && restartStale) { resetPage(); await loadPage(false); return; }
      element<HTMLElement>("[data-role=page-status]").textContent = errorText(error);
      renderItems([]); catalogue.textContent = "The catalogue could not be loaded. Select Retry to try again."; retry.hidden = false;
      previous.disabled = page === 0;
    } finally {
      if (generation === request) catalogue.setAttribute("aria-busy", "false");
    }
  }
  function filterGroups(current = group.value): void {
    const terms = categorySearch.value.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
    const matches = categoryGroups.filter(entry => {
      const words = entry.name.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u);
      return terms.every(term => words.some(word => word.startsWith(term)));
    });
    group.replaceChildren(new Option(terms.length ? `Choose category (${matches.length} matches)` : "All categories", ""));
    for (const entry of matches) group.add(new Option(`${entry.name} (${entry.count.toLocaleString()})`, entry.id));
    if (matches.some(entry => entry.id === current)) group.value = current;
    if (current !== group.value) { resetPage(); void loadPage(); }
  }
  async function loadGroups(): Promise<void> {
    if (!visible) return;
    const generation = ++groupRequest;
    const current = group.value;
    if (!selected) { categoryGroups = []; group.replaceChildren(new Option("All categories", "")); return; }
    group.disabled = true;
    try {
      const result = await window.iptv.groups({ providerId: selected, contentType: type });
      if (generation !== groupRequest || !visible) return;
      categoryGroups = result; filterGroups(current);
    } catch { /* The unfiltered catalogue remains available. */ }
    finally { if (generation === groupRequest) group.disabled = false; }
  }
  function renderProvider(): void {
    element<HTMLElement>("[data-role=guide-controls]").hidden = type !== "live";
    const current = providers.find((entry) => entry.provider.providerId === selected);
    if (!current) showProviders(true);
    element<HTMLSelectElement>("[data-role=provider-select]").value = selected;
    for (const button of panel.querySelectorAll<HTMLButtonElement>("[data-provider]")) button.setAttribute("aria-pressed", String(button.dataset.provider === selected));
    const busy = current?.phase === "connecting" || current?.phase === "importing";
    refresh.disabled = !current || busy; remove.disabled = !current;
    element<HTMLElement>("[data-role=provider-name]").textContent = current?.provider.name ?? "Connect a provider to begin";
    status.textContent = current ? `${current.message}${busy && current.imported ? ` ${current.imported.toLocaleString()} entries received.` : ""}` : "Test your account and browse its available channels, movies and series.";
    status.classList.toggle("is-error", current?.phase === "failed");
    element<HTMLElement>("[data-role=summary]").textContent = !current ? "Connect a provider to start watching."
      : busy || current.phase === "failed" ? current.message
      : `${current.counts.live.toLocaleString()} channels · ${current.counts.movie.toLocaleString()} movies · ${current.counts.series.toLocaleString()} series`;
    coverage.textContent = current?.lastSuccessfulAt
      ? `${current.counts.live.toLocaleString()} channels · ${current.counts.movie.toLocaleString()} movies · ${current.counts.series.toLocaleString()} series · Last success ${new Date(current.lastSuccessfulAt).toLocaleString()}` : "";
    for (const button of panel.querySelectorAll<HTMLButtonElement>("[data-type]")) {
      button.disabled = current?.provider.kind === "m3u" && button.dataset.type !== "live";
      button.setAttribute("aria-pressed", String(button.dataset.type === type));
    }
  }
  async function select(providerId: string): Promise<void> {
    selected = providerId; lastSnapshot = providers.find(entry => entry.provider.providerId === selected)?.lastSuccessfulAt ?? "";
    catalogue.replaceChildren();
    if (providers.find((entry) => entry.provider.providerId === selected)?.provider.kind === "m3u") type = "live";
    resetFilters(); renderProvider();
    form.hidden = providers.length > 0;
    await Promise.all([loadGroups(), loadPage()]);
  }
  async function updateProviders(): Promise<void> {
    const generation = visibilityGeneration;
    const result = await window.iptv.list();
    if (!visible || generation !== visibilityGeneration) return;
    providers = result;
    const list = element<HTMLElement>("[data-role=providers]");
    const key = JSON.stringify(providers.map((entry) => entry.provider));
    if (list.dataset.key !== key) {
      list.dataset.key = key; list.replaceChildren();
      const picker = element<HTMLSelectElement>("[data-role=provider-select]");
      picker.replaceChildren(...providers.map(entry => new Option(entry.provider.name, entry.provider.providerId)));
      picker.disabled = providers.length === 0;
      for (const entry of providers) {
        const button = document.createElement("button"); button.type = "button"; button.textContent = entry.provider.name; button.dataset.provider = entry.provider.providerId;
        button.addEventListener("click", () => { void select(entry.provider.providerId); }); list.append(button);
      }
    }
    if (!providers.some((entry) => entry.provider.providerId === selected)) {
      selected = "";
      if (providers.length) await select(providers[0].provider.providerId);
      else { form.hidden = false; resetFilters(); renderItems([]); element<HTMLElement>("[data-role=page-status]").textContent = ""; renderProvider(); }
    }
    if (!visible || generation !== visibilityGeneration) return;
    renderProvider();
    for (const button of list.querySelectorAll<HTMLButtonElement>("button")) button.setAttribute("aria-pressed", String(button.dataset.provider === selected));
    const snapshot = providers.find((entry) => entry.provider.providerId === selected)?.lastSuccessfulAt ?? "";
    if (snapshot && snapshot !== lastSnapshot) { lastSnapshot = snapshot; resetPage(); await Promise.all([loadGroups(), loadPage()]); }
  }
  async function tick(): Promise<void> {
    if (!visible) return;
    const generation = visibilityGeneration;
    try { await updateProviders(); } catch (error) { status.textContent = errorText(error); }
    if (visible && generation === visibilityGeneration) poll = setTimeout(() => { void tick(); }, 1500);
  }
  function open(): void { navigate(); }
  function setVisible(nextVisible: boolean): void {
    if (visible === nextVisible) return;
    visible = nextVisible; visibilityGeneration++;
    if (visible) {
      void tick();
      if (selected) { if (!categoryGroups.length) void loadGroups(); void loadPage(); }
      return;
    }
    clearInterval(nowTimer);
    guideGeneration++; guideObserver?.disconnect();
    clearTimeout(poll); clearTimeout(searchTimer); request++; groupRequest++;
    catalogue.setAttribute("aria-busy", "false"); group.disabled = false;
    for (const name of ["address", "username", "password", "playlistUrl"]) field(name).value = "";
    setRemoveArmed(false);
  }
  function showProviders(show: boolean): void {
    if (show && guideMode) {
      guideMode = false;
      element<HTMLButtonElement>("[data-action=guide]").setAttribute("aria-pressed", "false");
      element<HTMLElement>("[data-role=guide-navigation]").hidden = true;
      element<HTMLElement>("[data-role=guide-date]").textContent = "";
      resetPage(); renderItems(pageItems); void loadPage();
    }
    panel.classList.toggle("show-providers", show);
    element<HTMLButtonElement>("[data-action=providers]").setAttribute("aria-expanded", String(show));
  }
  element<HTMLButtonElement>("[data-action=providers]").addEventListener("click", () => showProviders(!panel.classList.contains("show-providers")));
  element<HTMLSelectElement>("[data-role=provider-select]").addEventListener("change", event => { void select((event.target as HTMLSelectElement).value); });
  element<HTMLButtonElement>("[data-action=add]").addEventListener("click", () => { showProviders(true); form.hidden = false; field("name").focus(); });
  field("kind").addEventListener("change", () => {
    const xtream = field("kind").value === "xtream";
    for (const name of ["address", "username", "password", "playlistUrl"]) {
      const enabled = name === "playlistUrl" ? !xtream : xtream;
      element<HTMLElement>(`[data-field=${name}]`).hidden = !enabled;
      field(name).required = enabled; field(name).disabled = !enabled; field(name).value = "";
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const input: IptvSetup = field("kind").value === "m3u"
      ? { kind: "m3u", name: field("name").value, playlistUrl: field("playlistUrl").value }
      : { kind: "xtream", name: field("name").value, address: field("address").value, username: field("username").value, password: field("password").value };
    const submit = form.querySelector<HTMLButtonElement>("[type=submit]")!;
    submit.disabled = true; setupMessage.textContent = "Protecting account and starting connection test…";
    const pending = window.iptv.setup(input);
    for (const name of ["address", "username", "password", "playlistUrl"]) field(name).value = "";
    void pending.then(async (provider) => { setupMessage.textContent = "Provider saved."; await updateProviders(); await select(provider.providerId); form.hidden = true; showProviders(false); })
      .catch((error) => { setupMessage.textContent = errorText(error); })
      .finally(() => { submit.disabled = false; });
  });
  refresh.addEventListener("click", () => {
    setRemoveArmed(false); refresh.disabled = true;
    void window.iptv.refresh({ providerId: selected }).then(updateProviders).catch((error) => { status.textContent = errorText(error); refresh.disabled = false; });
  });
  remove.addEventListener("click", () => {
    if (!removeArmed) { setRemoveArmed(true); return; }
    remove.disabled = true;
    void window.iptv.remove({ providerId: selected }).then(async () => { selected = ""; resetFilters(); await updateProviders(); })
      .catch((error) => { status.textContent = errorText(error); remove.disabled = false; });
  });
  for (const button of panel.querySelectorAll<HTMLButtonElement>("[data-type]")) button.addEventListener("click", () => {
    type = button.dataset.type as typeof type; resetFilters(); renderProvider(); void loadGroups(); void loadPage();
  });
  search.addEventListener("input", () => { resetPage(); clearTimeout(searchTimer); searchTimer = setTimeout(() => { void loadPage(); }, IPTV_SEARCH_DEBOUNCE_MS); });
  group.addEventListener("change", () => { resetPage(); void loadPage(); });
  categorySearch.addEventListener("input", () => filterGroups());
  favouritesFilter.addEventListener("click", () => {
    favouritesOnly = !favouritesOnly; favouritesFilter.setAttribute("aria-pressed", String(favouritesOnly));
    resetPage(); catalogue.scrollTop = 0; void loadPage();
  });
  element<HTMLButtonElement>("[data-action=guide]").addEventListener("click", (event) => {
    guideMode = !guideMode; (event.currentTarget as HTMLButtonElement).setAttribute("aria-pressed", String(guideMode));
    element<HTMLElement>("[data-role=guide-navigation]").hidden = !guideMode;
    if (!guideMode) element<HTMLElement>("[data-role=guide-date]").textContent = "";
    resetPage(); renderItems(pageItems); void loadPage();
  });
  for (const action of ["earlier", "now", "later"]) element<HTMLButtonElement>(`[data-action=${action}]`).addEventListener("click", () => {
    const now = Math.floor(Date.now() / 1800000) * 1800000;
    guideStart = action === "now" ? now : Math.max(now - 86400000, Math.min(now + 7 * 86400000, guideStart + (action === "earlier" ? -1 : 1) * 3 * 3600000));
    if (search.value.trim()) { resetPage(); void loadPage(); } else renderItems(pageItems);
  });
  pageSize.addEventListener("change", () => { resetPage(); catalogue.scrollTop = 0; next.textContent = `Next ${pageSize.value}`; void loadPage(); });
  previous.addEventListener("click", () => { if (page > 0) { page--; catalogue.scrollTop = 0; void loadPage(); } });
  next.addEventListener("click", () => { if (nextCursor) { cursors[++page] = nextCursor; catalogue.scrollTop = 0; void loadPage(); } });
  retry.addEventListener("click", () => { void loadPage(); });
  return {
    element: panel,
    watch,
    currentChannel: () => history.current || playingItem,
    previousChannel: () => history.previous,
    confirmPlaying: (identity: IptvCatalogueItem["identity"]) => {
      if (playingItem && sameChannel(playingItem.identity, identity)) history.record(playingItem);
    },
    lastChannel: () => { if (history.previous) watch(history.previous); },
    setVisible,
    open,
    openGuide: () => { guideMode = true; type = "live"; element<HTMLButtonElement>("[data-action=guide]").setAttribute("aria-pressed", "true"); element<HTMLElement>("[data-role=guide-navigation]").hidden = false; open(); renderProvider(); void loadPage(); },
    goLive: () => { if (playingItem) watch(playingItem); },
    changeChannel: (direction: number) => {
      const channels = pageItems.filter(item => item.identity.contentType === "live");
      const index = channels.findIndex(item => item.identity.itemId === playingItem?.identity.itemId);
      if (channels.length && index >= 0) watch(channels[(index + direction + channels.length) % channels.length]);
      else open();
    },
  };
}
