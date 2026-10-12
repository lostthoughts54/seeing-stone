import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { IptvSetup, IptvChannelSchedule } from "../../shared/iptv";
import type { IptvCatalogueRecord } from "./persistenceTypes";
import { AppError } from "./errors";

const invalidFeed = () => new AppError("IPTV_INVALID_FEED", "The provider returned an invalid or unsupported catalogue.", 502);
export function iptvPublicFailure(error: unknown): string {
  if (error instanceof AppError) {
    if (error.code === "IPTV_INCOMPLETE_CATALOGUE") return "The provider returned categories but no entries after three attempts. Retry later; your previous catalogue is unchanged.";
    if (error.code === "IPTV_AUTHENTICATION") return "Account rejected or expired. Check the provider address, username and password.";
    if (error.code === "IPTV_INVALID_FEED") return "The provider returned an invalid or unsupported catalogue. Check the address and retry.";
    if (error.code === "IPTV_PROTECTION_UNAVAILABLE" || error.code === "IPTV_CREDENTIALS_UNAVAILABLE") return "Windows could not open the saved credentials. Retry or remove and add this provider again.";
    if (error.code.startsWith("PERSISTENCE")) return "The catalogue could not be saved. Your previous catalogue is still available.";
  }
  return "The provider could not be reached or the request timed out. Retry when the connection is available.";
}

