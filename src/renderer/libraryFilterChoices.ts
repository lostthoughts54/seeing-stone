import type { FilterChoice, FilterChoicePage } from "../shared/contracts";
export type { FilterChoice } from "../shared/contracts";

/** A lazy, searchable list of library-wide choices; it never derives values from a media page. */
export function createLibraryFilterChoices(options: {
  label: string;
  selected: () => string[];
  known: Map<string, FilterChoice>;
  load: (query: string, startIndex: number) => Promise<FilterChoicePage>;
  change: (value: string, checked: boolean) => void;
}): { element: HTMLElement; activate: () => void; dispose: () => void } {
  const element = document.createElement("div");
  const search = document.createElement("input");
  const selection = document.createElement("div");
  const list = document.createElement("div");
  const status = document.createElement("p");
  const more = document.createElement("button");
  const retry = document.createElement("button");
  search.type = "search";
  search.className = "filter-search";
  search.placeholder = `Search ${options.label.toLowerCase()}`;
  search.setAttribute("aria-label", `Search ${options.label.toLowerCase()} in this library`);
  search.maxLength = 100;
  selection.className = "filter-choice-selection";
  list.className = "filter-option-list";
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", options.label);
  status.className = "filter-empty";
  status.setAttribute("role", "status");
  more.type = retry.type = "button";
  more.textContent = "Load more";
  more.setAttribute("aria-label", `Load more ${options.label.toLowerCase()}`);
  retry.textContent = "Try again";
  more.hidden = retry.hidden = true;
  element.append(search, selection, list, status, more, retry);

  let disposed = false;
  let started = false;
  let generation = 0;
  let query = "";
  let nextStartIndex: number | null = null;
  let retryStartIndex = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let values: FilterChoice[] = [];

  const createChoice = (choice: FilterChoice): HTMLElement => {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    const copy = document.createElement("span");
    label.className = "filter-option";
    checkbox.type = "checkbox";
    checkbox.dataset.filterValue = choice.value;
    checkbox.checked = options.selected().includes(choice.value);
    copy.textContent = choice.label;
    if (choice.detail) {
      const detail = document.createElement("small");
      detail.textContent = choice.detail;
      copy.append(detail);
    }
    checkbox.addEventListener("change", () => {
      if (checkbox.checked && options.selected().length >= 32 && !options.selected().includes(choice.value)) {
        checkbox.checked = false;
        status.textContent = `Select up to 32 ${options.label.toLowerCase()} at a time.`;
        return;
      }
      options.change(choice.value, checkbox.checked);
      // Keep the active checkbox in place; other views may show the same selection.
      for (const input of element.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) {
        input.checked = options.selected().includes(input.dataset.filterValue ?? "");
      }
      if (!checkbox.checked && selection.contains(checkbox)) {
        renderSelection();
        search.focus({ preventScroll: true });
      }
    });
    label.append(checkbox, copy);
    if (choice.count !== null && choice.count !== undefined) {
      const count = document.createElement("span");
      count.className = "filter-option-count";
      count.textContent = choice.count.toLocaleString();
      count.title = "Matching titles in this library";
      label.append(count);
    }
    return label;
  };

  const renderSelection = (): void => {
    const visible = new Set(values.map(choice => choice.value));
    const retained = options.selected().filter(value => !visible.has(value));
    const focused = document.activeElement instanceof HTMLInputElement && selection.contains(document.activeElement)
      ? document.activeElement.dataset.filterValue : undefined;
    for (const label of selection.querySelectorAll<HTMLElement>(".filter-option")) {
      if (!retained.includes(label.querySelector<HTMLInputElement>("input")?.dataset.filterValue ?? "")) label.remove();
    }
    let heading = selection.querySelector("p");
    if (retained.length && !heading) {
      heading = document.createElement("p");
      heading.className = "filter-empty";
      heading.textContent = "Selected";
      selection.prepend(heading);
    } else if (!retained.length) heading?.remove();
    const existing = new Set(Array.from(selection.querySelectorAll<HTMLInputElement>("input")).map(input => input.dataset.filterValue));
    for (const value of retained) {
      if (!existing.has(value)) selection.append(createChoice(options.known.get(value) ?? { value, label: value }));
    }
    if (focused && !retained.includes(focused)) {
      (Array.from(list.querySelectorAll<HTMLInputElement>("input")).find(input => input.dataset.filterValue === focused) ?? search).focus({ preventScroll: true });
    }
  };

  const load = async (startIndex: number): Promise<void> => {
    if (disposed) return;
    const request = ++generation;
    const activeTrigger = document.activeElement === more ? more : document.activeElement === retry ? retry : null;
    retryStartIndex = startIndex;
    more.disabled = retry.disabled = true;
    list.setAttribute("aria-busy", "true");
    status.textContent = startIndex ? "Loading more…" : options.label === "People"
      ? "Loading people from this library. The first search may take a moment…"
      : `Loading ${options.label.toLowerCase()}…`;
    try {
      const page = await options.load(query, startIndex);
      if (disposed || request !== generation) return;
      const loadedValues = new Set(values.map(choice => choice.value));
      const additions = page.items.filter(choice => {
        if (loadedValues.has(choice.value)) return false;
        loadedValues.add(choice.value);
        return true;
      });
      for (const choice of page.items) options.known.set(choice.value, choice);
      values.push(...additions);
      list.append(...additions.map(createChoice));
      renderSelection();
      nextStartIndex = page.nextStartIndex;
      more.hidden = nextStartIndex === null;
      retry.hidden = true;
      status.textContent = values.length
        ? `${values.length.toLocaleString()} ${options.label.toLowerCase()}${nextStartIndex !== null ? " loaded" : " found"}`
        : query ? `No ${options.label.toLowerCase()} match "${query}" in this library.` : `No ${options.label.toLowerCase()} are available in this library.`;
    } catch (error) {
      if (disposed || request !== generation) return;
      const reason = error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "";
      status.textContent = `Could not load ${options.label.toLowerCase()}. Your selections are kept.${reason ? ` ${reason}` : ""}`;
      retry.hidden = false;
      more.hidden = true;
    } finally {
      if (!disposed && request === generation) {
        more.disabled = retry.disabled = false;
        list.setAttribute("aria-busy", "false");
        if (activeTrigger && (document.activeElement === document.body || document.activeElement === activeTrigger)) {
          (retry.hidden ? (more.hidden ? search : more) : retry).focus({ preventScroll: true });
        }
      }
    }
  };

  search.addEventListener("input", () => {
    if (timer) clearTimeout(timer);
    generation += 1;
    query = search.value.trim();
    values = [];
    list.replaceChildren();
    renderSelection();
    more.hidden = retry.hidden = true;
    status.textContent = "Searching…";
    timer = setTimeout(() => { timer = undefined; void load(0); }, query ? 250 : 0);
  });
  more.addEventListener("click", () => { if (nextStartIndex !== null && !more.disabled) void load(nextStartIndex); });
  retry.addEventListener("click", () => { if (!retry.disabled) void load(retryStartIndex); });
  renderSelection();
  return {
    element,
    activate: () => { if (!started && !disposed) { started = true; void load(0); } },
    dispose: () => { disposed = true; generation += 1; if (timer) clearTimeout(timer); },
  };
}
