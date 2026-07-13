import type { DiscoveredServer, DownloadSummary, ImageKind, LibrarySummary, MediaItem, SafeSession } from "../shared/contracts";

const TICKS_PER_SECOND = 10000000;
type Route = "home" | "library" | "search" | "details";
type MediaRow = { title: string; items: MediaItem[]; shape: "poster" | "landscape" };
type ImageOptions = { width?: number; height?: number };

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required UI element: ${id}`);
  return element as T;
}

const loginView = byId<HTMLElement>("loginView");
const mainView = byId<HTMLElement>("mainView");
const loginForm = byId<HTMLFormElement>("loginForm");
const serverUrlInput = byId<HTMLInputElement>("serverUrlInput");
const discoverButton = byId<HTMLButtonElement>("discoverButton");
const discoveryDot = byId<HTMLElement>("discoveryDot");
const discoveryMessage = byId<HTMLElement>("discoveryMessage");
const serverResults = byId<HTMLElement>("serverResults");
const usernameInput = byId<HTMLInputElement>("usernameInput");
const passwordInput = byId<HTMLInputElement>("passwordInput");
const loginMessage = byId<HTMLElement>("loginMessage");

const brandHomeButton = byId<HTMLButtonElement>("brandHomeButton");
const navHomeButton = byId<HTMLButtonElement>("navHomeButton");
const navMoviesButton = byId<HTMLButtonElement>("navMoviesButton");
const navShowsButton = byId<HTMLButtonElement>("navShowsButton");
const searchInput = byId<HTMLInputElement>("searchInput");
const profileButton = byId<HTMLButtonElement>("profileButton");
const profileInitial = byId<HTMLElement>("profileInitial");
const profileMenu = byId<HTMLElement>("profileMenu");
const userLabel = byId<HTMLElement>("userLabel");
const serverLabel = byId<HTMLElement>("serverLabel");
const downloadsButton = byId<HTMLButtonElement>("downloadsButton");
const refreshButton = byId<HTMLButtonElement>("refreshButton");
const logoutButton = byId<HTMLButtonElement>("logoutButton");

const contentScroller = byId<HTMLElement>("contentScroller");
const homeView = byId<HTMLElement>("homeView");
const libraryView = byId<HTMLElement>("libraryView");
const searchView = byId<HTMLElement>("searchView");
const detailsView = byId<HTMLElement>("detailsView");

const featureHero = byId<HTMLElement>("featureHero");
const featureImage = byId<HTMLImageElement>("featureImage");
const featureEyebrow = byId<HTMLElement>("featureEyebrow");
const featureTitle = byId<HTMLElement>("featureTitle");
const featureOverview = byId<HTMLElement>("featureOverview");
const featurePlayButton = byId<HTMLButtonElement>("featurePlayButton");
const featureInfoButton = byId<HTMLButtonElement>("featureInfoButton");
const homeRows = byId<HTMLElement>("homeRows");

const libraryTitle = byId<HTMLElement>("libraryTitle");
const libraryMoviesButton = byId<HTMLButtonElement>("libraryMoviesButton");
const libraryShowsButton = byId<HTMLButtonElement>("libraryShowsButton");
const libraryGrid = byId<HTMLElement>("libraryGrid");
const searchTitle = byId<HTMLElement>("searchTitle");
const searchRows = byId<HTMLElement>("searchRows");

const detailsBackButton = byId<HTMLButtonElement>("detailsBackButton");
const detailHero = byId<HTMLElement>("detailHero");
const detailBackdrop = byId<HTMLImageElement>("detailBackdrop");
const detailPosterFrame = byId<HTMLElement>("detailPosterFrame");
const detailPoster = byId<HTMLImageElement>("detailPoster");
const detailPosterFallback = byId<HTMLElement>("detailPosterFallback");
const detailEyebrow = byId<HTMLElement>("detailEyebrow");
const detailTitle = byId<HTMLElement>("detailTitle");
const detailMeta = byId<HTMLElement>("detailMeta");
const detailOverview = byId<HTMLElement>("detailOverview");
const detailGenres = byId<HTMLElement>("detailGenres");
const detailPlayButton = byId<HTMLButtonElement>("detailPlayButton");
const detailPlayLabel = byId<HTMLElement>("detailPlayLabel");
const detailDownloadButton = byId<HTMLButtonElement>("detailDownloadButton");
const detailDownloadLabel = byId<HTMLElement>("detailDownloadLabel");
const detailTrailerButton = byId<HTMLButtonElement>("detailTrailerButton");
const episodeSection = byId<HTMLElement>("episodeSection");
const seasonSelect = byId<HTMLSelectElement>("seasonSelect");
const episodeList = byId<HTMLOListElement>("episodeList");

const mobileHomeButton = byId<HTMLButtonElement>("mobileHomeButton");
const mobileSearchButton = byId<HTMLButtonElement>("mobileSearchButton");
const mobileLibraryButton = byId<HTMLButtonElement>("mobileLibraryButton");
const playerView = byId<HTMLElement>("playerView");
const videoPlayer = byId<HTMLVideoElement>("videoPlayer");
const playerTitle = byId<HTMLElement>("playerTitle");
const playerMeta = byId<HTMLElement>("playerMeta");
const playerSourceBadge = byId<HTMLElement>("playerSourceBadge");
const closePlayerButton = byId<HTMLButtonElement>("closePlayerButton");
const downloadsScrim = byId<HTMLElement>("downloadsScrim");
const downloadsPanel = byId<HTMLElement>("downloadsPanel");
const closeDownloadsButton = byId<HTMLButtonElement>("closeDownloadsButton");
const downloadsList = byId<HTMLElement>("downloadsList");
const toast = byId<HTMLElement>("toast");

interface RendererState {
  session: SafeSession | null;
  discoveredServers: DiscoveredServer[];
  libraries: LibrarySummary[];
  homeRows: MediaRow[];
  resumeItems: MediaItem[];
  nextUpItems: MediaItem[];
  featureItem: MediaItem | null;
  currentRoute: Route;
  returnRoute: Route;
  returnScrollTop: number;
  searchReturnRoute: Route;
  searchReturnScrollTop: number;
  libraryType: "Movie" | "Series";
  libraryCache: { Movie: MediaItem[] | null; Series: MediaItem[] | null };
  detailItem: MediaItem | null;
  detailPlayItem: MediaItem | null;
  detailsRequestId: number;
  seasons: MediaItem[];
  episodes: MediaItem[];
  playbackItem: MediaItem | null;
  playbackId: string | null;
  playbackRequestId: number;
  downloads: DownloadSummary[];
  lastFocusElement: HTMLElement | null;
  searchTimer: ReturnType<typeof setTimeout> | null;
  searchRequestId: number;
  toastTimer: ReturnType<typeof setTimeout> | null;
}

const state: RendererState = {
  session: null,
  discoveredServers: [],
  libraries: [],
  homeRows: [],
  resumeItems: [],
  nextUpItems: [],
  featureItem: null,
  currentRoute: "home",
  returnRoute: "home",
  returnScrollTop: 0,
  searchReturnRoute: "home",
  searchReturnScrollTop: 0,
  libraryType: "Movie",
  libraryCache: { Movie: null, Series: null },
  detailItem: null,
  detailPlayItem: null,
  detailsRequestId: 0,
  seasons: [],
  episodes: [],
  playbackItem: null,
  playbackId: null,
  playbackRequestId: 0,
  downloads: [],
  lastFocusElement: null,
  searchTimer: null,
  searchRequestId: 0,
  toastTimer: null,
};

function normalizeServerUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function setDiscoveryMessage(message: string, status = "idle"): void {
  discoveryMessage.textContent = message;
  discoveryDot.className = "discovery-dot";
  if (status !== "idle") discoveryDot.classList.add(`is-${status}`);
}

function selectDiscoveredServer(server: DiscoveredServer): void {
  serverUrlInput.value = server.address;
  setDiscoveryMessage(`${server.name} is ready at ${server.address}`, "found");
  renderDiscoveredServers();
  usernameInput.focus();
}

function renderDiscoveredServers(): void {
  serverResults.innerHTML = "";
  const selectedAddress = normalizeServerUrl(serverUrlInput.value);
  for (const server of state.discoveredServers) {
    const button = document.createElement("button");
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    const address = document.createElement("small");
    const status = document.createElement("span");

    button.type = "button";
    button.className = normalizeServerUrl(server.address) === selectedAddress
      ? "server-choice is-active"
      : "server-choice";
    button.addEventListener("click", () => selectDiscoveredServer(server));
    name.textContent = server.name || "Jellyfin Server";
    address.textContent = server.address;
    status.textContent = "Select";
    copy.append(name, address);
    button.append(copy, status);
    serverResults.append(button);
  }
}

async function discoverServers(): Promise<void> {
  discoverButton.disabled = true;
  setDiscoveryMessage("Searching the local network for Jellyfin...", "searching");
  serverResults.innerHTML = "";
  try {
    state.discoveredServers = await window.jellyfin.server.discover();
    renderDiscoveredServers();
    if (state.discoveredServers.length === 1) {
      selectDiscoveredServer(state.discoveredServers[0]);
    } else if (state.discoveredServers.length > 1) {
      setDiscoveryMessage(`Found ${state.discoveredServers.length} Jellyfin servers. Choose one.`, "found");
    } else {
      setDiscoveryMessage("No Jellyfin server answered. Enter its address manually.", "error");
    }
  } catch {
    state.discoveredServers = [];
    setDiscoveryMessage("Network search is unavailable. Enter the server address manually.", "error");
  } finally {
    discoverButton.disabled = false;
  }
}

function hasImage(item: MediaItem | null | undefined, kind: ImageKind): boolean {
  if (!item) return false;
  if (kind === "Backdrop") return Boolean(item.backdropImageTag);
  return Boolean(item.imageTags?.[kind]);
}

async function imageUrl(item: MediaItem, kind: ImageKind = "Primary", options: ImageOptions = {}): Promise<string> {
  if (!state.session || !item?.id || !hasImage(item, kind)) return "";
  const tag = kind === "Backdrop" ? item.backdropImageTag : item.imageTags?.[kind];
  return window.jellyfin.artwork.getUrl({
    itemId: item.id,
    kind,
    tag: tag || undefined,
    width: options.width || (kind === "Backdrop" ? 1600 : 500),
    height: options.height,
  });
}

function preferredArtwork(item: MediaItem, shape: "poster" | "landscape"): ImageKind | "" {
  if (shape === "landscape") {
    if (hasImage(item, "Backdrop")) return "Backdrop";
    if (hasImage(item, "Thumb")) return "Thumb";
  }
  return hasImage(item, "Primary") ? "Primary" : "";
}

const imageRequestIds = new WeakMap<HTMLImageElement, number>();

function clearImage(image: HTMLImageElement, fallback: HTMLElement | null = null): void {
  imageRequestIds.set(image, (imageRequestIds.get(image) || 0) + 1);
  image.onload = null;
  image.onerror = null;
  image.removeAttribute("src");
  image.classList.remove("is-loading", "use-contain");
  image.classList.add("is-hidden");
  if (fallback) fallback.classList.remove("is-hidden");
}

async function setImage(
  image: HTMLImageElement,
  fallback: HTMLElement | null,
  item: MediaItem,
  kind: ImageKind | "",
  options: ImageOptions = {},
): Promise<void> {
  const requestId = (imageRequestIds.get(image) || 0) + 1;
  imageRequestIds.set(image, requestId);
  image.onload = null;
  image.onerror = null;
  image.removeAttribute("src");
  image.classList.remove("is-hidden");
  image.classList.add("is-loading");
  if (fallback) fallback.classList.remove("is-hidden");
  const url = kind ? await imageUrl(item, kind, options).catch(() => "") : "";
  if (imageRequestIds.get(image) !== requestId) return;
  if (!url) {
    image.classList.remove("is-loading");
    image.classList.add("is-hidden");
    return;
  }
  image.onload = () => {
    if (imageRequestIds.get(image) !== requestId) return;
    image.classList.remove("is-loading");
    if (fallback) fallback.classList.add("is-hidden");
  };
  image.onerror = () => {
    if (imageRequestIds.get(image) !== requestId) return;
    image.classList.remove("is-loading");
    image.classList.add("is-hidden");
    if (fallback) fallback.classList.remove("is-hidden");
  };
  image.src = url;
}

function initials(name = ""): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((word) => word[0].toUpperCase())
    .join("");
}

function itemYear(item: MediaItem | null | undefined): number | "" {
  return item?.productionYear || item?.premiereYear || "";
}

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string" && error.message) {
    return error.message;
  }
  return fallback;
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "";
}

function runtime(item: MediaItem | null | undefined): string {
  if (!item?.runTimeTicks) return "";
  const totalSeconds = Math.round(item.runTimeTicks / TICKS_PER_SECOND);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function episodeCode(item: MediaItem | null | undefined): string {
  const season = item?.parentIndexNumber;
  const episode = item?.indexNumber;
  if (season == null && episode == null) return "";
  return [season == null ? "" : `S${season}`, episode == null ? "" : `E${episode}`].filter(Boolean).join(" ");
}

function canPlay(item: MediaItem | null | undefined): boolean {
  return Boolean(item?.playable);
}

function itemCardTitle(item: MediaItem): string {
  return item?.type === "Episode" && item.seriesName ? item.seriesName : item?.name || "Untitled";
}

function itemCardSubtitle(item: MediaItem): string {
  if (item?.type === "Episode") {
    return [episodeCode(item), item.name].filter(Boolean).join(" - ");
  }
  return [itemYear(item), runtime(item)].filter(Boolean).join(" - ");
}

function metadataParts(item: MediaItem): string[] {
  const parts: string[] = [];
  if (item?.type === "Episode" && item.seriesName) parts.push(item.seriesName);
  if (episodeCode(item)) parts.push(episodeCode(item));
  if (itemYear(item)) parts.push(String(itemYear(item)));
  if (item.officialRating) parts.push(item.officialRating);
  if (runtime(item)) parts.push(runtime(item));
  if (item.communityRating) parts.push(`${item.communityRating.toFixed(1)}/10`);
  return parts;
}

function showLogin(message = ""): void {
  loginView.classList.remove("is-hidden");
  mainView.classList.add("is-hidden");
  playerView.classList.add("is-hidden");
  document.body.classList.remove("is-playing");
  loginMessage.textContent = message;
}

function showMain(): void {
  if (!state.session?.authenticated || !state.session.user || !state.session.server) return;
  loginView.classList.add("is-hidden");
  mainView.classList.remove("is-hidden");
  userLabel.textContent = state.session.user.name;
  serverLabel.textContent = `${state.session.server.name} - ${state.session.server.address}`;
  profileInitial.textContent = (state.session.user.name || "J")[0].toUpperCase();
}

function setLoginMessage(message: string, isError = false): void {
  loginMessage.textContent = message;
  loginMessage.classList.toggle("is-error", isError);
}

function setButtonActive(button: HTMLButtonElement, active: boolean): void {
  button.classList.toggle("is-active", active);
  button.setAttribute("aria-current", active ? "page" : "false");
}

function setRoute(route: Route, options: { preserveScroll?: boolean; scrollTop?: number } = {}): void {
  const views = { home: homeView, library: libraryView, search: searchView, details: detailsView };
  for (const [name, element] of Object.entries(views)) element.classList.toggle("is-hidden", name !== route);
  state.currentRoute = route;

  const desktopRoute = route === "details" ? state.returnRoute : route;
  setButtonActive(navHomeButton, desktopRoute === "home");
  setButtonActive(navMoviesButton, desktopRoute === "library" && state.libraryType === "Movie");
  setButtonActive(navShowsButton, desktopRoute === "library" && state.libraryType === "Series");
  setButtonActive(mobileHomeButton, desktopRoute === "home");
  setButtonActive(mobileSearchButton, desktopRoute === "search");
  setButtonActive(mobileLibraryButton, desktopRoute === "library");

  if (!options.preserveScroll) contentScroller.scrollTop = options.scrollTop || 0;
}

function showToast(message: string): void {
  if (state.toastTimer) clearTimeout(state.toastTimer);
  toast.textContent = message;
  toast.classList.remove("is-hidden");
  state.toastTimer = setTimeout(() => toast.classList.add("is-hidden"), 3400);
}

function renderMessage(container: HTMLElement, message: string): void {
  container.innerHTML = "";
  const element = document.createElement("p");
  element.className = "empty-state";
  element.textContent = message;
  container.append(element);
}

function renderLoadingRows(container: HTMLElement): void {
  container.innerHTML = "";
  for (let rowIndex = 0; rowIndex < 3; rowIndex += 1) {
    const section = document.createElement("section");
    const heading = document.createElement("div");
    const rail = document.createElement("div");
    section.className = "media-row skeleton-row";
    heading.className = "skeleton-heading";
    rail.className = rowIndex < 2 ? "skeleton-rail landscape" : "skeleton-rail poster";
    for (let cardIndex = 0; cardIndex < 7; cardIndex += 1) {
      const card = document.createElement("span");
      card.className = "skeleton-card";
      rail.append(card);
    }
    section.append(heading, rail);
    container.append(section);
  }
}

async function loadLibraries(): Promise<void> {
  state.libraries = await window.jellyfin.libraries.list();
}

async function loadHome(): Promise<void> {
  renderLoadingRows(homeRows);
  const payload = await window.jellyfin.home.get();
  state.libraries = payload.libraries;
  state.resumeItems = payload.resumeItems;
  state.nextUpItems = payload.nextUpItems;
  const rows: MediaRow[] = [];
  if (state.resumeItems.length) rows.push({ title: "Continue Watching", items: state.resumeItems, shape: "landscape" });
  if (state.nextUpItems.length) rows.push({ title: "Next Up", items: state.nextUpItems, shape: "landscape" });
  for (const result of payload.latestRows) {
    if (result.items.length) rows.push({ title: `Recently Added to ${result.library.name}`, items: result.items, shape: "poster" });
  }
  state.homeRows = rows;
  state.featureItem = state.resumeItems[0] || state.nextUpItems[0] || rows[0]?.items[0] || null;
  renderFeature(state.featureItem);
  renderMediaRows(homeRows, rows);
}

async function loadInitialData(): Promise<void> {
  showMain();
  renderLoadingRows(homeRows);
  try {
    await Promise.all([
      loadHome(),
      refreshDownloads().catch((error) => showToast(errorMessage(error, "Downloads could not be loaded."))),
    ]);
    setRoute("home");
  } catch (error) {
    if (errorCode(error) === "SESSION_EXPIRED") {
      await window.jellyfin.session.logout().catch(() => undefined);
      state.session = null;
      resetSignedInState();
      showLogin("Your Jellyfin session expired. Sign in again.");
      return;
    }
    homeRows.innerHTML = "";
    const message = document.createElement("p");
    message.className = "empty-state";
    message.textContent = "Jellyfin could not load the home screen.";
    homeRows.append(message);
    showToast(errorMessage(error, "Jellyfin could not load the home screen."));
  }
}

function renderFeature(item: MediaItem | null): void {
  state.featureItem = item;
  featurePlayButton.onclick = null;
  featureInfoButton.onclick = null;
  featurePlayButton.disabled = !canPlay(item);
  featureInfoButton.disabled = !item;

  if (!item) {
    featureEyebrow.textContent = "Your Jellyfin";
    featureTitle.textContent = "No titles available";
    featureOverview.textContent = "";
    featureImage.classList.add("is-hidden");
    featureHero.classList.add("has-no-art");
    return;
  }

  featureHero.classList.remove("has-no-art");
  featureEyebrow.textContent = item.type === "Episode"
    ? [item.seriesName, episodeCode(item)].filter(Boolean).join(" - ")
    : [item.type, itemYear(item)].filter(Boolean).join(" - ");
  featureTitle.textContent = item.type === "Episode" && item.seriesName ? item.seriesName : item.name;
  featureOverview.textContent = item.overview || (item.type === "Episode" ? item.name : "");
  const kind = hasImage(item, "Backdrop") ? "Backdrop" : hasImage(item, "Primary") ? "Primary" : "";
  featureImage.classList.toggle("use-contain", kind === "Primary" && Number(item.primaryImageAspectRatio || 0) < 1.15);
  setImage(featureImage, null, item, kind, { width: 1800 });
  featurePlayButton.onclick = canPlay(item) ? () => playItem(item) : null;
  featureInfoButton.onclick = () => openDetails(item);
}

function renderMediaRows(container: HTMLElement, rows: MediaRow[]): void {
  container.innerHTML = "";
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Nothing to show yet.";
    container.append(empty);
    return;
  }
  for (const row of rows) container.append(createMediaRow(row));
}

function createMediaRow(row: MediaRow): HTMLElement {
  const section = document.createElement("section");
  const heading = document.createElement("div");
  const title = document.createElement("h2");
  const railShell = document.createElement("div");
  const rail = document.createElement("div");
  const previous = document.createElement("button");
  const next = document.createElement("button");

  section.className = "media-row";
  heading.className = "row-heading";
  title.textContent = row.title;
  heading.append(title);

  railShell.className = "rail-shell";
  rail.className = `media-rail ${row.shape}`;
  rail.setAttribute("tabindex", "0");
  rail.setAttribute("aria-label", row.title);
  for (const item of row.items) rail.append(createMediaCard(item, row.shape));

  previous.className = "rail-arrow previous";
  previous.type = "button";
  previous.textContent = "<";
  previous.setAttribute("aria-label", `Scroll ${row.title} left`);
  previous.addEventListener("click", () => rail.scrollBy({ left: -rail.clientWidth * 0.82, behavior: "smooth" }));

  next.className = "rail-arrow next";
  next.type = "button";
  next.textContent = ">";
  next.setAttribute("aria-label", `Scroll ${row.title} right`);
  next.addEventListener("click", () => rail.scrollBy({ left: rail.clientWidth * 0.82, behavior: "smooth" }));

  railShell.append(previous, rail, next);
  section.append(heading, railShell);
  return section;
}

function createMediaCard(item: MediaItem, shape: "poster" | "landscape" = "poster"): HTMLElement {
  const button = document.createElement("button");
  const art = document.createElement("span");
  const image = document.createElement("img");
  const fallback = document.createElement("span");
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  const subtitle = document.createElement("small");
  const localBadge = document.createElement("span");

  button.type = "button";
  button.className = `media-card ${shape}`;
  button.dataset.mediaItem = item.id;
  button.title = itemCardTitle(item);
  button.addEventListener("click", () => openDetails(item));

  art.className = "media-art";
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  fallback.className = "art-fallback";
  fallback.textContent = initials(itemCardTitle(item));
  localBadge.className = `local-availability-badge${downloadForItem(item.id)?.state === "downloaded" ? "" : " is-hidden"}`;
  localBadge.textContent = "Local";
  art.append(image, fallback, localBadge);
  setImage(image, fallback, item, preferredArtwork(item, shape), {
    width: shape === "poster" ? 460 : 760,
    height: shape === "poster" ? 690 : 430,
  });

  const percentage = Number(item.userData?.playedPercentage || 0);
  if (percentage > 0 && percentage < 100) {
    const progress = document.createElement("progress");
    progress.className = "watch-progress";
    progress.max = 100;
    progress.value = Math.min(100, Math.max(1, percentage));
    progress.setAttribute("aria-label", `${Math.round(progress.value)} percent watched`);
    art.append(progress);
  }

  copy.className = "media-copy";
  title.textContent = itemCardTitle(item);
  subtitle.textContent = itemCardSubtitle(item);
  copy.append(title, subtitle);
  button.append(art, copy);
  return button;
}

function renderDetails(item: MediaItem): void {
  state.detailItem = item;
  state.detailPlayItem = canPlay(item) ? item : null;
  detailEyebrow.textContent = item.type === "Episode"
    ? [item.seriesName, episodeCode(item)].filter(Boolean).join(" - ")
    : item.type || "Jellyfin";
  detailTitle.textContent = item.name || "Untitled";
  detailOverview.textContent = item.overview || "No description is available.";

  detailMeta.innerHTML = "";
  for (const value of metadataParts(item)) {
    const span = document.createElement("span");
    span.textContent = value;
    detailMeta.append(span);
  }

  detailGenres.innerHTML = "";
  for (const genre of item.genres || []) {
    const span = document.createElement("span");
    span.textContent = genre;
    detailGenres.append(span);
  }

  const backdropKind = hasImage(item, "Backdrop") ? "Backdrop" : hasImage(item, "Primary") ? "Primary" : "";
  detailBackdrop.classList.toggle("use-contain", backdropKind === "Primary" && Number(item.primaryImageAspectRatio || 0) < 1.15);
  setImage(detailBackdrop, null, item, backdropKind, { width: 1800 });

  const posterSuitable = hasImage(item, "Primary") && Number(item.primaryImageAspectRatio || 0) < 1.15;
  detailHero.classList.toggle("has-no-poster", !posterSuitable);
  detailPosterFrame.classList.toggle("is-hidden", !posterSuitable);
  detailPosterFallback.textContent = initials(item.name);
  if (posterSuitable) setImage(detailPoster, detailPosterFallback, item, "Primary", { width: 520, height: 780 });

  const downloadable = item.type === "Movie" || item.type === "Episode";
  detailDownloadButton.disabled = !downloadable;
  detailDownloadButton.dataset.downloadItem = downloadable ? item.id : "";
  detailDownloadButton.onclick = downloadable ? () => startDownload(item) : null;
  detailTrailerButton.disabled = !item.hasTrailer;
  detailTrailerButton.onclick = item.hasTrailer
    ? () => window.jellyfin.items.openTrailer({ itemId: item.id }).catch((error) => showToast(errorMessage(error, "The trailer could not be opened.")))
    : null;
  updateDetailPlayButton();
  syncVisibleDownloadButtons();
}

function updateDetailPlayButton(): void {
  const item = state.detailPlayItem;
  detailPlayButton.disabled = !item;
  detailPlayButton.onclick = item ? () => playItem(item) : null;
  if (!item) {
    detailPlayLabel.textContent = state.detailItem?.type === "Series" ? "Loading" : "Play";
    return;
  }
  const hasProgress = Number(item.userData?.playbackPositionTicks || 0) > 0;
  detailPlayLabel.textContent = hasProgress ? "Resume" : "Play";
}

async function openDetails(item: MediaItem): Promise<void> {
  if (!item?.id) return;
  state.returnRoute = state.currentRoute === "details" ? "home" : state.currentRoute;
  state.returnScrollTop = contentScroller.scrollTop;
  state.detailsRequestId += 1;
  const requestId = state.detailsRequestId;
  state.seasons = [];
  state.episodes = [];
  episodeSection.classList.add("is-hidden");
  renderDetails(item);
  setRoute("details");
  try {
    const fullItem = await window.jellyfin.items.getDetails({ itemId: item.id });
    if (requestId !== state.detailsRequestId) return;
    renderDetails(fullItem);
    if (fullItem.type === "Series") await loadSeriesSeasons(fullItem, requestId);
  } catch (error) {
    showToast(errorMessage(error, "Details could not be loaded."));
  }
}

function returnFromDetails(): void {
  const route = state.returnRoute || "home";
  const scrollTop = state.returnScrollTop || 0;
  setRoute(route, { scrollTop });
  requestAnimationFrame(() => {
    contentScroller.scrollTop = scrollTop;
  });
}

async function loadSeriesSeasons(series: MediaItem, requestId: number): Promise<void> {
  episodeSection.classList.remove("is-hidden");
  seasonSelect.disabled = true;
  episodeList.innerHTML = '<li class="empty-state">Loading episodes...</li>';
  const result = await window.jellyfin.shows.getSeasons({ itemId: series.id });
  if (requestId !== state.detailsRequestId) return;
  state.seasons = result;
  seasonSelect.innerHTML = "";
  for (const season of state.seasons) {
    const option = document.createElement("option");
    option.value = season.id;
    option.textContent = season.name;
    seasonSelect.append(option);
  }
  seasonSelect.disabled = state.seasons.length === 0;
  if (!state.seasons.length) {
    episodeList.innerHTML = '<li class="empty-state">No episodes found.</li>';
    return;
  }
  const nextForSeries = state.nextUpItems.find((entry) => entry.seriesId === series.id);
  const preferredSeason = state.seasons.find((season) => season.id === nextForSeries?.seasonId) || state.seasons[0];
  seasonSelect.value = preferredSeason.id;
  await loadEpisodes(series.id, preferredSeason.id, requestId);
}

async function loadEpisodes(seriesId: string, seasonId: string, requestId = state.detailsRequestId): Promise<void> {
  episodeList.innerHTML = '<li class="empty-state">Loading episodes...</li>';
  const result = await window.jellyfin.shows.getEpisodes({ seriesId, seasonId });
  if (requestId !== state.detailsRequestId) return;
  state.episodes = result;
  const nextForSeries = state.nextUpItems.find((entry) => entry.seriesId === seriesId && entry.seasonId === seasonId);
  state.detailPlayItem = nextForSeries
    || state.episodes.find((episode) => !episode.userData?.played)
    || state.episodes[0]
    || null;
  updateDetailPlayButton();
  renderEpisodes();
}

function renderEpisodes(): void {
  episodeList.innerHTML = "";
  if (!state.episodes.length) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = "No episodes found.";
    episodeList.append(empty);
    return;
  }

  for (const episode of state.episodes) {
    const row = document.createElement("li");
    const thumb = document.createElement("span");
    const image = document.createElement("img");
    const fallback = document.createElement("span");
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    const overview = document.createElement("p");
    const actions = document.createElement("span");
    const play = document.createElement("button");
    const download = document.createElement("button");

    row.className = "episode-row";
    thumb.className = "episode-thumb";
    image.alt = "";
    image.loading = "lazy";
    fallback.className = "art-fallback";
    fallback.textContent = episode.indexNumber == null ? "E" : `E${episode.indexNumber}`;
    thumb.append(image, fallback);
    setImage(image, fallback, episode, preferredArtwork(episode, "landscape"), { width: 720, height: 405 });

    const percentage = Number(episode.userData?.playedPercentage || 0);
    if (percentage > 0 && percentage < 100) {
      const progress = document.createElement("progress");
      progress.className = "watch-progress";
      progress.max = 100;
      progress.value = Math.min(100, Math.max(1, percentage));
      progress.setAttribute("aria-label", `${Math.round(progress.value)} percent watched`);
      thumb.append(progress);
    }

    copy.className = "episode-copy";
    title.textContent = episode.name || `Episode ${episode.indexNumber || ""}`;
    meta.textContent = [episodeCode(episode), runtime(episode)].filter(Boolean).join(" - ");
    overview.textContent = episode.overview || "";
    copy.append(title, meta, overview);

    actions.className = "episode-actions";
    play.type = "button";
    play.className = "primary";
    play.textContent = episode.userData?.playbackPositionTicks ? "Resume" : "Play";
    play.addEventListener("click", () => playItem(episode));
    download.type = "button";
    download.dataset.downloadItem = episode.id;
    download.textContent = "Download";
    download.addEventListener("click", () => startDownload(episode));
    actions.append(play, download);

    row.append(thumb, copy, actions);
    episodeList.append(row);
  }
  syncVisibleDownloadButtons();
}

async function openLibraryCategory(type: "Movie" | "Series"): Promise<void> {
  state.libraryType = type;
  libraryTitle.textContent = type === "Movie" ? "Movies" : "Shows";
  setButtonActive(libraryMoviesButton, type === "Movie");
  setButtonActive(libraryShowsButton, type === "Series");
  setRoute("library");

  if (state.libraryCache[type]) {
    renderLibraryGrid(state.libraryCache[type]);
    return;
  }
  libraryGrid.innerHTML = "";
  for (let index = 0; index < 18; index += 1) {
    const skeleton = document.createElement("span");
    skeleton.className = "library-skeleton";
    libraryGrid.append(skeleton);
  }
  try {
    state.libraryCache[type] = await window.jellyfin.libraries.getItems({ type, limit: 500 });
    if (state.currentRoute === "library" && state.libraryType === type) renderLibraryGrid(state.libraryCache[type]);
  } catch (error) {
    renderMessage(libraryGrid, errorMessage(error, "The library could not be loaded."));
  }
}

function renderLibraryGrid(items: MediaItem[]): void {
  libraryGrid.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No titles found.";
    libraryGrid.append(empty);
    return;
  }
  for (const item of items) libraryGrid.append(createMediaCard(item, "poster"));
}

async function runSearch(query: string): Promise<void> {
  const trimmed = query.trim();
  state.searchRequestId += 1;
  const requestId = state.searchRequestId;
  if (!trimmed) {
    searchRows.innerHTML = "";
    searchTitle.textContent = "Search";
    if (state.currentRoute === "search") {
      setRoute(state.searchReturnRoute || "home", { scrollTop: state.searchReturnScrollTop || 0 });
    }
    return;
  }

  if (state.currentRoute !== "search") {
    state.searchReturnRoute = state.currentRoute === "details" ? "home" : state.currentRoute;
    state.searchReturnScrollTop = contentScroller.scrollTop;
  }
  searchTitle.textContent = `Results for "${trimmed}"`;
  setRoute("search");
  renderLoadingRows(searchRows);

  try {
    const items = await window.jellyfin.search.query({ query: trimmed });
    if (requestId !== state.searchRequestId) return;
    const allRows: MediaRow[] = [
      { title: "Movies", items: items.filter((item) => item.type === "Movie"), shape: "poster" },
      { title: "Shows", items: items.filter((item) => item.type === "Series"), shape: "poster" },
      { title: "Episodes", items: items.filter((item) => item.type === "Episode"), shape: "landscape" },
    ];
    const rows = allRows.filter((row) => row.items.length);
    renderMediaRows(searchRows, rows);
  } catch (error) {
    if (requestId !== state.searchRequestId) return;
    renderMessage(searchRows, errorMessage(error, "Search could not be completed."));
  }
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / (1024 ** index);
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function downloadForItem(itemId: string): DownloadSummary | undefined {
  return state.downloads.find((download) => download.itemId === itemId && download.state !== "missing");
}

function downloadButtonLabel(download: DownloadSummary | undefined): string {
  if (!download) return "Download";
  if (download.state === "downloading") return download.progressPercent === null ? "Downloading" : `${download.progressPercent}%`;
  return {
    queued: "Queued",
    paused: "Paused",
    downloaded: "Downloaded",
    failed: "Failed",
    missing: "Download",
  }[download.state];
}

function syncVisibleDownloadButtons(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-download-item]")) {
    const itemId = button.dataset.downloadItem || "";
    const label = downloadButtonLabel(downloadForItem(itemId));
    if (button === detailDownloadButton) detailDownloadLabel.textContent = label;
    else button.textContent = label;
  }
  for (const card of document.querySelectorAll<HTMLElement>("[data-media-item]")) {
    const downloaded = downloadForItem(card.dataset.mediaItem || "")?.state === "downloaded";
    card.querySelector(".local-availability-badge")?.classList.toggle("is-hidden", !downloaded);
  }
}

function openDownloads(): void {
  profileMenu.classList.add("is-hidden");
  profileButton.setAttribute("aria-expanded", "false");
  downloadsScrim.classList.remove("is-hidden");
  downloadsPanel.classList.remove("is-hidden");
  closeDownloadsButton.focus();
}

function closeDownloads(): void {
  downloadsScrim.classList.add("is-hidden");
  downloadsPanel.classList.add("is-hidden");
}

async function refreshDownloads(): Promise<void> {
  state.downloads = await window.jellyfin.downloads.list();
  renderDownloads();
  syncVisibleDownloadButtons();
}

async function startDownload(item: MediaItem): Promise<void> {
  const existing = downloadForItem(item.id);
  if (existing) {
    openDownloads();
    return;
  }
  try {
    const download = await window.jellyfin.downloads.start({ itemId: item.id });
    state.downloads = [download, ...state.downloads.filter((entry) => entry.downloadId !== download.downloadId)];
    renderDownloads();
    syncVisibleDownloadButtons();
    openDownloads();
  } catch (error) {
    showToast(errorMessage(error, "The download could not be started."));
  }
}

async function performDownloadAction(download: DownloadSummary, action: "pause" | "resume" | "retry" | "cancel" | "delete"): Promise<void> {
  try {
    if (action === "pause") await window.jellyfin.downloads.pause({ downloadId: download.downloadId });
    else if (action === "resume") await window.jellyfin.downloads.resume({ downloadId: download.downloadId });
    else if (action === "retry") await window.jellyfin.downloads.retry({ downloadId: download.downloadId });
    else if (action === "cancel") await window.jellyfin.downloads.cancel({ downloadId: download.downloadId });
    else await window.jellyfin.downloads.delete({ downloadId: download.downloadId });
    await refreshDownloads();
  } catch (error) {
    showToast(errorMessage(error, `The download could not ${action}.`));
  }
}

function renderDownloads(): void {
  downloadsList.replaceChildren();
  if (!state.downloads.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No downloads yet. Choose Download on a movie or episode.";
    downloadsList.append(empty);
    return;
  }
  for (const download of state.downloads) {
    const card = document.createElement("article");
    const heading = document.createElement("div");
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    const type = document.createElement("span");
    const status = document.createElement("span");
    const size = document.createElement("span");
    const controls = document.createElement("div");
    card.className = "download-card";
    heading.className = "download-card-heading";
    title.textContent = download.name;
    type.textContent = download.itemType;
    status.className = "download-status";
    status.textContent = download.state;
    copy.append(title, type);
    heading.append(copy, status);
    card.append(heading);

    if (download.expectedSize !== null) {
      const progress = document.createElement("progress");
      progress.className = "download-progress";
      progress.max = download.expectedSize;
      progress.value = Math.min(download.expectedSize, download.bytesDownloaded);
      progress.setAttribute("aria-label", `${download.progressPercent ?? 0} percent downloaded`);
      card.append(progress);
    }
    size.className = "download-size";
    size.textContent = download.expectedSize === null
      ? formatBytes(download.bytesDownloaded)
      : `${formatBytes(download.bytesDownloaded)} of ${formatBytes(download.expectedSize)}`;
    card.append(size);
    if (download.error) {
      const error = document.createElement("p");
      error.className = "download-error";
      error.textContent = download.error.message;
      card.append(error);
    }

    controls.className = "download-controls";
    const action = (label: string, kind: "pause" | "resume" | "retry" | "cancel" | "delete"): void => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => { void performDownloadAction(download, kind); });
      controls.append(button);
    };
    if (download.canPause) action("Pause", "pause");
    if (download.canResume) action("Resume", "resume");
    if (download.canRetry) action("Retry", "retry");
    if (download.canCancel) action("Cancel", "cancel");
    if (download.canDelete) action("Delete copy", "delete");

    const keep = document.createElement("label");
    const checkbox = document.createElement("input");
    keep.className = "download-keep";
    checkbox.type = "checkbox";
    checkbox.checked = download.keepDownloaded;
    checkbox.addEventListener("change", async () => {
      checkbox.disabled = true;
      try {
        await window.jellyfin.downloads.setKeep({ downloadId: download.downloadId, keepDownloaded: checkbox.checked });
        await refreshDownloads();
      } catch (error) {
        checkbox.checked = !checkbox.checked;
        checkbox.disabled = false;
        showToast(errorMessage(error, "Keep Downloaded could not be changed."));
      }
    });
    keep.append(checkbox, document.createTextNode("Keep downloaded"));
    controls.append(keep);
    card.append(controls);
    downloadsList.append(card);
  }
}

async function playItem(item: MediaItem): Promise<void> {
  if (!canPlay(item)) return;
  const requestId = ++state.playbackRequestId;
  state.lastFocusElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.playbackItem = item;
  playerTitle.textContent = item.type === "Episode" && item.seriesName ? item.seriesName : item.name || "Now Playing";
  playerMeta.textContent = item.type === "Episode"
    ? [episodeCode(item), item.name].filter(Boolean).join(" - ")
    : metadataParts(item).join(" - ");

  let resolved;
  try {
    resolved = await window.jellyfin.playback.start({
      itemId: item.id,
      resumeMode: item.userData.playbackPositionTicks > 0 ? "resume" : "start-over",
    });
  } catch (error) {
    if (requestId !== state.playbackRequestId) return;
    await closePlayer();
    showToast(errorMessage(error, "Playback could not be started."));
    return;
  }
  if (requestId !== state.playbackRequestId) {
    await window.jellyfin.playback.stop({ playbackId: resolved.playbackId }).catch(() => undefined);
    return;
  }
  state.playbackId = resolved.playbackId;
  playerSourceBadge.textContent = resolved.source === "local" ? "Local" : "Jellyfin";
}

async function closePlayer(): Promise<void> {
  state.playbackRequestId += 1;
  const playbackId = state.playbackId;
  playerView.classList.add("is-hidden");
  document.body.classList.remove("is-playing");
  state.playbackItem = null;
  state.playbackId = null;
  state.downloads = [];
  state.lastFocusElement?.focus?.();
  if (playbackId) await window.jellyfin.playback.stop({ playbackId }).catch(() => undefined);
}

window.jellyfin.playback.subscribe((playback) => {
  if (playback.playbackId || !state.playbackId) return;
  state.playbackId = null;
  state.playbackItem = null;
  state.lastFocusElement?.focus?.();
});

function resetSignedInState(): void {
  if (state.searchTimer) clearTimeout(state.searchTimer);
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.searchTimer = null;
  state.toastTimer = null;
  state.detailsRequestId += 1;
  state.searchRequestId += 1;
  state.playbackRequestId += 1;
  state.libraries = [];
  state.homeRows = [];
  state.resumeItems = [];
  state.nextUpItems = [];
  state.featureItem = null;
  state.currentRoute = "home";
  state.returnRoute = "home";
  state.returnScrollTop = 0;
  state.searchReturnRoute = "home";
  state.searchReturnScrollTop = 0;
  state.libraryType = "Movie";
  state.libraryCache = { Movie: null, Series: null };
  state.detailItem = null;
  state.detailPlayItem = null;
  state.seasons = [];
  state.episodes = [];
  state.playbackItem = null;
  state.playbackId = null;
  state.lastFocusElement = null;

  clearImage(featureImage);
  clearImage(detailBackdrop);
  clearImage(detailPoster, detailPosterFallback);
  renderFeature(null);
  homeRows.replaceChildren();
  libraryGrid.replaceChildren();
  searchRows.replaceChildren();
  episodeList.replaceChildren();
  seasonSelect.replaceChildren();
  seasonSelect.disabled = true;
  episodeSection.classList.add("is-hidden");

  libraryTitle.textContent = "Movies";
  searchTitle.textContent = "Search";
  detailEyebrow.textContent = "";
  detailTitle.textContent = "";
  detailMeta.replaceChildren();
  detailOverview.textContent = "";
  detailGenres.replaceChildren();
  detailHero.classList.add("has-no-poster");
  detailPosterFrame.classList.add("is-hidden");
  detailPosterFallback.textContent = "";
  detailPlayButton.disabled = true;
  detailPlayButton.onclick = null;
  detailPlayLabel.textContent = "Play";
  detailDownloadButton.disabled = true;
  detailDownloadButton.dataset.downloadItem = "";
  detailDownloadButton.onclick = null;
  detailDownloadLabel.textContent = "Download";
  detailTrailerButton.disabled = true;
  detailTrailerButton.onclick = null;

  videoPlayer.pause();
  videoPlayer.onloadedmetadata = null;
  videoPlayer.removeAttribute("src");
  videoPlayer.load();
  playerView.classList.add("is-hidden");
  document.body.classList.remove("is-playing");
  playerTitle.textContent = "";
  playerMeta.textContent = "";
  playerSourceBadge.textContent = "";

  searchInput.value = "";
  userLabel.textContent = "";
  serverLabel.textContent = "";
  profileInitial.textContent = "J";
  profileMenu.classList.add("is-hidden");
  profileButton.setAttribute("aria-expanded", "false");
  toast.textContent = "";
  toast.classList.add("is-hidden");
  downloadsList.replaceChildren();
  closeDownloads();
  setButtonActive(libraryMoviesButton, true);
  setButtonActive(libraryShowsButton, false);
  setRoute("home");
  contentScroller.scrollTop = 0;
}

async function bootstrap(): Promise<void> {
  try {
    state.session = await window.jellyfin.session.restore();
    if (state.session.server) serverUrlInput.value = state.session.server.address;
    if (state.session.authenticated) {
      await loadInitialData();
      return;
    }
  } catch {
    state.session = null;
  }
  showLogin();
  try {
    await discoverServers();
  } catch { /* The login view retains manual server entry. */ }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setLoginMessage("Signing in...");
  const serverUrl = normalizeServerUrl(serverUrlInput.value);
  try {
    const connection = await window.jellyfin.server.connect({ url: serverUrl });
    state.session = await window.jellyfin.session.login({
      connectionId: connection.connectionId,
      username: usernameInput.value.trim(),
      password: passwordInput.value,
      remember: true,
    });
    passwordInput.value = "";
    setLoginMessage("");
    resetSignedInState();
    await loadInitialData();
  } catch (error) {
    setLoginMessage(errorMessage(error, "Could not sign in. Check the server URL and credentials."), true);
  }
});

discoverButton.addEventListener("click", discoverServers);
serverUrlInput.addEventListener("input", renderDiscoveredServers);

brandHomeButton.addEventListener("click", () => setRoute("home"));
navHomeButton.addEventListener("click", () => setRoute("home"));
navMoviesButton.addEventListener("click", () => openLibraryCategory("Movie"));
navShowsButton.addEventListener("click", () => openLibraryCategory("Series"));
libraryMoviesButton.addEventListener("click", () => openLibraryCategory("Movie"));
libraryShowsButton.addEventListener("click", () => openLibraryCategory("Series"));
detailsBackButton.addEventListener("click", returnFromDetails);
seasonSelect.addEventListener("change", () => {
  if (state.detailItem?.type === "Series") loadEpisodes(state.detailItem.id, seasonSelect.value);
});

mobileHomeButton.addEventListener("click", () => setRoute("home"));
mobileSearchButton.addEventListener("click", () => {
  if (state.currentRoute !== "search") {
    state.searchReturnRoute = state.currentRoute === "details" ? "home" : state.currentRoute;
    state.searchReturnScrollTop = contentScroller.scrollTop;
    searchTitle.textContent = "Search";
    searchRows.innerHTML = "";
    setRoute("search");
  }
  searchInput.focus();
});
mobileLibraryButton.addEventListener("click", () => openLibraryCategory(state.libraryType || "Movie"));

searchInput.addEventListener("input", () => {
  if (state.searchTimer) clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => runSearch(searchInput.value), 280);
});

profileButton.addEventListener("click", (event) => {
  event.stopPropagation();
  const willOpen = profileMenu.classList.contains("is-hidden");
  profileMenu.classList.toggle("is-hidden", !willOpen);
  profileButton.setAttribute("aria-expanded", String(willOpen));
});

profileMenu.addEventListener("click", (event) => event.stopPropagation());
document.addEventListener("click", () => {
  profileMenu.classList.add("is-hidden");
  profileButton.setAttribute("aria-expanded", "false");
});

refreshButton.addEventListener("click", async () => {
  profileMenu.classList.add("is-hidden");
  state.libraryCache = { Movie: null, Series: null };
  await loadInitialData();
});

downloadsButton.addEventListener("click", () => openDownloads());
closeDownloadsButton.addEventListener("click", closeDownloads);
downloadsScrim.addEventListener("click", closeDownloads);

logoutButton.addEventListener("click", async () => {
  await closePlayer();
  try {
    await window.jellyfin.session.logout();
  } catch (error) {
    showToast(errorMessage(error, "Sign out could not be completed."));
    return;
  }
  state.session = null;
  resetSignedInState();
  showLogin("Signed out.");
  await discoverServers();
});

closePlayerButton.addEventListener("click", () => { void closePlayer(); });

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!playerView.classList.contains("is-hidden")) {
    void closePlayer();
  } else if (!profileMenu.classList.contains("is-hidden")) {
    profileMenu.classList.add("is-hidden");
    profileButton.setAttribute("aria-expanded", "false");
  } else if (!downloadsPanel.classList.contains("is-hidden")) {
    closeDownloads();
  } else if (state.currentRoute === "details") {
    returnFromDetails();
  }
});

window.jellyfin.downloads.subscribe((downloads) => {
  state.downloads = downloads;
  renderDownloads();
  syncVisibleDownloadButtons();
});

void bootstrap();
