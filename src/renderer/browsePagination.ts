import type { BrowsePage, BrowseQuery, MediaItem } from "../shared/contracts";

const MAX_BROWSE_RESULTS = 100_000;

export async function loadAllBrowseItems(
  query: BrowseQuery,
  getPage: (pageQuery: BrowseQuery) => Promise<BrowsePage>,
  isCurrent: () => boolean,
): Promise<MediaItem[] | null> {
  const items = new Map<string, MediaItem>();
  let startIndex = query.startIndex;
  let totalRecordCount = Number.MAX_SAFE_INTEGER;

  while (startIndex <= MAX_BROWSE_RESULTS && startIndex < totalRecordCount && items.size < MAX_BROWSE_RESULTS) {
    if (!isCurrent()) return null;
    const page = await getPage({ ...query, startIndex });
    if (!isCurrent()) return null;
    totalRecordCount = Math.min(MAX_BROWSE_RESULTS, Math.max(0, page.totalRecordCount));
    for (const item of page.items) items.set(item.id, item);
    if (!page.items.length) break;
    startIndex += page.items.length;
  }

  return [...items.values()];
}
