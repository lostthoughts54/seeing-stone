import { createConnection, type Socket } from "node:net";

export interface MpvMessage {
  event?: string;
  name?: string;
  data?: unknown;
  id?: number;
  args?: unknown[];
  reason?: string;
  request_id?: number;
  error?: string;
}

export class MpvIpcClient {
  private socket: Socket | null = null;
  private buffer = "";
  private requestId = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private listeners = new Set<(message: MpvMessage) => void>();

  async connect(pipePath: string, timeoutMilliseconds = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMilliseconds;
    while (Date.now() < deadline) {
      try {
        const socket = await new Promise<Socket>((resolve, reject) => {
          const candidate = createConnection(pipePath);
          const failed = (error: Error) => {
            candidate.destroy();
            reject(error);
          };
          candidate.once("error", failed);
          candidate.once("connect", () => {
            candidate.removeListener("error", failed);
            resolve(candidate);
          });
        });
        this.socket = socket;
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => this.consume(String(chunk)));
        socket.on("close", () => this.rejectPending("mpv IPC closed."));
        socket.on("error", () => this.rejectPending("mpv IPC failed."));
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error("Timed out connecting to mpv IPC.");
  }

  onMessage(listener: (message: MpvMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async command(command: unknown[]): Promise<unknown> {
    if (!this.socket || this.socket.destroyed) throw new Error("mpv IPC is unavailable.");
    const requestId = ++this.requestId;
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(requestId, { resolve, reject }));
    this.socket.write(`${JSON.stringify({ command, request_id: requestId })}\n`);
    return result;
  }

  async observe(id: number, property: string): Promise<void> {
    await this.command(["observe_property", id, property]);
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
    this.rejectPending("mpv IPC closed.");
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: MpvMessage;
      try { message = JSON.parse(line) as MpvMessage; } catch { continue; }
      if (typeof message.request_id === "number") {
        const pending = this.pending.get(message.request_id);
        if (pending) {
          this.pending.delete(message.request_id);
          if (message.error && message.error !== "success") pending.reject(new Error(`mpv command failed: ${message.error}`));
          else pending.resolve(message.data);
        }
      }
      for (const listener of this.listeners) listener(message);
    }
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) pending.reject(new Error(message));
    this.pending.clear();
  }
}
