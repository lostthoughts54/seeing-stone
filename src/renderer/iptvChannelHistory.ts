import type { IptvCatalogueItem, IptvIdentity } from "../shared/iptv";

export function sameChannel(a: IptvIdentity, b: IptvIdentity): boolean {
  return a.providerId === b.providerId && a.contentType === b.contentType && a.itemId === b.itemId;
}

export class IptvChannelHistory {
  current: IptvCatalogueItem | null = null;
  previous: IptvCatalogueItem | null = null;

  record(item: IptvCatalogueItem): void {
    if (this.current && sameChannel(this.current.identity, item.identity)) return;
    this.previous = this.current;
    this.current = { ...item, identity: { ...item.identity } };
  }
}
