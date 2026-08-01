import { createHash } from "node:crypto";
import { networkInterfaces } from "node:os";

export interface CompanionNetworkAdapter {
  id: string;
  name: string;
  address: string;
  netmask: string;
  cidr: string;
  recommended: boolean;
}

function isRfc1918(address: string): boolean {
  const octets = address.split(".").map(Number);
  return octets.length === 4
    && (octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168));
}

function ipv4Number(value: string): number {
  return value.split(".").reduce((result, octet) => ((result << 8) | Number(octet)) >>> 0, 0);
}

export function listCompanionNetworkAdapters(): CompanionNetworkAdapter[] {
  const result: CompanionNetworkAdapter[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal || !isRfc1918(address.address)) continue;
      const id = createHash("sha256").update(`${name}\0${address.netmask}`).digest("base64url").slice(0, 22);
      result.push({
        id,
        name,
        address: address.address,
        netmask: address.netmask,
        cidr: address.cidr ?? `${address.address}/24`,
        recommended: false,
      });
    }
  }
  result.sort((left, right) => left.name.localeCompare(right.name) || left.address.localeCompare(right.address));
  if (result[0]) result[0].recommended = true;
  return result;
}

export function isAddressOnAdapter(remoteAddress: string | undefined, adapter: CompanionNetworkAdapter): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.startsWith("::ffff:") ? remoteAddress.slice(7) : remoteAddress;
  if (!isRfc1918(normalized)) return false;
  const mask = ipv4Number(adapter.netmask);
  return (ipv4Number(normalized) & mask) === (ipv4Number(adapter.address) & mask);
}

export function selectCompanionNetwork(id: string | null): CompanionNetworkAdapter | null {
  const adapters = listCompanionNetworkAdapters();
  return adapters.find((adapter) => adapter.id === id) ?? null;
}
