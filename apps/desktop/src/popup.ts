export type MenuItem = { label: string; run: () => void; danger?: boolean; disabled?: boolean };

/**
 * Makes `btn` open a small menu. The menu is appended to `host`: a dialog, when the button is inside one
 * (so it shows above it), or document.body otherwise. Only one is open at a time.
 */
export function attachMenu(btn: HTMLElement, host: HTMLElement, items: MenuItem[]) {
  btn.setAttribute("aria-haspopup", "menu");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll(".popup").forEach((p) => p.remove());
    const pop = document.createElement("div");
    pop.className = "popup";
    pop.setAttribute("role", "menu");
    for (const it of items) {
      const b = document.createElement("button");
      b.textContent = it.label;
      b.disabled = !!it.disabled;
      if (it.danger) b.className = "danger";
      b.onclick = (ev) => { ev.stopPropagation(); pop.remove(); it.run(); };
      pop.append(b);
    }
    host.append(pop);
    // Right edge under the button; flipped above it if there is no room below.
    const r = btn.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - 8))}px`;
    const below = r.bottom + 2;
    pop.style.top = `${below + pop.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - pop.offsetHeight - 2) : below}px`;
  });
}

/** A vertical-dots button that opens a menu (see attachMenu). */
export function kebab(host: HTMLElement, items: MenuItem[]) {
  const btn = document.createElement("button");
  btn.className = "kebab";
  btn.textContent = "⋮";
  btn.title = "Actions";
  attachMenu(btn, host, items);
  return btn;
}

// Clicking anywhere else closes an open menu.
document.addEventListener("click", () => document.querySelectorAll(".popup").forEach((p) => p.remove()));