/** Only this main-owned adapter sees provider URLs. Never include upstream errors in logs or IPC. */
export class IptvProviderClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  private async request(address: string, signal: AbortSignal): Promise<Response> {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
    let url = new URL(address);
    for (let redirects = 0; redirects <= 5; redirects++) {
      requestSignal.throwIfAborted();
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw invalidFeed();
      const response = await this.fetcher(url, { signal: requestSignal, redirect: "manual", headers: { Accept: "application/json, audio/x-mpegurl, text/plain, */*" } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw invalidFeed();
        const next = new URL(location, url);
        if (url.protocol === "https:" && next.protocol !== "https:") throw invalidFeed();
        url = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status)) throw new AppError("IPTV_AUTHENTICATION", "Provider authentication failed.", 401);
        throw new AppError("IPTV_NETWORK", "Provider request failed.", 502);
      }
      return response;
    }
    throw invalidFeed();
  }

  private apiUrl(setup: Extract<IptvSetup, { kind: "xtream" }>, action?: string): string {
    const base = new URL(setup.address);
    base.pathname = base.pathname.replace(/\/(?:player_api|get|xmltv)\.php\/?$/i, "").replace(/\/$/, "") + "/player_api.php";
    base.searchParams.set("username", setup.username);
    base.searchParams.set("password", setup.password);
    if (action) base.searchParams.set("action", action);
    return base.href;
  }

  async *guideChannelMappings(setup: IptvSetup, signal: AbortSignal): AsyncGenerator<{ id: string; epg: string }> {
    if (setup.kind !== "xtream") throw invalidFeed();
    for await (const row of jsonArray(await this.request(this.apiUrl(setup, "get_live_streams"), signal))) {
      const id = providerId(row.stream_id);
      const epg = typeof row.epg_channel_id === "string" ? row.epg_channel_id.trim() : "";
      if (id && epg && epg.length <= 512) yield { id, epg };
    }
  }

  async *guideXml(setup: IptvSetup, signal: AbortSignal): AsyncGenerator<string> {
    let address = setup.xmltvUrl;
    if (!address && setup.kind === "xtream") {
      const url = new URL(this.apiUrl(setup)); url.pathname = url.pathname.replace(/player_api\.php$/, "xmltv.php"); address = url.href;
    }
    if (!address) throw invalidFeed();
    yield* responseText(await this.request(address, signal));
  }

  async authenticate(setup: IptvSetup, signal: AbortSignal): Promise<void> {
    if (setup.kind === "m3u") return; // Playlist validity is checked during import.
    const response = await this.request(this.apiUrl(setup), signal);
    let text = "";
    for await (const chunk of responseText(response, 128 * 1024)) text += chunk;
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw invalidFeed(); }
    const user = object(object(data).user_info);
    const expiry = Number(user.exp_date);
    if (String(user.auth) !== "1" || String(user.status).toLowerCase() !== "active" || (expiry > 0 && expiry * 1000 <= Date.now())) {
      throw new AppError("IPTV_AUTHENTICATION", "Provider authentication failed.", 401);
    }
  }

  liveAddress(setup: IptvSetup, channelId: string): string {
    if (setup.kind !== "xtream") throw new AppError("IPTV_PLAYBACK_UNAVAILABLE", "Playlist playback is not available yet.", 422);
    if (!providerId(channelId)) throw invalidFeed();
    const url = new URL(this.apiUrl(setup));
    url.search = "";
    url.pathname = url.pathname.replace(/player_api\.php$/, `live/${encodeURIComponent(setup.username)}/${encodeURIComponent(setup.password)}/${channelId}.ts`);
    return url.href;
  }

  async poster(setup: IptvSetup, contentType: "movie" | "series", itemId: string, signal: AbortSignal): Promise<string | null> {
    if (setup.kind !== "xtream" || !providerId(itemId)) return null;
    const url = new URL(this.apiUrl(setup, contentType === "movie" ? "get_vod_info" : "get_series_info"));
    url.searchParams.set(contentType === "movie" ? "vod_id" : "series_id", itemId);
    let text = "";
    for await (const chunk of responseText(await this.request(url.href, signal), 8 * 1024 * 1024)) text += chunk;
    let data: Record<string, unknown>;
    try { data = object(JSON.parse(text)); } catch { throw invalidFeed(); }
    const info = object(data.info);
    const address = info.movie_image || info.cover || object(data.movie_data).stream_icon;
    if (typeof address !== "string" || !address.trim() || address.length > 8192) return null;
    // Upstream addresses (which can contain account tokens) never leave the main process.
    const response = await this.request(address, signal);
    const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (!mime || !["image/jpeg", "image/png", "image/webp"].includes(mime) || !response.body) { await response.body?.cancel(); return null; }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 2 * 1024 * 1024) return null;
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return bytes ? `data:${mime};base64,${Buffer.concat(chunks).toString("base64")}` : null;
  }

  async schedule(setup: IptvSetup, channelId: string, signal: AbortSignal): Promise<IptvChannelSchedule> {
    if (setup.kind !== "xtream") throw new AppError("IPTV_GUIDE_UNAVAILABLE", "XMLTV playlist guides are not available yet.", 422);
    if (!providerId(channelId)) throw invalidFeed();
    const url = new URL(this.apiUrl(setup, "get_simple_data_table"));
    url.searchParams.set("stream_id", channelId);
    const response = await this.request(url.href, signal);
    let text = "";
    for await (const chunk of responseText(response, 8 * 1024 * 1024)) text += chunk;
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw invalidFeed(); }
    const rows = object(data).epg_listings;
    if (!Array.isArray(rows) || rows.length > 10000) throw invalidFeed();
    const decode = (value: unknown, maximum: number): string => {
      const raw = String(value ?? "");
      let result = /^[A-Za-z0-9+/]+={0,2}$/.test(raw) && raw.length % 4 === 0 ? Buffer.from(raw, "base64").toString("utf8") : raw;
      result = result.replace(/https?:\/\/[^\s<>"']+/giu, "[provider link]").replace(/<[^>]*>/g, "").replace(/[\u0000-\u001f\u007f]/gu, " ");
      for (const secret of [setup.username, setup.password]) if (secret) result = result.split(secret).join("[private]");
      return result.slice(0, maximum).trim();
    };
    const now = Date.now();
    const programmes: IptvChannelSchedule["programmes"] = [];
    for (const raw of rows) {
      const row = object(raw);
      // Epoch timestamps avoid provider-local timezone ambiguity and DST guesses.
      const start = Number(row.start_timestamp) * 1000;
      const end = Number(row.stop_timestamp ?? row.end_timestamp) * 1000;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= start || end < now - 86400000 || start > now + 7 * 86400000) continue;
      programmes.push({ id: createHash("sha256").update(`${channelId}:${start}:${end}`).digest("hex"), title: decode(row.title, 1024) || "Untitled programme", description: decode(row.description, 8192), startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString() });
    }
    return { programmes: programmes.sort((a, b) => a.startUtc.localeCompare(b.startUtc)).slice(0, 500), fetchedAt: new Date().toISOString(), stale: false };
  }

  async *catalogue(setup: IptvSetup, signal: AbortSignal): AsyncGenerator<IptvCatalogueRecord> {
    const clean = (value: unknown, maximum = 1024): string => {
      let text = String(value ?? "").replace(/https?:\/\/[^\s<>"']+/giu, "[provider link]").replace(/[\u0000-\u001f\u007f]/gu, " ");
      if (setup.kind === "xtream") {
        for (const secret of [setup.username, setup.password]) if (secret) text = text.split(secret).join("[private]");
      }
      return text.trim().slice(0, maximum);
    };
    if (setup.kind === "m3u") {
      const response = await this.request(setup.playlistUrl, signal);
      let header = false;
      let metadata: string | null = null;
      let buffer = "";
      const parseLine = (raw: string): IptvCatalogueRecord | null => {
        const line = raw.trim().replace(/^\uFEFF/, "");
        if (!line) return null;
        if (!header) { if (!line.startsWith("#EXTM3U")) throw invalidFeed(); header = true; return null; }
        if (line.startsWith("#EXTINF:")) { metadata = line; return null; }
        if (line.startsWith("#")) return null;
        if (!metadata) throw invalidFeed();
        const url = new URL(line, setup.playlistUrl);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw invalidFeed();
        const attributes = Object.fromEntries([...metadata.matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
        // The last quoted attribute may contain commas; find the first unquoted delimiter.
        let quote = false; let comma = -1;
        for (let index = 0; index < metadata.length; index++) {
          if (metadata[index] === '"') quote = !quote;
          if (!quote && metadata[index] === ",") { comma = index; break; }
        }
        const name = clean(comma >= 0 ? metadata.slice(comma + 1) : attributes["tvg-name"]) || "Unnamed channel";
        const group = clean(attributes["group-title"], 256) || null;
        const item: IptvCatalogueRecord = {
          contentType: "live", itemId: createHash("sha256").update(`${attributes["tvg-id"] ?? ""}\n${url.href}`).digest("hex"),
          name, nameKey: name.normalize("NFKC").toLowerCase(),
          groupId: group ? createHash("sha256").update(group).digest("hex") : null, groupName: group,
          channelNumber: clean(attributes["tvg-chno"], 32) || null,
        };
        metadata = null;
        return item;
      };
      for await (const chunk of responseText(response)) {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (line.length > 65536) throw invalidFeed();
          const item = parseLine(line); if (item) yield item;
        }
        if (buffer.length > 65536) throw invalidFeed();
      }
      if (buffer) { const item = parseLine(buffer); if (item) yield item; }
      if (!header || metadata) throw invalidFeed();
      return;
    }
    for (const [contentType, categoriesAction, itemsAction] of [
      ["live", "get_live_categories", "get_live_streams"],
      ["movie", "get_vod_categories", "get_vod_streams"],
      ["series", "get_series_categories", "get_series"],
    ] as const) {
      const groups = new Map<string, string>();
      for await (const row of jsonArray(await this.request(this.apiUrl(setup, categoriesAction), signal))) {
        const id = providerId(row.category_id);
        if (id) groups.set(id, clean(row.category_name, 256));
        if (groups.size > 10000) throw invalidFeed();
      }
      // Some providers transiently return HTTP 200 + [] while populated categories exist.
      // Do not publish that response as a successful empty section or erase a usable snapshot.
      for (let attempt = 0; attempt < 3; attempt++) {
        let received = 0;
        for await (const row of jsonArray(await this.request(this.apiUrl(setup, itemsAction), signal))) {
          signal.throwIfAborted();
          const id = providerId(contentType === "series" ? row.series_id : row.stream_id);
          if (!id) throw invalidFeed();
          const name = clean(row.name) || "Untitled";
          const groupId = providerId(row.category_id);
          received++;
          yield { contentType, itemId: id, name, nameKey: name.normalize("NFKC").toLowerCase(), groupId, groupName: groupId ? groups.get(groupId) ?? "Other" : null, channelNumber: contentType === "live" ? clean(row.num, 32) || null : null };
        }
        if (received > 0 || groups.size === 0) break;
        if (attempt === 2) throw new AppError("IPTV_INCOMPLETE_CATALOGUE", "Provider catalogue was incomplete.", 502);
        await delay(1000 * (attempt + 1), undefined, { signal });
      }
    }
  }
}

function providerId(value: unknown): string | null { const id = String(value ?? ""); return /^\d{1,128}$/.test(id) ? id : null; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

async function* responseText(response: Response, maximum = 256 * 1024 * 1024): AsyncGenerator<string> {
  if (!response.body) throw invalidFeed();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) throw invalidFeed();
      yield decoder.decode(chunk.value, { stream: true });
    }
    yield decoder.decode();
  } finally { await reader.cancel().catch(() => undefined); }
}

