import { describe, expect, it } from "vitest";
import { connectionScore } from "../src/main/services/serverDiscovery";

describe("server discovery ranking", () => {
  it("prefers a physical private LAN over VPN and virtual adapters", () => {
    const ethernet = connectionScore("Ethernet", "192.168.1.20");
    expect(ethernet).toBeGreaterThan(connectionScore("Tailscale", "100.80.1.2"));
    expect(ethernet).toBeGreaterThan(connectionScore("vEthernet (WSL)", "172.20.0.1"));
    expect(ethernet).toBeGreaterThan(connectionScore("OpenVPN", "10.8.0.2"));
  });
});
