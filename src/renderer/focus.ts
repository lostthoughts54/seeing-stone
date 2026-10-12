/** Keep keyboard focus inside the visible dialog, including after controls disappear. */
export function trapDialogFocus(event: KeyboardEvent, dialog: HTMLElement): void {
  if (event.key !== "Tab") return;
  const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
    "button, input, select, textarea, a[href], iframe, summary, [tabindex]",
  )).filter((element) => element.tabIndex >= 0 && !element.matches(":disabled")
    && !element.closest("[inert], [hidden], .is-hidden") && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== "hidden");
  const first = controls[0];
  const last = controls.at(-1);
  const current = document.activeElement;
  if (!first || !last) {
    event.preventDefault();
    dialog.tabIndex = -1;
    dialog.focus();
  } else if (!controls.includes(current as HTMLElement) || (event.shiftKey ? current === first : current === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

export function restoreVisibleFocus(preferred: HTMLElement | null, fallback?: HTMLElement): void {
  const target = preferred?.isConnected && preferred.getClientRects().length
    && !preferred.matches(":disabled") && !preferred.closest("[inert], [hidden], .is-hidden")
    ? preferred : fallback;
  target?.focus({ preventScroll: true });
}

export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || Boolean(target.closest("input, select, textarea, [role='textbox']")));
}
