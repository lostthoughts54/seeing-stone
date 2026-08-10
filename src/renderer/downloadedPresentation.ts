import type { DownloadSummary } from "../shared/contracts";

export type DownloadedFilter = "all" | "watched" | "unwatched" | "downloaded";
export type DownloadedSort = "title-ascending" | "title-descending" | "date-added-descending" | "year-descending" | "year-ascending" | "rating-descending";
export type DownloadedGroup =
  | { kind: "individual"; download: DownloadSummary }
  | { kind: "series"; seriesId: string; name: string; downloads: DownloadSummary[]; bytes: number; smart: "all" | "mixed" | "none"; seasons: number[] };

function titleCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function matches(download: DownloadSummary, filter: DownloadedFilter): boolean {
  return filter === "all" || filter === "downloaded" || filter === "watched" && download.item.userData.played || filter === "unwatched" && !download.item.userData.played;
}

function episodeCompare(left: DownloadSummary, right: DownloadSummary): number {
  const seasonLeft = left.item.parentIndexNumber ?? Number.MAX_SAFE_INTEGER;
  const seasonRight = right.item.parentIndexNumber ?? Number.MAX_SAFE_INTEGER;
  const episodeLeft = left.item.indexNumber ?? Number.MAX_SAFE_INTEGER;
  const episodeRight = right.item.indexNumber ?? Number.MAX_SAFE_INTEGER;
  return seasonLeft - seasonRight || episodeLeft - episodeRight || titleCompare(left.name, right.name) || left.downloadId.localeCompare(right.downloadId);
}

export function groupDownloadedRecords(records: DownloadSummary[], filter: DownloadedFilter, sort: DownloadedSort): DownloadedGroup[] {
  const filtered = records.filter((download) => download.state === "downloaded" && matches(download, filter));
  const bySeries = new Map<string, DownloadSummary[]>();
  const individuals: DownloadSummary[] = [];
  for (const download of filtered) {
    const seriesId = download.itemType === "Episode" ? download.item.seriesId : null;
    if (!seriesId) individuals.push(download);
    else bySeries.set(seriesId, [...(bySeries.get(seriesId) ?? []), download]);
  }
  const groups: DownloadedGroup[] = [
    ...individuals.map((download): DownloadedGroup => ({ kind: "individual", download })),
    ...[...bySeries.entries()].flatMap(([seriesId, downloads]): DownloadedGroup[] => {
      if (downloads.length === 1) return [{ kind: "individual", download: downloads[0] }];
      const sorted = [...downloads].sort(episodeCompare);
      const smartCount = sorted.filter((download) => download.smartManaged).length;
      return [{ kind: "series", seriesId, name: sorted[0].item.seriesName || sorted[0].name, downloads: sorted, bytes: sorted.reduce((sum, download) => sum + Math.max(0, download.expectedSize ?? download.bytesDownloaded), 0), smart: smartCount === sorted.length ? "all" : smartCount ? "mixed" : "none", seasons: [...new Set(sorted.map((download) => download.item.parentIndexNumber).filter((value): value is number => value !== null))].sort((a, b) => a - b) }];
    }),
  ];
  const name = (group: DownloadedGroup) => group.kind === "series" ? group.name : group.download.name;
  const year = (group: DownloadedGroup) => group.kind === "series" ? Math.max(...group.downloads.map((download) => download.item.productionYear ?? 0)) : group.download.item.productionYear ?? 0;
  const rating = (group: DownloadedGroup) => group.kind === "series" ? Math.max(...group.downloads.map((download) => download.item.communityRating ?? 0)) : group.download.item.communityRating ?? 0;
  groups.sort((left, right) => {
    if (sort === "title-descending") return -titleCompare(name(left), name(right));
    if (sort === "year-descending") return year(right) - year(left) || titleCompare(name(left), name(right));
    if (sort === "year-ascending") return (year(left) || Number.MAX_SAFE_INTEGER) - (year(right) || Number.MAX_SAFE_INTEGER) || titleCompare(name(left), name(right));
    if (sort === "rating-descending") return rating(right) - rating(left) || titleCompare(name(left), name(right));
    return titleCompare(name(left), name(right));
  });
  return groups;
}