/** Incremental top-level object array parser: bounded per record, including chunked UTF-8. */
export async function* jsonArray(response: Response): AsyncGenerator<Record<string, unknown>> {
  let state: "start" | "value" | "object" | "separator" | "done" = "start";
  let record = ""; let depth = 0; let quoted = false; let escaped = false; let allowEnd = true;
  for await (const chunk of responseText(response)) {
    for (const character of chunk) {
      if (state === "object") {
        record += character;
        if (record.length > 1024 * 1024) throw invalidFeed();
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') quoted = false;
        } else if (character === '"') quoted = true;
        else if (character === "{" || character === "[") depth++;
        else if (character === "}" || character === "]") {
          depth--;
          if (depth === 0) {
            let parsed: unknown;
            try { parsed = JSON.parse(record); } catch { throw invalidFeed(); }
            yield object(parsed);
            record = ""; state = "separator";
          }
        }
        continue;
      }
      if (/\s/u.test(character) || (state === "start" && character === "\uFEFF")) continue;
      if (state === "start" && character === "[") { state = "value"; continue; }
      if (state === "value" && character === "{" ) { record = "{"; depth = 1; state = "object"; continue; }
      if (state === "value" && character === "]" && allowEnd) { state = "done"; continue; }
      if (state === "separator" && character === ",") { state = "value"; allowEnd = false; continue; }
      if (state === "separator" && character === "]") { state = "done"; continue; }
      throw invalidFeed();
    }
  }
  if (state !== "done") throw invalidFeed();
}
