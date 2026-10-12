import type { CompanionSettingsBridge, YouTubeSearchSettings } from "../shared/companionContracts";

export function mountYouTubeSettings(bridge: Pick<CompanionSettingsBridge, "getYouTubeSearchSettings" | "setYouTubeApiKey">) {
  const input = document.getElementById("youtubeApiKeyInput") as HTMLInputElement;
  const save = document.getElementById("youtubeSaveKeyButton") as HTMLButtonElement;
  const remove = document.getElementById("youtubeRemoveKeyButton") as HTMLButtonElement;
  const status = document.getElementById("youtubeApiKeyStatus")!;
  let busy = false;
  let saved = false;
  let revision = 0;
  function render(value: YouTubeSearchSettings) {
    saved = value.source === "saved" || value.storageUnavailable;
    remove.disabled = !saved || busy;
    status.textContent = value.storageUnavailable ? "The saved key could not be opened. Paste it again to replace it, or remove it."
      : value.source === "saved" ? "Key saved with Windows-protected storage. YouTube search is configured."
      : value.source === "environment" ? "Using the desktop environment key. Save a key here to replace it."
      : "No key saved. Paste your YouTube Data API key above.";
  }
  async function load() {
    if (busy) return;
    const request = ++revision;
    try { const value = await bridge.getYouTubeSearchSettings(); if (request === revision) render(value); }
    catch { if (request === revision) status.textContent = "YouTube settings could not be loaded. Close and reopen this panel to retry."; }
  }
  async function update(key: string) {
    if (busy) return;
    revision++;
    busy = true; input.disabled = true; save.disabled = true; remove.disabled = true;
    status.textContent = key ? "Saving securely…" : "Removing saved key…";
    try { const value = await bridge.setYouTubeApiKey({ apiKey: key }); input.value = ""; render(value); }
    catch { status.textContent = "Could not save this setting securely. Your previous setting has been kept."; }
    finally { busy = false; input.disabled = false; save.disabled = false; remove.disabled = !saved; }
  }
  document.getElementById("youtubeApiKeyForm")!.addEventListener("submit", event => {
    event.preventDefault();
    const key = input.value.trim();
    if (!/^[A-Za-z0-9_-]{20,256}$/.test(key)) { status.textContent = "Paste a valid YouTube Data API key, then choose Save key."; input.focus(); return; }
    void update(key);
  });
  remove.addEventListener("click", () => void update(""));
  return { load, clear: () => { input.value = ""; } };
}
