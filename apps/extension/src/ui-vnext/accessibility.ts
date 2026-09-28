const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) =>
      !element.hidden && element.getAttribute("aria-hidden") !== "true" && element.tabIndex >= 0,
  );
}

export function installFocusTrap(dialog: HTMLElement, restoreTo: HTMLElement): () => void {
  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Tab") {
      return;
    }
    const focusable = getFocusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  dialog.addEventListener("keydown", handleKeyDown);
  (getFocusableElements(dialog)[0] ?? dialog).focus();
  return () => {
    dialog.removeEventListener("keydown", handleKeyDown);
    if (restoreTo.isConnected) {
      restoreTo.focus();
    }
  };
}

export function announce(message: string): void {
  const region = document.getElementById("syncaction-live-status");
  if (region === null) {
    return;
  }
  region.textContent = "";
  queueMicrotask(() => {
    region.textContent = message;
  });
}
