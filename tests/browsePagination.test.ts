import { describe, expect, it, vi } from "vitest";
import { loadAllBrowseItems } from "../src/renderer/browsePagination";
import type { BrowsePage, BrowseQuery, MediaItem } from "../src/shared/contracts";

const query: BrowseQuery = { type: "Movie", sort: "title-ascending", startIndex: 0, limit: 2 };
const item = (id: string): MediaItem => ({ id, name: id } as MediaItem);

describe("browse pagination", () => {
  it("loads every authoritative server page without duplicating records", async () => {
    const getPage = vi.fn(async (input: BrowseQuery): Promise<BrowsePage> => ({
      items: input.startIndex === 0 ? [item("a"), item("b")]
        : input.startIndex === 2 ? [item("b"), item("c")]
          : [item("d")],
      totalRecordCount: 5,
    }));

    await expect(loadAllBrowseItems(query, getPage, () => true)).resolves.toEqual([
      item("a"), item("b"), item("c"), item("d"),
    ]);
    expect(getPage.mock.calls.map(([input]) => input.startIndex)).toEqual([0, 2, 4]);
  });

  it("stops stale queries before requesting another page", async () => {
    let current = true;
    const getPage = vi.fn(async (): Promise<BrowsePage> => {
      current = false;
      return { items: [item("a")], totalRecordCount: 2 };
    });

    await expect(loadAllBrowseItems(query, getPage, () => current)).resolves.toBeNull();
    expect(getPage).toHaveBeenCalledOnce();
  });
});
