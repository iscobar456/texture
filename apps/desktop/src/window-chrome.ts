// The app draws its own title bar. Linux and Windows run without system decorations (tauri.conf.json), so this adds
// the window buttons, dragging by the header, and resize edges. macOS keeps its native traffic lights over the header
// (titleBarStyle "Overlay" in tauri.macos.conf.json): there it only adds dragging, and CSS leaves room for the lights.
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";

type ResizeDirection = Parameters<Window["startResizeDragging"]>[0];

const isMac = /Mac/.test(navigator.platform || navigator.userAgent);

/** Elements that move the window when their empty space is dragged. */
const DRAG_AREAS = "header, #auth";
/** Things inside a drag area that keep their own mouse behavior. */
const INTERACTIVE = "button, a, input, select, textarea, label, [role=menu], [contenteditable], .win-btn";

const svg = (path: string) =>
  `<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;
const ICON = {
  minimize: svg("M2 6.5h8"),
  maximize: svg("M2.5 2.5h7v7h-7z"),
  restore: svg("M2.5 4.5h5v5h-5zM4.5 4.5v-2h5v5h-2"),
  close: svg("M2.5 2.5l7 7M9.5 2.5l-7 7"),
};

export function initWindowChrome() {
  const win = getCurrentWindow();
  document.documentElement.dataset.platform = isMac ? "mac" : "other";

  // Dragging: like Tauri's data-tauri-drag-region, but for the whole header minus its controls, so the empty
  // space between and around buttons works without tagging every element. Double-click maximizes.
  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const t = e.target as Element;
    if (!t.closest(DRAG_AREAS) || t.closest(INTERACTIVE)) return;
    // Only bare background: text in the sign-in form etc. stays selectable.
    if (t.closest("#auth") && t !== document.getElementById("auth")) return;
    e.preventDefault();
    if (e.detail === 2) void win.toggleMaximize();
    else void win.startDragging();
  });

  if (isMac) return;

  // Window buttons, fixed in the top-right corner so they are there on the sign-in screen too; the header leaves
  // room for them (styles.css).
  const box = document.createElement("div");
  box.id = "win-controls";
  const btn = (name: keyof typeof ICON, label: string, run: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `win-btn win-${name}`;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.innerHTML = ICON[name];
    b.addEventListener("click", run);
    box.append(b);
    return b;
  };
  btn("minimize", "Minimize", () => void win.minimize());
  const max = btn("maximize", "Maximize", () => void win.toggleMaximize());
  // close() goes through onCloseRequested in main.ts, which saves the open document first.
  btn("close", "Close", () => void win.close());
  document.body.append(box);

  // Resize edges: without decorations the system gives the window none (GTK on Wayland in particular).
  const dirs: [string, ResizeDirection][] = [
    ["n", "North"], ["s", "South"], ["e", "East"], ["w", "West"],
    ["ne", "NorthEast"], ["nw", "NorthWest"], ["se", "SouthEast"], ["sw", "SouthWest"],
  ];
  const edges = document.createElement("div");
  edges.id = "resize-edges";
  for (const [cls, dir] of dirs) {
    const el = document.createElement("div");
    el.className = `rz rz-${cls}`;
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      void win.startResizeDragging(dir);
    });
    edges.append(el);
  }
  document.body.append(edges);

  // Maximized (or full screen): no edges to resize by, and the middle button restores.
  const sync = async () => {
    const [maximized, full] = await Promise.all([win.isMaximized(), win.isFullscreen()]);
    edges.hidden = maximized || full;
    document.documentElement.toggleAttribute("data-maximized", maximized || full);
    max.innerHTML = maximized ? ICON.restore : ICON.maximize;
    max.title = maximized ? "Restore" : "Maximize";
    max.setAttribute("aria-label", max.title);
  };
  void sync();
  void win.onResized(() => void sync());
}
