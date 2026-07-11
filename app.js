const APP_NAME = "LocalFirst Jellyfin";
const APP_VERSION = "0.3.0";
const SESSION_KEY = "localfirst-jellyfin-session";
const DEVICE_KEY = "localfirst-jellyfin-device-id";
const PLAYBACK_THROTTLE_MS = 8000;
const TICKS_PER_SECOND = 10000000;
const ITEM_FIELDS = [
  "PrimaryImageAspectRatio",
  "Overview",
  "RunTimeTicks",
  "Genres",
  "ProductionYear",
  "MediaSources",
  "ImageTags",
  "BackdropImageTags",
  "UserData",
  "RemoteTrailers",
  "OfficialRating",
  "CommunityRating",
  "SeriesName",
  "SeriesId",
  "SeasonId",
  "IndexNumber",
  "ParentIndexNumber",
  "PremiereDate",
].join(",");

const loginView = document.getElementById("loginView");
const mainView = document.getElementById("mainView");
const loginForm = document.getElementById("loginForm");
const serverUrlInput = document.getElementById("serverUrlInput");
const discoverButton = document.getElementById("discoverButton");
const discoveryDot = document.getElementById("discoveryDot");
const discoveryMessage = document.getElementById("discoveryMessage");
const serverResults = document.getElementById("serverResults");
const usernameInput = document.getElementById("usernameInput");
const passwordInput = document.getElementById("passwordInput");
const loginMessage = document.getElementById("loginMessage");

const brandHomeButton = document.getElementById("brandHomeButton");
const navHomeButton = document.getElementById("navHomeButton");
const navMoviesButton = document.getElementById("navMoviesButton");
const navShowsButton = document.getElementById("navShowsButton");
const searchInput = document.getElementById("searchInput");
const profileButton = document.getElementById("profileButton");
const profileInitial = document.getElementById("profileInitial");
const profileMenu = document.getElementById("profileMenu");
const userLabel = document.getElementById("userLabel");
const serverLabel = document.getElementById("serverLabel");
const refreshButton = document.getElementById("refreshButton");
const logoutButton = document.getElementById("logoutButton");

const contentScroller = document.getElementById("contentScroller");
const homeView = document.getElementById("homeView");
const libraryView = document.getElementById("libraryView");
const searchView = document.getElementById("searchView");
const detailsView = document.getElementById("detailsView");

const featureHero = document.getElementById("featureHero");
const featureImage = document.getElementById("featureImage");
const featureEyebrow = document.getElementById("featureEyebrow");
const featureTitle = document.getElementById("featureTitle");
const featureOverview = document.getElementById("featureOverview");
const featurePlayButton = document.getElementById("featurePlayButton");
const featureInfoButton = document.getElementById("featureInfoButton");
const homeRows = document.getElementById("homeRows");

const libraryTitle = document.getElementById("libraryTitle");
const libraryMoviesButton = document.getElementById("libraryMoviesButton");
const libraryShowsButton = document.getElementById("libraryShowsButton");
const libraryGrid = document.getElementById("libraryGrid");

const searchTitle = document.getElementById("searchTitle");
const searchRows = document.getElementById("searchRows");

const detailsBackButton = document.getElementById("detailsBackButton");
const detailHero = document.getElementById("detailHero");
const detailBackdrop = document.getElementById("detailBackdrop");
const detailPosterFrame = document.getElementById("detailPosterFrame");
const detailPoster = document.getElementById("detailPoster");
const detailPosterFallback = document.getElementById("detailPosterFallback");
const detailEyebrow = document.getElementById("detailEyebrow");
const detailTitle = document.getElementById("detailTitle");
const detailMeta = document.getElementById("detailMeta");
const detailOverview = document.getElementById("detailOverview");
const detailGenres = document.getElementById("detailGenres");
const detailPlayButton = document.getElementById("detailPlayButton");
const detailPlayLabel = document.getElementById("detailPlayLabel");
const detailDownloadButton = document.getElementById("detailDownloadButton");
const detailTrailerButton = document.getElementById("detailTrailerButton");
const episodeSection = document.getElementById("episodeSection");
const seasonSelect = document.getElementById("seasonSelect");
const episodeList = document.getElementById("episodeList");

