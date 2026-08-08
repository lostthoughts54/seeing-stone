import { shell } from "electron";

const youtubeVideoIdSchema = /^[A-Za-z0-9_-]{11}$/;
const youtubeHosts = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "www.youtube-nocookie.com",
  "youtube-nocookie.com",
]);

export function youtubeVideoId(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase();
    let candidate = "";
    if (host === "youtu.be") candidate = url.pathname.split("/").filter(Boolean)[0] ?? "";
    else if (youtubeHosts.has(host)) {
      if (url.pathname === "/watch") candidate = url.searchParams.get("v") ?? "";
      else if (/^\/(?:embed|shorts|live)\//.test(url.pathname)) candidate = url.pathname.split("/")[2] ?? "";
    }
    return youtubeVideoIdSchema.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function youtubeEmbedUrl(value: string): string | null {
  const videoId = youtubeVideoId(value);
  return videoId
    ? `https://www.youtube.com/embed/${videoId}?autoplay=1&controls=1&playsinline=1&rel=0`
    : null;
}

export interface TrailerWindowController {
  open(url: string, openExternally?: boolean): Promise<{
    mode: "embedded" | "external";
    embedUrl: string | null;
  }>;
}

export class TrailerWindowService implements TrailerWindowController {
  async open(url: string, openExternally = false): Promise<{ mode: "embedded" | "external"; embedUrl: string | null }> {
    const embedUrl = youtubeEmbedUrl(url);
    if (!embedUrl || openExternally) {
      await shell.openExternal(url);
      return { mode: "external", embedUrl: null };
    }
    return { mode: "embedded", embedUrl };
  }

  destroy(): void {}
}
