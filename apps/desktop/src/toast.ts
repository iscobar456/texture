/**
 * A small notice in the bottom-right corner, with an optional action button (e.g. Undo).
 *
 * Toasts live in the top layer (a manual popover) so they stay visible above an open dialog. A modal dialog
 * makes everything outside it unclickable, though, so while one is open a toast shows without its action.
 */
let host: HTMLElement | null = null;

function container(): HTMLElement {
  if (host) return host;
  host = document.createElement("div");
  host.id = "toasts";
  host.setAttribute("popover", "manual");
  host.setAttribute("aria-live", "polite");
  document.body.append(host);
  return host;
}

export function toast(message: string, opts: { actionLabel?: string; onAction?: () => void; ms?: number } = {}) {
  const box = container();
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  const text = document.createElement("span");
  text.textContent = message;
  el.append(text);

  const modalOpen = !!document.querySelector("dialog[open]");
  const close = () => {
    el.remove();
    if (!box.children.length) box.hidePopover?.();
  };
  if (opts.actionLabel && opts.onAction && !modalOpen) {
    const a = document.createElement("button");
    a.className = "toast-action";
    a.textContent = opts.actionLabel;
    a.addEventListener("click", () => {
      close();
      opts.onAction!();
    });
    el.append(a);
  }
  const x = document.createElement("button");
  x.className = "toast-close";
  x.setAttribute("aria-label", "Dismiss");
  x.textContent = "×";
  x.addEventListener("click", close);
  el.append(x);

  box.append(el);
  try { box.showPopover?.(); } catch {} // already showing is fine
  window.setTimeout(close, opts.ms ?? 7000);
}
