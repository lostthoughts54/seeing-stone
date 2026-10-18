import type { JellyfinBridge, UpdateCheckStatus } from "../shared/contracts";

export function updateStatusText(state: UpdateCheckStatus): string {
  if (state.message) return state.message;
  switch (state.status) {
    case "idle": return "Check for a newer version of Seeing Stone.";
    case "checking": return "Checking for updates…";
    case "current": return "You're running the latest version available on this channel.";
    case "downloading": return `Downloading version ${state.latestVersion}…`;
    case "ready": return `Version ${state.latestVersion} is ready to install.`;
    case "installing": return "Closing your session and restarting to install the update…";
    case "unavailable": return "Updates are unavailable for this installation.";
    case "error": return "Couldn't complete the update. Please retry.";
  }
}

const bytes = (value: number): string => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
export function updateProgressText(state: UpdateCheckStatus): string {
  const p = state.progress;
  if (!p) return "Preparing download…";
  if (p.total === null || p.percent === null) return `${bytes(p.transferred)} downloaded · total size unknown`;
  return `${Math.floor(p.percent)}% · ${bytes(p.transferred)} / ${bytes(p.total)}`;
}

export function mountUpdates(bridge: JellyfinBridge["updates"]): () => void {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = el<HTMLDialogElement>("updatesSettings");
  const check = el<HTMLButtonElement>("checkForUpdatesButton");
  const install = el<HTMLButtonElement>("installUpdateButton");
  const later = el<HTMLButtonElement>("laterUpdateButton");
  const bannerInstall = el<HTMLButtonElement>("viewUpdateButton");
  const bannerLater = el<HTMLButtonElement>("dismissUpdateButton");
  const progress = el<HTMLProgressElement>("updateProgress");
  const status = el<HTMLElement>("updateCheckStatus");
  let latest: UpdateCheckStatus | null = null;
  let pending = false;
  let destroyed = false;
  const render = (state: UpdateCheckStatus) => {
    if (destroyed || (latest && state.revision < latest.revision)) return;
    latest = state;
    el("profileVersionLabel").textContent = `${state.appName} ${state.currentVersion}`;
    el("applicationVersionLabel").textContent = `${state.appName} · Version ${state.currentVersion}`;
    el("updateChannelLabel").textContent = `Channel: ${state.channel === "latest" ? "Stable" : state.channel}`;
    status.textContent = updateStatusText(state);
    check.disabled = pending || ["checking", "downloading", "installing", "unavailable", "ready"].includes(state.status);
    check.textContent = state.status === "error" ? "Retry update" : "Check for Updates";
    const ready = state.status === "ready";
    el("updateReadyActions").classList.toggle("is-hidden", !ready);
    install.disabled = pending;
    bannerInstall.disabled = pending;
    later.disabled = pending;
    bannerLater.disabled = pending;
    el("updateProgressContainer").classList.toggle("is-hidden", state.status !== "downloading");
    if (state.progress?.percent != null) progress.value = state.progress.percent;
    else progress.removeAttribute("value");
    el("updateProgressText").textContent = state.status === "downloading" ? updateProgressText(state) : "";
    el("updateSessionNotice").textContent = state.sessionActive ? "Playback or a watch party is active. Restarting will require confirmation." : "Updates install only when you choose Restart & Update. Closing the app won't install them.";
    el("updateLastChecked").textContent = state.lastCheckedAt ? `Last checked: ${new Date(state.lastCheckedAt).toLocaleString()}` : "Last checked: Never";
    el("updateBanner").classList.toggle("is-hidden", !state.promptVisible || dialog.open);
    el("updateBannerText").textContent = ready ? `Seeing Stone ${state.latestVersion} is ready to install` : "";
  };
  const refresh = async () => {
    try { render(await bridge.getState()); }
    catch { if (!latest) status.textContent = "Update status could not be loaded. Close and reopen Settings to retry."; }
  };
  const run = async (action: () => Promise<UpdateCheckStatus>) => {
    if (pending) return;
    pending = true;
    if (latest) render(latest);
    let failed = false;
    try { render(await action()); }
    catch { failed = true; }
    finally {
      pending = false;
      if (latest) render(latest);
      if (failed) status.textContent = "The update request could not be completed. Close and reopen Settings to retry.";
    }
  };
  const unsub = bridge.subscribe(render);
  const events = new AbortController();
  const on = (target: EventTarget, name: string, listener: EventListener) => target.addEventListener(name, listener, { signal: events.signal });
  for (const button of document.querySelectorAll<HTMLElement>("[data-open-updates]")) on(button, "click", () => {
    el("profileMenu").classList.add("is-hidden");
    el("profileButton").setAttribute("aria-expanded", "false");
    if (!dialog.open) dialog.showModal();
    if (latest) render(latest);
    void refresh();
  });
  on(el("closeUpdatesButton"), "click", () => dialog.close());
  on(dialog, "close", () => { if (latest) render(latest); });
  // Keep global player shortcuts from changing playback while using this dialog.
  on(dialog, "keydown", (event) => event.stopPropagation());
  on(check, "click", () => { void run(() => bridge.check()); });
  for (const button of [install, bannerInstall]) on(button, "click", () => { void run(() => bridge.install()); });
  for (const button of [later, bannerLater]) on(button, "click", () => { void run(() => bridge.defer()); });
  void refresh();
  return () => { destroyed = true; unsub(); events.abort(); };
}
