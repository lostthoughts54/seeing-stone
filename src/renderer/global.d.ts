import type { JellyfinBridge } from "../shared/contracts";

declare global {
  interface Window {
    jellyfin: JellyfinBridge;
  }
}

export {};
