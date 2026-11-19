import { showKey } from "./completions";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * The header menu: opens from its button, is keyboard operable (arrows, Home/End, type-ahead, Escape returns focus
 * to the button) and closes on any item or a click elsewhere. `focusEditor` puts the caret back in the editor after
 * an item that did not open a dialog.
 */
export function initMenu(focusEditor: () => void) {
  const menuList = $("menu-list");
  const menuButton = $<HTMLButtonElement>("menu-button");
  const menuItems = () => [...menuList.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')];

  // Shortcut hints come from the same key names the editor uses, so they read ⌘ on a Mac.
  document.querySelectorAll<HTMLElement>("#menu-list kbd[data-key]").forEach((k) => {
    k.textContent = showKey(k.dataset.key!).split("-").join("+");
  });

  function setMenu(open: boolean, focusFirst = false) {
    const hadFocus = menuList.contains(document.activeElement);
    menuList.hidden = !open;
    menuButton.setAttribute("aria-expanded", String(open));
    if (open && focusFirst) menuItems()[0]?.focus();
    if (!open && hadFocus) menuButton.focus(); // keyboard users land back on the button
  }

  menuButton.addEventListener("click", (e) => {
    e.stopPropagation();
    setMenu(menuList.hasAttribute("hidden"), true);
  });
  menuButton.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setMenu(true, true);
    }
  });

  // Arrow keys move, Home/End jump, a typed letter jumps to the next item starting with it.
  menuList.addEventListener("keydown", (e) => {
    const items = menuItems();
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => { e.preventDefault(); items[(n + items.length) % items.length]?.focus(); };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (e.key === "Tab") setMenu(false);
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey) {
      const k = e.key.toLowerCase();
      const order = [...items.slice(i + 1), ...items.slice(0, i + 1)];
      order.find((b) => b.textContent!.trim().toLowerCase().startsWith(k))?.focus();
    }
  });

  // Any item (or a click elsewhere, or Escape) closes the menu.
  menuList.addEventListener("click", () => {
    menuList.hidden = true;
    menuButton.setAttribute("aria-expanded", "false");
    // Back to typing, unless the item opened a dialog (which has taken focus).
    if (!document.querySelector("dialog[open]")) focusEditor();
  });
  document.addEventListener("click", () => setMenu(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menuList.hidden) setMenu(false); });
}
