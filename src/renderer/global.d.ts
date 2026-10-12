import type { JellyfinBridge } from "../shared/contracts";

declare global {
  interface Window {
    iptv: import("../shared/iptv").IptvAccountBridge;
    jellyfin: JellyfinBridge;
  }
}

export {};
