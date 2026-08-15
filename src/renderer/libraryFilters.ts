import type { BrowseQuery, BrowseSort, MediaItem } from "../shared/contracts";

export type FilterMatchMode = "any" | "all";
export type LibraryQuickFilter = "unplayed" | "in-progress" | "played" | "favorite" | "recently-added";
export type TechnicalFilter = "4k" | "1080p" | "720p" | "hdr" | "hdr10" | "hdr10plus" | "dolby-vision" | "h264" | "hevc" | "av1";

export interface MultiValueFilter<T extends string = string> {
  included: T[];
  /** Reserved for a future exclusion UI. Exclusions are already evaluated. */
  excluded: T[];
  match: FilterMatchMode;
}

export interface NumericRangeFilter {
  min: number | null;
  max: number | null;
}

export interface LibraryFilterState {
  quick: MultiValueFilter<LibraryQuickFilter>;
  genres: MultiValueFilter;
  people: MultiValueFilter;
  officialRatings: MultiValueFilter;
  technical: MultiValueFilter<TechnicalFilter>;
  premiereYear: NumericRangeFilter;
  communityRating: NumericRangeFilter;
  runtimeMinutes: NumericRangeFilter;
}

export interface LibraryFilterOption {
  value: string;
  label: string;
  count: number;
  detail?: string;
}

export interface LibraryFilterOptions {
  genres: LibraryFilterOption[];
  people: LibraryFilterOption[];
  officialRatings: LibraryFilterOption[];
  technical: LibraryFilterOption[];
}

export interface LibraryFilterQueryTranslation {
  query: BrowseQuery;
  unsupported: string[];
  alwaysEmpty: boolean;
}

export function createLibraryFilterState(): LibraryFilterState {
  return {
    quick: { included: [], excluded: [], match: "any" },
    genres: { included: [], excluded: [], match: "any" },
    people: { included: [], excluded: [], match: "any" },
    officialRatings: { included: [], excluded: [], match: "any" },
    technical: { included: [], excluded: [], match: "any" },
    premiereYear: { min: null, max: null },
    communityRating: { min: null, max: null },
    runtimeMinutes: { min: null, max: null },
  };
}

/** Keeps API request construction independent from drawer state and rendering. */
export function libraryFiltersToBrowseQuery(
  libraryId: string,
  type: "Movie" | "Series" | "Mixed",
  sort: BrowseSort,
  filters: LibraryFilterState,
  startIndex: number,
  limit: number,
): LibraryFilterQueryTranslation {
  const query: BrowseQuery = { libraryId, type, sort, startIndex, limit };
  const unsupported: string[] = [];
  let alwaysEmpty = false;
  const multiExclusions = [filters.quick, filters.genres, filters.people, filters.officialRatings, filters.technical]
    .some((filter) => filter.excluded.length > 0);
  if (multiExclusions) unsupported.push("Excluded values");

  const quick = filters.quick.included;
  if (filters.quick.match === "any" && quick.length > 1) unsupported.push("Any-selected Quick Filters");
  else {
    if (quick.includes("played") && quick.includes("unplayed")) alwaysEmpty = true;
    if (quick.includes("played")) query.watched = true;
    if (quick.includes("unplayed")) query.watched = false;
    if (quick.includes("in-progress")) query.resumable = true;
    if (quick.includes("favorite")) query.favorite = true;
    if (quick.includes("recently-added")) unsupported.push("Recently added");
  }

  if (filters.genres.match === "all" && filters.genres.included.length > 1) unsupported.push("All-selected Genres");
  else if (filters.genres.included.length) query.genres = filters.genres.included;
  if (filters.people.match === "all" && filters.people.included.length > 1) unsupported.push("All-selected People");
  else if (filters.people.included.length) query.personIds = filters.people.included;
  if (filters.officialRatings.match === "all" && filters.officialRatings.included.length > 1) alwaysEmpty = true;
  else if (filters.officialRatings.included.length) query.officialRatings = filters.officialRatings.included;

  if (filters.premiereYear.min !== null) query.minPremiereDate = new Date(Date.UTC(filters.premiereYear.min, 0, 1)).toISOString();
  if (filters.premiereYear.max !== null) query.maxPremiereDate = new Date(Date.UTC(filters.premiereYear.max, 11, 31, 23, 59, 59, 999)).toISOString();
  if (filters.communityRating.min !== null) query.minCommunityRating = filters.communityRating.min;
  if (filters.communityRating.max !== null) unsupported.push("Maximum community rating");
  if (filters.runtimeMinutes.min !== null || filters.runtimeMinutes.max !== null) unsupported.push("Runtime range");

  const technical = filters.technical.included;
  if (technical.length === 1 && technical[0] === "4k") query.is4K = true;
  else if (technical.length) unsupported.push("Selected technical filters");
  return { query, unsupported: [...new Set(unsupported)], alwaysEmpty };
}

