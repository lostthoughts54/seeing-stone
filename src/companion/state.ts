import type { CompanionBootstrap, CompanionPlayerState, CompanionQueueState } from "../shared/companionContracts";

export class CompanionModel extends EventTarget {
  bootstrap: CompanionBootstrap | null = null;
  lastContact = 0;

  setBootstrap(value: CompanionBootstrap): void {
    this.bootstrap = value;
    this.lastContact = Date.now();
    this.dispatchEvent(new Event("change"));
  }

  apply(topic: string, payload: unknown): void {
    if (!this.bootstrap) return;
    if (topic === "player") this.bootstrap.player = payload as CompanionPlayerState;
    if (topic === "queue") this.bootstrap.queue = payload as CompanionQueueState;
    if (topic === "server" && payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      if (record.player && record.queue) this.bootstrap = payload as CompanionBootstrap;
      else if (typeof record.online === "boolean") this.bootstrap.server = { online: record.online };
    }
    this.lastContact = Date.now();
    this.dispatchEvent(new Event("change"));
  }
}
