import dgram from "node:dgram";
import os from "node:os";
import type { DiscoveredServer } from "../../shared/contracts";

const DISCOVERY_PORT = 7359;
const DISCOVERY_MESSAGE = Buffer.from("Who is JellyfinServer?");
const DISCOVERY_WINDOW_MS = 1600;

interface NetworkTarget {
  bindAddress: string;
  broadcastAddress: string;
  netmask: string;
  name: string;
}

interface DiscoveryCandidate extends DiscoveredServer {}

function ipv4ToInt(address: string): number {
  return address.split(".").reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function intToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
}

export function networkTargets(interfaces = os.networkInterfaces()): NetworkTarget[] {
  const targets: NetworkTarget[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      const isIpv4 = entry.family === "IPv4";
      if (!isIpv4 || entry.internal || !entry.netmask) continue;
      const address = ipv4ToInt(entry.address);
      const netmask = ipv4ToInt(entry.netmask);
      targets.push({
        bindAddress: entry.address,
        broadcastAddress: intToIpv4((address & netmask) | (~netmask >>> 0)),
        netmask: entry.netmask,
        name,
      });
    }
  }
  targets.push({ bindAddress: "0.0.0.0", broadcastAddress: "255.255.255.255", netmask: "0.0.0.0", name: "Default network" });
  return targets;
}

function normalizeAddress(address: string, remoteAddress: string): string {
  try {
    const url = new URL(address.includes("://") ? address : `http://${address}`);
    if (url.protocol === "http:" || ["0.0.0.0", "127.0.0.1", "localhost"].includes(url.hostname)) url.hostname = remoteAddress;
    if (!['http:', 'https:'].includes(url.protocol)) return "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function connectionScore(networkName: string, remoteAddress: string): number {
  const name = networkName.toLowerCase();
  let score = 50;
  const isPrivate = /^10\./.test(remoteAddress) || /^192\.168\./.test(remoteAddress) || /^172\.(1[6-9]|2\d|3[01])\./.test(remoteAddress);
  if (isPrivate) score += 20;
  if (/tailscale/.test(name) || /^100\.(6[4-9]|[78]\d|9[0-9]|1[01]\d|12[0-7])\./.test(remoteAddress)) score -= 10;
  if (/vpn|openvpn|wintun|wireguard|pia/.test(name)) score -= 25;
  if (/vethernet|wsl|hyper-v|default switch|virtualbox|vmware/.test(name)) score -= 35;
  else if (/ethernet|wi-fi|wifi|wlan|^eth\d|^en\d/.test(name)) score += 25;
  if (networkName === "Default network") score -= 15;
  return score;
}

function parseDiscoveryReply(message: Buffer, remoteAddress: string, target: NetworkTarget): DiscoveryCandidate | null {
  try {
    const reply = JSON.parse(message.toString("utf8")) as Record<string, unknown>;
    const address = normalizeAddress(String(reply.Address || ""), remoteAddress);
    if (!address) return null;
    return {
      address,
      id: String(reply.Id || ""),
      name: String(reply.Name || "Jellyfin Server"),
      version: String(reply.Version || ""),
      endpointAddress: String(reply.EndpointAddress || remoteAddress),
      network: target.name,
      score: connectionScore(target.name, remoteAddress),
      source: "udp",
    };
  } catch {
    return null;
  }
}

async function probeServer(address: string, metadata: Omit<DiscoveryCandidate, "address" | "id" | "name" | "version" | "endpointAddress">, timeoutMs = 700): Promise<DiscoveryCandidate | null> {
  try {
    const response = await fetch(`${address}/System/Info/Public`, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    if (!response.ok) return null;
    const info = await response.json() as Record<string, unknown>;
    return {
      address,
      id: String(info.Id || ""),
      name: String(info.ServerName || "Jellyfin Server"),
      version: String(info.Version || ""),
      endpointAddress: new URL(address).hostname,
      ...metadata,
    };
  } catch {
    return null;
  }
}

function isPhysicalNetwork(name: string): boolean {
  const normalized = name.toLowerCase();
  if (/tailscale|vpn|openvpn|wintun|wireguard|pia|vethernet|wsl|hyper-v|virtualbox|vmware/.test(normalized)) return false;
  return /ethernet|wi-fi|wifi|wlan|^eth\d|^en\d/.test(normalized);
}

function lanProbeTargets(): Array<{ address: string; network: string; score: number; source: "lan-scan" }> {
  const probes = new Map<string, { address: string; network: string; score: number; source: "lan-scan" }>();
  for (const network of networkTargets()) {
    if (!isPhysicalNetwork(network.name)) continue;
    let networkAddress = ipv4ToInt(network.bindAddress) & ipv4ToInt(network.netmask);
    let broadcastAddress = networkAddress | (~ipv4ToInt(network.netmask) >>> 0);
    if (broadcastAddress - networkAddress > 255) {
      networkAddress = ipv4ToInt(network.bindAddress) & 0xffffff00;
      broadcastAddress = networkAddress + 255;
    }
    for (let host = networkAddress + 1; host < broadcastAddress; host += 1) {
      const hostAddress = intToIpv4(host >>> 0);
      probes.set(hostAddress, { address: `http://${hostAddress}:8096`, network: network.name, score: 90, source: "lan-scan" });
    }
  }
  return [...probes.values()];
}

async function scanLanServers(): Promise<DiscoveryCandidate[]> {
  const targets = lanProbeTargets();
  const servers: DiscoveryCandidate[] = [];
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < targets.length) {
      const target = targets[nextIndex++];
      const server = await probeServer(target.address, target, 450);
      if (server) servers.push(server);
    }
  }
  await Promise.all(Array.from({ length: Math.min(48, targets.length) }, worker));
  return servers;
}

function discoverOnNetwork(target: NetworkTarget): Promise<DiscoveryCandidate[]> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const servers: DiscoveryCandidate[] = [];
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      socket.close();
      resolve(servers);
    };
    socket.on("message", (message, remote) => {
      const server = parseDiscoveryReply(message, remote.address, target);
      if (server) servers.push(server);
    });
    socket.on("error", finish);
    socket.bind(0, target.bindAddress, () => {
      try {
        socket.setBroadcast(true);
        socket.send(DISCOVERY_MESSAGE, DISCOVERY_PORT, target.broadcastAddress);
      } catch { finish(); }
    });
    setTimeout(finish, DISCOVERY_WINDOW_MS);
  });
}

async function discoverUdpServers(): Promise<DiscoveryCandidate[]> {
  const replies = (await Promise.all(networkTargets().map(discoverOnNetwork))).flat();
  return deduplicate(replies);
}

function deduplicate(candidates: Array<DiscoveryCandidate | null>): DiscoveryCandidate[] {
  const servers = new Map<string, DiscoveryCandidate>();
  for (const server of candidates) {
    if (!server) continue;
    const key = server.id || server.address;
    const current = servers.get(key);
    if (!current || server.score > current.score) servers.set(key, server);
  }
  return [...servers.values()].sort((a, b) => b.score - a.score);
}

export async function discoverServers(): Promise<DiscoveredServer[]> {
  const [udpServers, lanServers, localServer] = await Promise.all([
    discoverUdpServers(),
    scanLanServers(),
    probeServer("http://127.0.0.1:8096", { score: 10, source: "localhost", network: "Localhost" }, 900),
  ]);
  return deduplicate([...udpServers, ...lanServers, localServer]);
}
