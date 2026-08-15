export const LIBRARY_PAGE_SIZE = 60;

export type PaginationEntry = number | "ellipsis";

export function libraryPageCount(totalRecordCount: number, pageSize = LIBRARY_PAGE_SIZE): number {
  if (!Number.isFinite(totalRecordCount) || totalRecordCount <= 0) return 1;
  return Math.max(1, Math.ceil(Math.floor(totalRecordCount) / pageSize));
}

export function libraryPageStartIndex(page: number, pageSize = LIBRARY_PAGE_SIZE): number {
  return (Math.max(1, Math.floor(page)) - 1) * pageSize;
}

export function compactPageEntries(currentPage: number, totalPages: number, radius = 2): PaginationEntry[] {
  const last = Math.max(1, Math.floor(totalPages));
  const current = Math.min(last, Math.max(1, Math.floor(currentPage)));
  const pages = new Set<number>([1, last]);
  for (let page = Math.max(1, current - radius); page <= Math.min(last, current + radius); page += 1) pages.add(page);
  const ordered = [...pages].sort((left, right) => left - right);
  const result: PaginationEntry[] = [];
  for (const page of ordered) {
    const previous = result.at(-1);
    if (typeof previous === "number" && page - previous > 1) result.push("ellipsis");
    result.push(page);
  }
  return result;
}

/** Monotonic tokens ensure only the newest request can update a library page. */
export class LibraryPageRequestGate {
  private revision = 0;

  begin(): number {
    this.revision += 1;
    return this.revision;
  }

  isCurrent(token: number): boolean {
    return token === this.revision;
  }

  cancel(): void {
    this.revision += 1;
  }
}