function matchesValues(values: string[], filter: MultiValueFilter): boolean {
  const normalized = new Set(values.map((value) => value.toLocaleLowerCase()));
  const included = filter.included.map((value) => value.toLocaleLowerCase());
  const excluded = filter.excluded.map((value) => value.toLocaleLowerCase());
  if (excluded.some((value) => normalized.has(value))) return false;
  if (!included.length) return true;
  return filter.match === "all"
    ? included.every((value) => normalized.has(value))
    : included.some((value) => normalized.has(value));
}

function matchesRange(value: number | null, range: NumericRangeFilter): boolean {
  if (range.min === null && range.max === null) return true;
  if (value === null || !Number.isFinite(value)) return false;
  return (range.min === null || value >= range.min) && (range.max === null || value <= range.max);
}

export function technicalValues(item: MediaItem): TechnicalFilter[] {
  const found = new Set<TechnicalFilter>();
  for (const version of item.mediaVersions ?? []) {
    const height = version.height ?? 0;
    if (height >= 2000) found.add("4k");
    else if (height >= 1000) found.add("1080p");
    else if (height >= 650) found.add("720p");
    const codec = (version.videoCodec ?? "").toLocaleLowerCase().replace(/[.\-_ ]/g, "");
    if (codec === "h264" || codec === "avc") found.add("h264");
    if (codec === "hevc" || codec === "h265") found.add("hevc");
    if (codec === "av1") found.add("av1");
    const range = (version.videoRange ?? "").toLocaleLowerCase().replace(/[.\-_ ]/g, "");
    if (range && range !== "sdr") found.add("hdr");
    if (range.includes("hdr10plus")) found.add("hdr10plus");
    else if (range.includes("hdr10")) found.add("hdr10");
    if (range.includes("dovi") || range.includes("dolbyvision")) found.add("dolby-vision");
  }
  return [...found];
}

function quickValues(item: MediaItem, now: number): LibraryQuickFilter[] {
  const values: LibraryQuickFilter[] = [];
  if (item.userData.played) values.push("played");
  else values.push("unplayed");
  if (!item.userData.played && item.userData.playbackPositionTicks > 0) values.push("in-progress");
  if (item.userData.favorite) values.push("favorite");
  if (item.dateCreated && now - Date.parse(item.dateCreated) <= 30 * 86_400_000) values.push("recently-added");
  return values;
}

export function matchesLibraryFilters(item: MediaItem, state: LibraryFilterState, now = Date.now()): boolean {
  const people = (item.people ?? []).map((person) => person.id);
  const runtimeMinutes = item.runTimeTicks > 0 ? item.runTimeTicks / 600_000_000 : null;
  return matchesValues(quickValues(item, now), state.quick)
    && matchesValues(item.genres, state.genres)
    && matchesValues(people, state.people)
    && matchesValues(item.officialRating ? [item.officialRating] : [], state.officialRatings)
    && matchesValues(technicalValues(item), state.technical)
    && matchesRange(item.premiereYear ?? item.productionYear, state.premiereYear)
    && matchesRange(item.communityRating, state.communityRating)
    && matchesRange(runtimeMinutes, state.runtimeMinutes);
}

export function activeLibraryFilterCount(state: LibraryFilterState): number {
  return state.quick.included.length + state.genres.included.length + state.people.included.length
    + state.officialRatings.included.length + state.technical.included.length
    + Number(state.premiereYear.min !== null) + Number(state.premiereYear.max !== null)
    + Number(state.communityRating.min !== null) + Number(state.communityRating.max !== null)
    + Number(state.runtimeMinutes.min !== null) + Number(state.runtimeMinutes.max !== null);
}

export function deriveLibraryFilterOptions(items: MediaItem[]): LibraryFilterOptions {
  const count = (values: Array<{ value: string; label: string; detail?: string }>): LibraryFilterOption[] => {
    const found = new Map<string, LibraryFilterOption>();
    for (const value of values) {
      const current = found.get(value.value);
      if (current) current.count += 1;
      else found.set(value.value, { ...value, count: 1 });
    }
    return [...found.values()].sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));
  };
  const technicalLabels: Record<TechnicalFilter, string> = {
    "4k": "4K", "1080p": "1080p", "720p": "720p", hdr: "HDR", hdr10: "HDR10",
    hdr10plus: "HDR10+", "dolby-vision": "Dolby Vision", h264: "H.264", hevc: "HEVC", av1: "AV1",
  };
  return {
    genres: count(items.flatMap((item) => item.genres.map((genre) => ({ value: genre, label: genre })))),
    people: count(items.flatMap((item) => (item.people ?? []).map((person) => ({
      value: person.id, label: person.name, detail: [person.type, person.role].filter(Boolean).join(" · "),
    })))),
    officialRatings: count(items.flatMap((item) => item.officialRating ? [{ value: item.officialRating, label: item.officialRating }] : [])),
    technical: count(items.flatMap((item) => technicalValues(item).map((value) => ({ value, label: technicalLabels[value] })))),
  };
}
