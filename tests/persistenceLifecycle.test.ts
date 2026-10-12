import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistenceRequest } from "../src/main/services/persistenceTypes";

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  worker: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ mkdir: mocks.mkdir }));
vi.mock("node:worker_threads", () => ({ Worker: mocks.worker }));

import { SqlitePersistenceService } from "../src/main/services/persistence";

class FakeWorker extends EventEmitter {
  requests: PersistenceRequest[] = [];
  postMessage = vi.fn((request: PersistenceRequest) => {
    this.requests.push(request);
    if (request.operation.kind === "initialize" || request.operation.kind === "close") {
      queueMicrotask(() => this.reply(request));
    }
  });
  terminate = vi.fn(async () => 1);

  reply(request: PersistenceRequest, result: unknown = { schemaVersion: 11 }): void {
    this.emit("message", { id: request.id, ok: true, result });
  }
}

describe("SqlitePersistenceService worker lifecycle", () => {
  let workers: FakeWorker[];
  let service: SqlitePersistenceService;

  beforeEach(() => {
    workers = [];
    mocks.mkdir.mockReset().mockResolvedValue(undefined);
    mocks.worker.mockReset().mockImplementation(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    service = new SqlitePersistenceService("test-profile", "fixture-worker.js");
  });

  afterEach(async () => {
    vi.useRealTimers();
    await service.close();
  });

  it("does not create a worker when closed during directory preparation", async () => {
    let finishDirectory!: () => void;
    mocks.mkdir.mockImplementationOnce(() => new Promise<void>((resolve) => { finishDirectory = resolve; }));
    const opening = service.open();
    const closed = expect(opening).rejects.toMatchObject({ code: "PERSISTENCE_CLOSED" });
    await service.close();
    finishDirectory();
    await closed;
    expect(mocks.worker).not.toHaveBeenCalled();
  });

  it.each(["exit", "error"])("ignores an old worker's %s after timeout recovery", async (event) => {
    vi.useFakeTimers();
    await service.open();
    const old = workers[0];
    const pending = service.health();
    const timedOut = expect(pending).rejects.toMatchObject({ code: "PERSISTENCE_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(15_000);
    await timedOut;
    expect(old.terminate).toHaveBeenCalledOnce();

    await service.open();
    const replacement = workers[1];
    const health = service.health();
    await vi.advanceTimersByTimeAsync(0);
    old.emit(event, event === "exit" ? 1 : new Error("late old-worker failure"));
    const request = replacement.requests.find((value) => value.operation.kind === "health");
    expect(request).toBeDefined();
    replacement.reply(request!, { schemaVersion: 11, ready: true });
    await expect(health).resolves.toEqual({ schemaVersion: 11, ready: true });
    expect(replacement.terminate).not.toHaveBeenCalled();
  });

  it("rejects work immediately after an unexpected successful exit and can reopen", async () => {
    await service.open();
    const pending = service.health();
    const unavailable = expect(pending).rejects.toMatchObject({ code: "PERSISTENCE_UNAVAILABLE" });
    await Promise.resolve();
    await Promise.resolve();
    workers[0].emit("exit", 0);
    await unavailable;
    await service.open();
    expect(workers).toHaveLength(2);
  });

  it("does not let a failed opening attempt terminate a replacement worker", async () => {
    mocks.worker.mockImplementationOnce(() => {
      const worker = new FakeWorker();
      worker.postMessage.mockImplementation((request) => { worker.requests.push(request); });
      workers.push(worker);
      return worker;
    });
    const first = service.open();
    const failed = expect(first).rejects.toMatchObject({ code: "PERSISTENCE_UNAVAILABLE" });
    await Promise.resolve();
    workers[0].emit("error", new Error("initialization failed"));
    const replacement = service.open();
    await failed;
    await expect(replacement).resolves.toEqual({ schemaVersion: 11 });
    expect(workers[1].terminate).not.toHaveBeenCalled();
  });
});
