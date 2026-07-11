const dgram = require("node:dgram");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);
const DISCOVERY_PORT = 7359;
const DISCOVERY_MESSAGE = Buffer.from("Who is JellyfinServer?");
const DISCOVERY_WINDOW_MS = 1600;

const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);

function ipv4ToInt(address) {
  return address
    .split(".")
    .reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function intToIpv4(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
}

function networkTargets() {
  const targets = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      const isIpv4 = entry.family === "IPv4" || entry.family === 4;
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
  targets.push({
    bindAddress: "0.0.0.0",
    broadcastAddress: "255.255.255.255",
    netmask: "0.0.0.0",
    name: "Default network",
  });
  return targets;
}

function normalizeAddress(address, remoteAddress) {
  try {
    const candidate = address.includes("://") ? address : `http://${address}`;
    const url = new URL(candidate);
    if (url.protocol === "http:" || ["0.0.0.0", "127.0.0.1", "localhost"].includes(url.hostname)) {
      url.hostname = remoteAddress;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function connectionScore(networkName, remoteAddress) {
  const name = networkName.toLowerCase();
  let score = 50;
  const isPrivate = /^10\./.test(remoteAddress)
    || /^192\.168\./.test(remoteAddress)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(remoteAddress);
  if (isPrivate) score += 20;
  if (/tailscale/.test(name) || /^100\.(6[4-9]|[78]\d|9[0-9]|1[01]\d|12[0-7])\./.test(remoteAddress)) score -= 10;
  if (/vpn|openvpn|wintun|wireguard|pia/.test(name)) score -= 25;
  if (/vethernet|wsl|hyper-v|default switch|virtualbox|vmware/.test(name)) {
    score -= 35;
  } else if (/ethernet|wi-fi|wifi|wlan|^eth\d|^en\d/.test(name)) {
    score += 25;
  }
  if (networkName === "Default network") score -= 15;
  return score;
}

function parseDiscoveryReply(message, remoteAddress, target) {
  try {
    const reply = JSON.parse(message.toString("utf8"));
    const address = normalizeAddress(String(reply.Address || ""), remoteAddress);
    if (!address) return null;
    return {
      address,
      id: String(reply.Id || ""),
      name: String(reply.Name || "Jellyfin Server"),
      endpointAddress: reply.EndpointAddress || remoteAddress,
      network: target.name,
      score: connectionScore(target.name, remoteAddress),
      source: "udp",
    };
  } catch {
    return null;
  }
}

async function probeServer(address, metadata, timeoutMs = 700) {
  try {
    const response = await fetch(`${address}/System/Info/Public`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const info = await response.json();
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

function isPhysicalNetwork(name) {
  const normalized = name.toLowerCase();
  if (/tailscale|vpn|openvpn|wintun|wireguard|pia|vethernet|wsl|hyper-v|virtualbox|vmware/.test(normalized)) {
    return false;
  }
  return /ethernet|wi-fi|wifi|wlan|^eth\d|^en\d/.test(normalized);
}

function lanProbeTargets() {
  const probes = new Map();
  for (const network of networkTargets()) {
    if (!isPhysicalNetwork(network.name)) continue;
    let networkAddress = ipv4ToInt(network.bindAddress) & ipv4ToInt(network.netmask);
    let broadcastAddress = networkAddress | (~ipv4ToInt(network.netmask) >>> 0);

    // Keep fallback discovery bounded even on unusually large local subnets.
    if (broadcastAddress - networkAddress > 255) {
      networkAddress = ipv4ToInt(network.bindAddress) & 0xffffff00;
      broadcastAddress = networkAddress + 255;
    }

    for (let host = networkAddress + 1; host < broadcastAddress; host += 1) {
      const hostAddress = intToIpv4(host >>> 0);
      probes.set(hostAddress, {
        address: `http://${hostAddress}:8096`,
        network: network.name,
        score: 90,
        source: "lan-scan",
      });
    }
  }
  return [...probes.values()];
}

async function scanLanServers() {
  const targets = lanProbeTargets();
  const servers = [];
  let nextIndex = 0;
  const workerCount = Math.min(48, targets.length);

  async function worker() {
    while (nextIndex < targets.length) {
      const target = targets[nextIndex];
      nextIndex += 1;
      const server = await probeServer(target.address, target, 450);
      if (server) servers.push(server);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return servers;
}

function discoverOnNetwork(target) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const servers = [];
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      socket.close();
      resolve(servers);
    };

    socket.on("message", (message, remote) => {
      const server = parseDiscoveryReply(message, remote.address, target);
      if (!server) return;
      servers.push(server);
    });
    socket.on("error", finish);

    socket.bind(0, target.bindAddress, () => {
      try {
        socket.setBroadcast(true);
        socket.send(DISCOVERY_MESSAGE, DISCOVERY_PORT, target.broadcastAddress);
      } catch {
        finish();
      }
    });

    setTimeout(finish, DISCOVERY_WINDOW_MS);
  });
}

async function discoverUdpServers() {
  const replies = (await Promise.all(networkTargets().map(discoverOnNetwork))).flat();
  const preferred = new Map();
  for (const server of replies) {
    const key = server.id || server.address;
    const current = preferred.get(key);
    if (!current || server.score > current.score) preferred.set(key, server);
  }
  return [...preferred.values()].sort((a, b) => b.score - a.score);
}

async function discoverServers() {
  const [udpServers, lanServers, localServer] = await Promise.all([
    discoverUdpServers(),
    scanLanServers(),
    probeServer("http://127.0.0.1:8096", { score: 10, source: "localhost" }, 900),
  ]);
  const servers = new Map();
  for (const server of [...udpServers, ...lanServers, localServer].filter(Boolean)) {
    const key = server.id || server.address;
    const current = servers.get(key);
    if (!current || server.score > current.score) servers.set(key, server);
  }
  return [...servers.values()].sort((a, b) => b.score - a.score);
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function serveStatic(response, filename, contentType) {
  fs.readFile(path.join(__dirname, filename), (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      "Content-Type": contentType,
    });
    response.end(data);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);

  if (request.method === "GET" && url.pathname === "/api/discover") {
    try {
      const servers = await discoverServers();
      sendJson(response, 200, { servers });
    } catch (error) {
      sendJson(response, 500, { error: error.message, servers: [] });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/favicon.ico") {
    response.writeHead(204, { "Cache-Control": "public, max-age=86400" });
    response.end();
    return;
  }

  const staticFile = request.method === "GET" ? staticFiles.get(url.pathname) : null;
  if (staticFile) {
    serveStatic(response, staticFile[0], staticFile[1]);
    return;
  }

  response.writeHead(404);
  response.end("Not found");
});

server.listen(PORT, HOST, () => {
  console.log(`LocalFirst Jellyfin is running at http://${HOST}:${PORT}`);
});
