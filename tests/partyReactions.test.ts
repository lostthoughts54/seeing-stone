import { describe, expect, it } from "vitest";
import { PartyReactionFeed } from "../src/renderer/partyReactions";
import type { FeatureRoom } from "../src/shared/playerFeatures";

const message = (id: string, patch = {}) => ({ id, author: "Viewer", kind: "reaction" as const, text: "👏", createdAt: 10_000, positionTicks: null, generation: 1, ...patch });
function room(messages: FeatureRoom["messages"] = [], patch = {}): FeatureRoom {
  return { id: "room", timeline: { generation: 1 }, serverNow: 10_000, messages, ...patch } as FeatureRoom;
}
describe("party reaction feed", () => {
  it("seeds history, displays new reactions once, and suppresses history after rejoining", () => {
    const feed = new PartyReactionFeed();
    expect(feed.take(room([message("old")]))).toEqual([]);
    expect(feed.take(room([message("old"), message("new")])).map(m => m.id)).toEqual(["new"]);
    expect(feed.take(room([message("old"), message("new")]))).toEqual([]);
    feed.take(null);
    expect(feed.take(room([message("new")]))).toEqual([]);
  });
  it("filters chat, unsupported emoji, stale reconnect history and different videos", () => {
    const feed = new PartyReactionFeed(); feed.take(room());
    expect(feed.take(room([
      message("chat", { kind: "chat" }), message("text", { text: "<img>" }),
      message("stale", { createdAt: 4999 }), message("future", { createdAt: 12000 }),
      message("previous", { generation: 0 }), message("fresh"),
    ])).map(m => m.id)).toEqual(["fresh"]);
    expect(feed.take(room([message("next", { generation: 2 })], { timeline: { generation: 2 } }))).toEqual([]);
    expect(feed.take(room([message("other")], { id: "other" }))).toEqual([]);
  });
  it("limits a burst batch and remembers excess reactions without replaying them", () => {
    const feed = new PartyReactionFeed(); feed.take(room());
    const messages = Array.from({ length: 20 }, (_, i) => message(String(i)));
    expect(feed.take(room(messages))).toHaveLength(8);
    expect(feed.take(room(messages))).toEqual([]);
  });
  it("does not replay a reaction when an older poll snapshot arrives between updates", () => {
    const feed = new PartyReactionFeed(); feed.take(room());
    expect(feed.take(room([message("new")]))).toHaveLength(1);
    expect(feed.take(room())).toEqual([]);
    expect(feed.take(room([message("new")]))).toEqual([]);
  });
  it("deduplicates repeated reaction IDs in a single snapshot", () => {
    const feed = new PartyReactionFeed(); feed.take(room());
    expect(feed.take(room([message("new"), message("new")]))).toHaveLength(1);
  });
});
