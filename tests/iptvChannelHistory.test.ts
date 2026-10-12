import { describe, expect, it } from "vitest";
import { IptvChannelHistory } from "../src/renderer/iptvChannelHistory";
import type { IptvCatalogueItem } from "../src/shared/iptv";

const channel = (itemId: string, providerId = "provider-a"): IptvCatalogueItem => ({ identity: { providerId, contentType: "live", itemId }, name: itemId, groupId: null, groupName: null, channelNumber: null, favourite: false, hidden: false });
describe("last watched IPTV channel", () => {
  it("toggles between confirmed channels and preserves history on Go Live", () => {
    const history = new IptvChannelHistory();
    history.record(channel("fox"));
    expect(history.previous).toBeNull();
    history.record(channel("abc"));
    expect(history.previous?.name).toBe("fox");
    history.record(channel("abc"));
    expect(history.previous?.name).toBe("fox");
    history.record(history.previous!);
    expect(history.current?.name).toBe("fox");
    expect(history.previous?.name).toBe("abc");
    history.record(history.previous!);
    expect(history.current?.name).toBe("abc");
  });
  it("distinguishes matching channel IDs on different providers and snapshots identity", () => {
    const history = new IptvChannelHistory();
    const item = channel("1");
    history.record(item);
    item.identity.itemId = "changed";
    history.record(channel("1", "provider-b"));
    expect(history.previous?.identity).toEqual(channel("1").identity);
  });
});
