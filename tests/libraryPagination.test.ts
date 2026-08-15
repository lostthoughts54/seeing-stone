import { describe, expect, it } from "vitest";
import {
  compactPageEntries,
  libraryPageCount,
  libraryPageStartIndex,
  LibraryPageRequestGate,
} from "../src/renderer/libraryPagination";

describe("server-side library pagination", () => {
  it("calculates first, middle, final partial, and exact-multiple pages", () => {
    expect(libraryPageStartIndex(1)).toBe(0);
    expect(libraryPageStartIndex(20)).toBe(1_140);
    expect(libraryPageCount(24_982)).toBe(417);
    expect(libraryPageCount(120)).toBe(2);
    expect(libraryPageCount(121)).toBe(3);
  });

  it("handles zero results and one-page libraries", () => {
    expect(libraryPageCount(0)).toBe(1);
    expect(libraryPageCount(1)).toBe(1);
    expect(libraryPageCount(60)).toBe(1);
  });

  it("renders nearby pages with bounded first/last entries and ellipses", () => {
    expect(compactPageEntries(20, 417)).toEqual([1, "ellipsis", 18, 19, 20, 21, 22, "ellipsis", 417]);
    expect(compactPageEntries(1, 3)).toEqual([1, 2, 3]);
  });

  it("prevents an obsolete request from controlling displayed results", () => {
    const gate = new LibraryPageRequestGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
    gate.cancel();
    expect(gate.isCurrent(second)).toBe(false);
  });
});