const mobileHomeButton = document.getElementById("mobileHomeButton");
const mobileSearchButton = document.getElementById("mobileSearchButton");
const mobileLibraryButton = document.getElementById("mobileLibraryButton");

const playerView = document.getElementById("playerView");
const videoPlayer = document.getElementById("videoPlayer");
const playerTitle = document.getElementById("playerTitle");
const playerMeta = document.getElementById("playerMeta");
const playerSourceBadge = document.getElementById("playerSourceBadge");
const closePlayerButton = document.getElementById("closePlayerButton");
const toast = document.getElementById("toast");

const state = {
  session: loadSession(),
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
  lastProgressAt: 0,
  lastFocusElement: null,
  searchTimer: null,
  searchRequestId: 0,
  toastTimer: null,
};

function getDeviceId() {
  const existing = localStorage.getItem(DEVICE_KEY);
  if (existing) return existing;
  const next = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  localStorage.setItem(DEVICE_KEY, next);
  return next;
}

const deviceId = getDeviceId();

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY)) || null;
  } catch {
    return null;
  }
}

function saveSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function normalizeServerUrl(value) {
  return value.trim().replace(/\/+$/, "");
}

async function getPublicServerInfo(serverUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch(`${normalizeServerUrl(serverUrl)}/System/Info/Public`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Server answered with ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function setDiscoveryMessage(message, status = "idle") {
  discoveryMessage.textContent = message;
  discoveryDot.className = "discovery-dot";
  if (status !== "idle") discoveryDot.classList.add(`is-${status}`);
}

function selectDiscoveredServer(server) {
  serverUrlInput.value = server.address;
  setDiscoveryMessage(`${server.name} is ready at ${server.address}`, "found");
  renderDiscoveredServers();
  usernameInput.focus();
}

function renderDiscoveredServers() {
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

async function discoverServers() {
  discoverButton.disabled = true;
  setDiscoveryMessage("Searching the local network for Jellyfin...", "searching");
  serverResults.innerHTML = "";
  try {
    const response = await fetch("/api/discover", { cache: "no-store" });
    if (!response.ok) throw new Error("Discovery service is unavailable");
    const result = await response.json();
    state.discoveredServers = Array.isArray(result.servers) ? result.servers : [];
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

function authHeader(token) {
  const safeDevice = navigator.platform || "Browser";
  const parts = [
    `MediaBrowser Client="${APP_NAME}"`,
    `Device="${safeDevice}"`,
    `DeviceId="${deviceId}"`,
    `Version="${APP_VERSION}"`,
  ];
  if (token) parts.push(`Token="${token}"`);
  return parts.join(", ");
}

function apiUrl(path, params = {}) {
  const url = new URL(`${state.session.serverUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

async function jellyfinFetch(path, options = {}) {
  if (!state.session) throw new Error("Not connected");
  const headers = new Headers(options.headers || {});
  headers.set("X-Emby-Authorization", authHeader(state.session.accessToken));
  headers.set("X-MediaBrowser-Token", state.session.accessToken);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(apiUrl(path, options.params), { ...options, headers });
  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    const error = new Error(responseText || `Jellyfin request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}

async function authenticate(serverUrl, username, password) {
  let serverInfo;
  try {
    serverInfo = await getPublicServerInfo(serverUrl);
  } catch {
    throw new Error("Could not reach that Jellyfin server.");
  }
  const response = await fetch(`${serverUrl}/Users/AuthenticateByName`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Emby-Authorization": authHeader(),
    },
    body: JSON.stringify({ Username: username, Pw: password }),
  });
  if (!response.ok) throw new Error("Could not sign in. Check the server URL and credentials.");
  const result = await response.json();
  return {
    serverUrl,
    accessToken: result.AccessToken,
    userId: result.User.Id,
    userName: result.User.Name,
    serverId: serverInfo.Id,
    serverName: serverInfo.ServerName,
    serverVersion: serverInfo.Version,
  };
}

function hasImage(item, kind) {
  if (!item) return false;
  if (kind === "Backdrop") return Array.isArray(item.BackdropImageTags) && item.BackdropImageTags.length > 0;
  return Boolean(item.ImageTags?.[kind]);
}

function imageUrl(item, kind = "Primary", options = {}) {
  if (!state.session || !item?.Id || !hasImage(item, kind)) return "";
  const params = {
    api_key: state.session.accessToken,
    quality: options.quality || 90,
    maxWidth: options.width || (kind === "Backdrop" ? 1600 : 500),
  };
  if (options.height) params.maxHeight = options.height;
  const tag = kind === "Backdrop" ? item.BackdropImageTags?.[0] : item.ImageTags?.[kind];
  if (tag) params.tag = tag;
  const suffix = kind === "Backdrop" ? "/0" : "";
  return apiUrl(`/Items/${item.Id}/Images/${kind}${suffix}`, params);
}

function preferredArtwork(item, shape) {
  if (shape === "landscape") {
    if (hasImage(item, "Backdrop")) return "Backdrop";
    if (hasImage(item, "Thumb")) return "Thumb";
  }
  return hasImage(item, "Primary") ? "Primary" : "";
}

function setImage(image, fallback, item, kind, options = {}) {
  const url = kind ? imageUrl(item, kind, options) : "";
  image.onload = null;
  image.onerror = null;
  image.classList.remove("is-hidden");
  image.classList.add("is-loading");
  if (fallback) fallback.classList.remove("is-hidden");
  if (!url) {
    image.removeAttribute("src");
    image.classList.remove("is-loading");
    image.classList.add("is-hidden");
    return;
  }
  image.onload = () => {
    image.classList.remove("is-loading");
    if (fallback) fallback.classList.add("is-hidden");
  };
  image.onerror = () => {
    image.classList.remove("is-loading");
    image.classList.add("is-hidden");
    if (fallback) fallback.classList.remove("is-hidden");
  };
  image.src = url;
}

function initials(name = "") {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((word) => word[0].toUpperCase())
    .join("");
}

function itemYear(item) {
  return item?.ProductionYear || item?.PremiereDate?.slice(0, 4) || "";
}

function runtime(item) {
  if (!item?.RunTimeTicks) return "";
  const totalSeconds = Math.round(item.RunTimeTicks / TICKS_PER_SECOND);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function episodeCode(item) {
  const season = item?.ParentIndexNumber;
  const episode = item?.IndexNumber;
  if (season == null && episode == null) return "";
  return [season == null ? "" : `S${season}`, episode == null ? "" : `E${episode}`].filter(Boolean).join(" ");
}

function canPlay(item) {
  return Boolean(item && (item.MediaType === "Video" || ["Movie", "Episode", "Video"].includes(item.Type)));
}

function itemCardTitle(item) {
  return item?.Type === "Episode" && item.SeriesName ? item.SeriesName : item?.Name || "Untitled";
}

function itemCardSubtitle(item) {
  if (item?.Type === "Episode") {
    return [episodeCode(item), item.Name].filter(Boolean).join(" - ");
  }
  return [itemYear(item), runtime(item)].filter(Boolean).join(" - ");
}

function metadataParts(item) {
  const parts = [];
  if (item?.Type === "Episode" && item.SeriesName) parts.push(item.SeriesName);
  if (episodeCode(item)) parts.push(episodeCode(item));
  if (itemYear(item)) parts.push(itemYear(item));
  if (item?.OfficialRating) parts.push(item.OfficialRating);
  if (runtime(item)) parts.push(runtime(item));
  if (item?.CommunityRating) parts.push(`${Number(item.CommunityRating).toFixed(1)}/10`);
  return parts;
}

function showLogin(message = "") {
  loginView.classList.remove("is-hidden");
  mainView.classList.add("is-hidden");
  playerView.classList.add("is-hidden");
  document.body.classList.remove("is-playing");
  loginMessage.textContent = message;
}

function showMain() {
  loginView.classList.add("is-hidden");
  mainView.classList.remove("is-hidden");
  userLabel.textContent = state.session.userName;
  serverLabel.textContent = state.session.serverName
    ? `${state.session.serverName} - ${state.session.serverUrl}`
    : state.session.serverUrl;
  profileInitial.textContent = (state.session.userName || "J")[0].toUpperCase();
}

function setLoginMessage(message, isError = false) {
  loginMessage.textContent = message;
  loginMessage.classList.toggle("is-error", isError);
}

function setButtonActive(button, active) {
  button.classList.toggle("is-active", active);
  button.setAttribute("aria-current", active ? "page" : "false");
}

function setRoute(route, options = {}) {
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

function showToast(message) {
  clearTimeout(state.toastTimer);
  toast.textContent = message;
  toast.classList.remove("is-hidden");
  state.toastTimer = setTimeout(() => toast.classList.add("is-hidden"), 3400);
}

function renderMessage(container, message) {
  container.innerHTML = "";
  const element = document.createElement("p");
  element.className = "empty-state";
  element.textContent = message;
  container.append(element);
}

function renderLoadingRows(container) {
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

async function loadLibraries() {
  const result = await jellyfinFetch(`/Users/${state.session.userId}/Views`);
  state.libraries = result.Items || [];
}

async function loadLatestForLibrary(library) {
  const collectionType = String(library.CollectionType || "").toLowerCase();
  const includeType = collectionType === "movies" ? "Movie" : collectionType === "tvshows" ? "Series" : "";
  if (!includeType) return [];
  const result = await jellyfinFetch(`/Users/${state.session.userId}/Items`, {
    params: {
      ParentId: library.Id,
      Recursive: "true",
      IncludeItemTypes: includeType,
      SortBy: "DateCreated",
      SortOrder: "Descending",
      Limit: 20,
      Fields: ITEM_FIELDS,
    },
  });
  return result.Items || [];
}

async function loadHome() {
  renderLoadingRows(homeRows);
  const resumePromise = jellyfinFetch(`/Users/${state.session.userId}/Items/Resume`, {
    params: { Fields: ITEM_FIELDS, MediaTypes: "Video", Limit: 20 },
  });
  const nextUpPromise = jellyfinFetch("/Shows/NextUp", {
    params: { UserId: state.session.userId, Fields: ITEM_FIELDS, Limit: 20 },
  });
  const latestPromises = state.libraries.map(async (library) => ({
    library,
    items: await loadLatestForLibrary(library),
  }));

  const [resumeResult, nextUpResult, latestResults] = await Promise.all([
    resumePromise,
    nextUpPromise,
    Promise.all(latestPromises),
  ]);

  state.resumeItems = resumeResult.Items || [];
  state.nextUpItems = nextUpResult.Items || [];
  const rows = [];
  if (state.resumeItems.length) rows.push({ title: "Continue Watching", items: state.resumeItems, shape: "landscape" });
  if (state.nextUpItems.length) rows.push({ title: "Next Up", items: state.nextUpItems, shape: "landscape" });
  for (const result of latestResults) {
    if (result.items.length) rows.push({ title: `Recently Added to ${result.library.Name}`, items: result.items, shape: "poster" });
  }
  state.homeRows = rows;
  state.featureItem = state.resumeItems[0] || state.nextUpItems[0] || rows[0]?.items[0] || null;
  renderFeature(state.featureItem);
  renderMediaRows(homeRows, rows);
}

async function loadInitialData() {
  showMain();
  renderLoadingRows(homeRows);
  try {
    await loadLibraries();
    await loadHome();
    setRoute("home");
  } catch (error) {
    if (error.status === 401) {
      clearSession();
      state.session = null;
      showLogin("Your Jellyfin session expired. Sign in again.");
      return;
    }
    homeRows.innerHTML = "";
    const message = document.createElement("p");
    message.className = "empty-state";
    message.textContent = "Jellyfin could not load the home screen.";
    homeRows.append(message);
    showToast(error.message);
  }
}

function renderFeature(item) {
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
  featureEyebrow.textContent = item.Type === "Episode"
    ? [item.SeriesName, episodeCode(item)].filter(Boolean).join(" - ")
    : [item.Type, itemYear(item)].filter(Boolean).join(" - ");
  featureTitle.textContent = item.Type === "Episode" && item.SeriesName ? item.SeriesName : item.Name;
  featureOverview.textContent = item.Overview || (item.Type === "Episode" ? item.Name : "");
  const kind = hasImage(item, "Backdrop") ? "Backdrop" : hasImage(item, "Primary") ? "Primary" : "";
  featureImage.classList.toggle("use-contain", kind === "Primary" && Number(item.PrimaryImageAspectRatio || 0) < 1.15);
  setImage(featureImage, null, item, kind, { width: 1800 });
  featurePlayButton.onclick = canPlay(item) ? () => playItem(item) : null;
  featureInfoButton.onclick = () => openDetails(item);
}

function renderMediaRows(container, rows) {
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

function createMediaRow(row) {
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

function createMediaCard(item, shape = "poster") {
  const button = document.createElement("button");
  const art = document.createElement("span");
  const image = document.createElement("img");
  const fallback = document.createElement("span");
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  const subtitle = document.createElement("small");

  button.type = "button";
  button.className = `media-card ${shape}`;
  button.title = itemCardTitle(item);
  button.addEventListener("click", () => openDetails(item));

  art.className = "media-art";
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  fallback.className = "art-fallback";
  fallback.textContent = initials(itemCardTitle(item));
  art.append(image, fallback);
  setImage(image, fallback, item, preferredArtwork(item, shape), {
    width: shape === "poster" ? 460 : 760,
    height: shape === "poster" ? 690 : 430,
  });

  const percentage = Number(item.UserData?.PlayedPercentage || 0);
  if (percentage > 0 && percentage < 100) {
    const progress = document.createElement("span");
    const progressValue = document.createElement("span");
    progress.className = "watch-progress";
    progressValue.style.width = `${Math.min(100, Math.max(1, percentage))}%`;
    progress.append(progressValue);
    art.append(progress);
  }

  copy.className = "media-copy";
  title.textContent = itemCardTitle(item);
  subtitle.textContent = itemCardSubtitle(item);
  copy.append(title, subtitle);
  button.append(art, copy);
  return button;
}

function renderDetails(item) {
  state.detailItem = item;
  state.detailPlayItem = canPlay(item) ? item : null;
  detailEyebrow.textContent = item.Type === "Episode"
    ? [item.SeriesName, episodeCode(item)].filter(Boolean).join(" - ")
    : item.Type || "Jellyfin";
  detailTitle.textContent = item.Name || "Untitled";
  detailOverview.textContent = item.Overview || "No description is available.";

  detailMeta.innerHTML = "";
  for (const value of metadataParts(item)) {
    const span = document.createElement("span");
    span.textContent = value;
    detailMeta.append(span);
  }

  detailGenres.innerHTML = "";
  for (const genre of item.Genres || []) {
    const span = document.createElement("span");
    span.textContent = genre;
    detailGenres.append(span);
  }

  const backdropKind = hasImage(item, "Backdrop") ? "Backdrop" : hasImage(item, "Primary") ? "Primary" : "";
  detailBackdrop.classList.toggle("use-contain", backdropKind === "Primary" && Number(item.PrimaryImageAspectRatio || 0) < 1.15);
  setImage(detailBackdrop, null, item, backdropKind, { width: 1800 });

  const posterSuitable = hasImage(item, "Primary") && Number(item.PrimaryImageAspectRatio || 0) < 1.15;
  detailHero.classList.toggle("has-no-poster", !posterSuitable);
  detailPosterFrame.classList.toggle("is-hidden", !posterSuitable);
  detailPosterFallback.textContent = initials(item.Name);
  if (posterSuitable) setImage(detailPoster, detailPosterFallback, item, "Primary", { width: 520, height: 780 });

  detailDownloadButton.disabled = !["Movie", "Series", "Episode"].includes(item.Type);
  detailDownloadButton.onclick = () => noteDownloadIntent(item);
  const trailer = item.RemoteTrailers?.find((entry) => entry.Url);
  detailTrailerButton.disabled = !trailer;
  detailTrailerButton.onclick = trailer ? () => window.open(trailer.Url, "_blank", "noopener,noreferrer") : null;
  updateDetailPlayButton();
}

function updateDetailPlayButton() {
  const item = state.detailPlayItem;
  detailPlayButton.disabled = !item;
  detailPlayButton.onclick = item ? () => playItem(item) : null;
  if (!item) {
    detailPlayLabel.textContent = state.detailItem?.Type === "Series" ? "Loading" : "Play";
    return;
  }
  const hasProgress = Number(item.UserData?.PlaybackPositionTicks || 0) > 0;
  detailPlayLabel.textContent = hasProgress ? "Resume" : "Play";
}

async function openDetails(item) {
  if (!item?.Id) return;
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
    const fullItem = await jellyfinFetch(`/Users/${state.session.userId}/Items/${item.Id}`, {
      params: { Fields: ITEM_FIELDS },
    });
    if (requestId !== state.detailsRequestId) return;
    renderDetails(fullItem);
    if (fullItem.Type === "Series") await loadSeriesSeasons(fullItem, requestId);
  } catch (error) {
    showToast(error.message);
  }
}

function returnFromDetails() {
  const route = state.returnRoute || "home";
  const scrollTop = state.returnScrollTop || 0;
  setRoute(route, { scrollTop });
  requestAnimationFrame(() => {
    contentScroller.scrollTop = scrollTop;
  });
}

async function loadSeriesSeasons(series, requestId) {
  episodeSection.classList.remove("is-hidden");
  seasonSelect.disabled = true;
  episodeList.innerHTML = '<li class="empty-state">Loading episodes...</li>';
  const result = await jellyfinFetch(`/Shows/${series.Id}/Seasons`, {
    params: { UserId: state.session.userId, Fields: ITEM_FIELDS },
  });
  if (requestId !== state.detailsRequestId) return;
  state.seasons = result.Items || [];
  seasonSelect.innerHTML = "";
  for (const season of state.seasons) {
    const option = document.createElement("option");
    option.value = season.Id;
    option.textContent = season.Name;
    seasonSelect.append(option);
  }
  seasonSelect.disabled = state.seasons.length === 0;
  if (!state.seasons.length) {
    episodeList.innerHTML = '<li class="empty-state">No episodes found.</li>';
    return;
  }
  const nextForSeries = state.nextUpItems.find((entry) => entry.SeriesId === series.Id);
  const preferredSeason = state.seasons.find((season) => season.Id === nextForSeries?.SeasonId) || state.seasons[0];
  seasonSelect.value = preferredSeason.Id;
  await loadEpisodes(series.Id, preferredSeason.Id, requestId);
}

async function loadEpisodes(seriesId, seasonId, requestId = state.detailsRequestId) {
  episodeList.innerHTML = '<li class="empty-state">Loading episodes...</li>';
  const result = await jellyfinFetch(`/Shows/${seriesId}/Episodes`, {
    params: {
      UserId: state.session.userId,
      SeasonId: seasonId,
      Fields: ITEM_FIELDS,
    },
  });
  if (requestId !== state.detailsRequestId) return;
  state.episodes = result.Items || [];
  const nextForSeries = state.nextUpItems.find((entry) => entry.SeriesId === seriesId && entry.SeasonId === seasonId);
  state.detailPlayItem = nextForSeries
    || state.episodes.find((episode) => !episode.UserData?.Played)
    || state.episodes[0]
    || null;
  updateDetailPlayButton();
  renderEpisodes();
}

function renderEpisodes() {
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
    fallback.textContent = episode.IndexNumber == null ? "E" : `E${episode.IndexNumber}`;
    thumb.append(image, fallback);
    setImage(image, fallback, episode, preferredArtwork(episode, "landscape"), { width: 720, height: 405 });

    const percentage = Number(episode.UserData?.PlayedPercentage || 0);
    if (percentage > 0 && percentage < 100) {
      const progress = document.createElement("span");
      const value = document.createElement("span");
      progress.className = "watch-progress";
      value.style.width = `${Math.min(100, Math.max(1, percentage))}%`;
      progress.append(value);
      thumb.append(progress);
    }

    copy.className = "episode-copy";
    title.textContent = episode.Name || `Episode ${episode.IndexNumber || ""}`;
    meta.textContent = [episodeCode(episode), runtime(episode)].filter(Boolean).join(" - ");
    overview.textContent = episode.Overview || "";
    copy.append(title, meta, overview);

    actions.className = "episode-actions";
    play.type = "button";
    play.className = "primary";
    play.textContent = episode.UserData?.PlaybackPositionTicks ? "Resume" : "Play";
    play.addEventListener("click", () => playItem(episode));
    download.type = "button";
    download.textContent = "Download";
    download.addEventListener("click", () => noteDownloadIntent(episode));
    actions.append(play, download);

    row.append(thumb, copy, actions);
    episodeList.append(row);
  }
}

async function openLibraryCategory(type) {
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
    const result = await jellyfinFetch(`/Users/${state.session.userId}/Items`, {
      params: {
        Recursive: "true",
        IncludeItemTypes: type,
        SortBy: "SortName",
        SortOrder: "Ascending",
        Fields: ITEM_FIELDS,
        Limit: 500,
      },
    });
    state.libraryCache[type] = result.Items || [];
    if (state.currentRoute === "library" && state.libraryType === type) renderLibraryGrid(state.libraryCache[type]);
  } catch (error) {
    renderMessage(libraryGrid, error.message);
  }
}

function renderLibraryGrid(items) {
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

async function runSearch(query) {
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
    const result = await jellyfinFetch(`/Users/${state.session.userId}/Items`, {
      params: {
        SearchTerm: trimmed,
        Recursive: "true",
        IncludeItemTypes: "Movie,Series,Episode",
        Fields: ITEM_FIELDS,
        Limit: 60,
      },
    });
    if (requestId !== state.searchRequestId) return;
    const items = result.Items || [];
    const rows = [
      { title: "Movies", items: items.filter((item) => item.Type === "Movie"), shape: "poster" },
      { title: "Shows", items: items.filter((item) => item.Type === "Series"), shape: "poster" },
      { title: "Episodes", items: items.filter((item) => item.Type === "Episode"), shape: "landscape" },
    ].filter((row) => row.items.length);
    renderMediaRows(searchRows, rows);
  } catch (error) {
    if (requestId !== state.searchRequestId) return;
    renderMessage(searchRows, error.message);
  }
}

function noteDownloadIntent(item) {
  showToast(`${item.Name}: downloads are not active in this build yet.`);
}

function streamUrl(item) {
  return apiUrl(`/Videos/${item.Id}/stream`, {
    static: "true",
    mediaSourceId: item.MediaSources?.[0]?.Id,
    api_key: state.session.accessToken,
  });
}

async function resolvePlayback(item) {
  return { source: "server", url: streamUrl(item) };
}

async function playItem(item) {
  if (!canPlay(item)) return;
  state.lastFocusElement = document.activeElement;
  state.playbackItem = item;
  playerTitle.textContent = item.Type === "Episode" && item.SeriesName ? item.SeriesName : item.Name || "Now Playing";
  playerMeta.textContent = item.Type === "Episode"
    ? [episodeCode(item), item.Name].filter(Boolean).join(" - ")
    : metadataParts(item).join(" - ");
  playerView.classList.remove("is-hidden");
  document.body.classList.add("is-playing");
  closePlayerButton.focus();

  const resolved = await resolvePlayback(item);
  playerSourceBadge.textContent = resolved.source === "server" ? "Streaming" : "On this device";
  videoPlayer.src = resolved.url;
  videoPlayer.onloadedmetadata = () => {
    const resumeSeconds = Number(item.UserData?.PlaybackPositionTicks || 0) / TICKS_PER_SECOND;
    if (resumeSeconds > 2 && resumeSeconds < videoPlayer.duration - 5) videoPlayer.currentTime = resumeSeconds;
  };
  videoPlayer.load();
  reportPlayback("start", item);
  videoPlayer.play().catch(() => {
    showToast("The stream is ready. Press play in the video controls.");
  });
}

function closePlayer() {
  const item = state.playbackItem;
  if (item) reportPlayback("stop", item);
  videoPlayer.pause();
  videoPlayer.removeAttribute("src");
  videoPlayer.load();
  videoPlayer.onloadedmetadata = null;
  playerView.classList.add("is-hidden");
  document.body.classList.remove("is-playing");
  state.playbackItem = null;
  state.lastFocusElement?.focus?.();
}

async function reportPlayback(kind, item = state.playbackItem) {
  if (!item || !state.session) return;
  const body = {
    ItemId: item.Id,
    MediaSourceId: item.MediaSources?.[0]?.Id,
    PositionTicks: Math.floor((videoPlayer.currentTime || 0) * TICKS_PER_SECOND),
    IsPaused: videoPlayer.paused,
    PlayMethod: "DirectStream",
  };
  const endpoint = kind === "stop"
    ? "/Sessions/Playing/Stopped"
    : kind === "progress"
      ? "/Sessions/Playing/Progress"
      : "/Sessions/Playing";
  try {
    await jellyfinFetch(endpoint, { method: "POST", body: JSON.stringify(body) });
  } catch {
    // Reporting progress must never interrupt playback.
  }
}

function resetSignedInState() {
  state.libraries = [];
  state.homeRows = [];
  state.resumeItems = [];
  state.nextUpItems = [];
  state.featureItem = null;
  state.libraryCache = { Movie: null, Series: null };
  state.detailItem = null;
  state.detailPlayItem = null;
  searchInput.value = "";
  profileMenu.classList.add("is-hidden");
  profileButton.setAttribute("aria-expanded", "false");
}

async function bootstrap() {
  if (!state.session) {
    showLogin();
    await discoverServers();
    return;
  }
  await loadInitialData();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setLoginMessage("Signing in...");
  const serverUrl = normalizeServerUrl(serverUrlInput.value);
  try {
    state.session = await authenticate(serverUrl, usernameInput.value.trim(), passwordInput.value);
    saveSession(state.session);
    passwordInput.value = "";
    setLoginMessage("");
    resetSignedInState();
    await loadInitialData();
  } catch (error) {
    setLoginMessage(error.message, true);
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
  if (state.detailItem?.Type === "Series") loadEpisodes(state.detailItem.Id, seasonSelect.value);
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
  clearTimeout(state.searchTimer);
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

logoutButton.addEventListener("click", async () => {
  closePlayer();
  clearSession();
  state.session = null;
  resetSignedInState();
  showLogin("Signed out.");
  await discoverServers();
});

closePlayerButton.addEventListener("click", closePlayer);
videoPlayer.addEventListener("timeupdate", () => {
  const now = Date.now();
  if (now - state.lastProgressAt > PLAYBACK_THROTTLE_MS) {
    state.lastProgressAt = now;
    reportPlayback("progress");
  }
});
videoPlayer.addEventListener("pause", () => {
  if (!playerView.classList.contains("is-hidden")) reportPlayback("progress");
});
videoPlayer.addEventListener("ended", () => reportPlayback("stop"));

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!playerView.classList.contains("is-hidden")) {
    closePlayer();
  } else if (!profileMenu.classList.contains("is-hidden")) {
    profileMenu.classList.add("is-hidden");
    profileButton.setAttribute("aria-expanded", "false");
  } else if (state.currentRoute === "details") {
    returnFromDetails();
  }
});

window.addEventListener("beforeunload", () => reportPlayback("stop"));

if (state.session?.serverUrl) serverUrlInput.value = state.session.serverUrl;

bootstrap();
