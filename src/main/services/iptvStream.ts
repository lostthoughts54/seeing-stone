import { randomUUID } from "node:crypto";
import { AppError } from "./errors";

/** Main-only stream capability. Upstream URLs never reach mpv, IPC, or logs. */
export class IptvStream {
  private readonly lifetime = new AbortController();
  private readonly resources = new Map<string, string>();
  private readonly paths = new Map<string, string>();
  constructor(address: string, private readonly fetcher: typeof fetch = fetch) { this.resources.set("root", address); }
  close(): void { this.lifetime.abort(); this.resources.clear(); this.paths.clear(); }
  has(path: string): boolean { return this.resources.has(path); }
  async fetch(path: string, signal: AbortSignal, range?: string): Promise<Response> {
    const address = this.resources.get(path);
    if (!address) return new Response(null, { status: 404 });
    const combined = AbortSignal.any([signal, this.lifetime.signal]);
    let url = new URL(address);
    try {
      for (let redirects = 0; redirects <= 5; redirects++) {
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25000);
        let response: Response;
        try { response = await this.fetcher(url, { signal: AbortSignal.any([combined, controller.signal]), redirect: "manual", headers: range ? { Range: range } : {} }); }
        finally { clearTimeout(timer); }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location"); await response.body?.cancel();
          if (!location) throw new Error();
          const next = new URL(location, url);
          if (url.protocol === "https:" && next.protocol !== "https:") throw new Error();
          url = next; continue;
        }
        if (!response.ok) { await response.body?.cancel(); throw new Error(); }
        if (/mpegurl/i.test(response.headers.get("content-type") ?? "") || /\.m3u8$/i.test(url.pathname)) {
          const reader = response.body?.getReader(); if (!reader) throw new Error();
          let bytes = 0; const chunks: Uint8Array[] = [];
          try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 2 * 1024 * 1024) throw new Error(); chunks.push(part.value); } }
          finally { await reader.cancel().catch(() => undefined); }
          const text = Buffer.concat(chunks).toString("utf8");
          if (!text.trimStart().startsWith("#EXTM3U") || text.includes("{$")) throw new Error();
          const capability = (value: string) => {
            const upstream = new URL(value, url);
            if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password || (url.protocol === "https:" && upstream.protocol !== "https:")) throw new Error();
            let result = this.paths.get(upstream.href);
            if (!result) {
              if (this.paths.size >= 20000) {
                const oldest = this.paths.entries().next().value!;
                this.paths.delete(oldest[0]); this.resources.delete(oldest[1]);
              }
              result = `/${randomUUID()}`; this.paths.set(upstream.href, result); this.resources.set(result, upstream.href);
            }
            return result;
          };
          const rewritten = text.split(/\r?\n/).map(line => {
            if (!line.trim()) return line;
            if (!line.startsWith("#")) return capability(line.trim());
            return line.replace(/URI="([^"]*)"/g, (_match, uri: string) => `URI="${capability(uri)}"`);
          }).join("\n");
          return new Response(rewritten, { headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" } });
        }
        return response;
      }
    } catch { /* Fixed error prevents provider URL/credentials escaping through fetch exceptions. */ }
    throw new AppError("IPTV_STREAM_UNAVAILABLE", "This channel could not be opened. Try another channel or retry shortly.", 502);
  }
}
