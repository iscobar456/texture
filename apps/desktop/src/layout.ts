// Pane layout: the draggable editor/preview boundary and the collapsible photo inbox.
// Kept per device (it depends on the screen), like the other display preferences.

import { getCurrentWindow } from "@tauri-apps/api/window";

const KEY = "hwscan:layout";
const INBOX_WIDTH = "260px";
const INBOX_COLLAPSED = "44px";
const MIN_SPLIT = 0.2;
const MAX_SPLIT = 0.8;

type Layout = { split: number; inboxCollapsed: boolean };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function load(): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const split = Number(raw.split);
    return {
      split: Number.isFinite(split) ? Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, split)) : 0.5,
      inboxCollapsed: raw.inboxCollapsed === true,
    };
  } catch {
    return { split: 0.5, inboxCollapsed: false };
  }
}

export function initLayout() {
  const main = document.querySelector("main") as HTMLElement;
  const editor = $("editor");
  const preview = $("preview");
  const splitter = $("splitter");
  const inbox = $("inbox");
  const toggle = $<HTMLButtonElement>("inbox-toggle");
  const chevron = $("inbox-chevron");
  const badge = $("inbox-count");
  let layout = load();

  function apply() {
    // minmax(0, …) lets either pane shrink below its content instead of overflowing.
    const cols = `minmax(0, ${layout.split}fr) 6px minmax(0, ${1 - layout.split}fr) ${layout.inboxCollapsed ? INBOX_COLLAPSED : INBOX_WIDTH}`;
    main.style.setProperty("--cols", cols);
    inbox.classList.toggle("collapsed", layout.inboxCollapsed);
    toggle.setAttribute("aria-expanded", String(!layout.inboxCollapsed));
    toggle.title = layout.inboxCollapsed ? "Show the photo inbox" : "Minimize the photo inbox";
    chevron.textContent = layout.inboxCollapsed ? "«" : "»";
    splitter.setAttribute("aria-valuenow", String(Math.round(layout.split * 100)));
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(layout)); } catch {}
  }

  const setSplit = (v: number) => {
    layout.split = Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, v));
    apply();
  };

  // Drag: the fraction is measured against the width the two panes share, so it survives window resizes.
  splitter.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add("dragging");
    document.body.style.userSelect = "none";
    const left = editor.getBoundingClientRect().left;
    const shared = editor.getBoundingClientRect().width + preview.getBoundingClientRect().width;
    const move = (ev: PointerEvent) => setSplit((ev.clientX - left) / shared);
    const up = () => {
      splitter.releasePointerCapture(e.pointerId);
      splitter.classList.remove("dragging");
      document.body.style.userSelect = "";
      splitter.removeEventListener("pointermove", move);
      splitter.removeEventListener("pointerup", up);
      splitter.removeEventListener("pointercancel", up);
      save();
    };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", up);
    splitter.addEventListener("pointercancel", up);
  });

  // Keyboard: arrows nudge, Home/End jump to the limits; double-click resets.
  splitter.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === "ArrowLeft") setSplit(layout.split - step);
    else if (e.key === "ArrowRight") setSplit(layout.split + step);
    else if (e.key === "Home") setSplit(MIN_SPLIT);
    else if (e.key === "End") setSplit(MAX_SPLIT);
    else return;
    e.preventDefault();
    save();
  });
  splitter.addEventListener("dblclick", () => {
    setSplit(0.5);
    save();
  });

  toggle.addEventListener("click", () => {
    layout.inboxCollapsed = !layout.inboxCollapsed;
    apply();
    save();
  });

  apply();

  // ---- preview full screen ----
  // Fills the window with the preview and also puts the window itself in full screen. Esc leaves both.
  const fullBtn = $<HTMLButtonElement>("preview-full");
  let windowWasFullscreen = false;

  async function setPreviewFull(on: boolean) {
    if (preview.classList.contains("full") === on) return;
    preview.classList.toggle("full", on);
    fullBtn.setAttribute("aria-pressed", String(on));
    fullBtn.title = on ? "Exit full screen (Esc)" : "Full screen (Esc to exit)";
    try {
      const win = getCurrentWindow();
      if (on) {
        windowWasFullscreen = await win.isFullscreen();
        if (!windowWasFullscreen) await win.setFullscreen(true);
      } else if (!windowWasFullscreen) {
        await win.setFullscreen(false);
      }
    } catch (e) {
      // The in-window view still works if the OS refuses real full screen.
      console.warn("window fullscreen unavailable", e);
    }
  }

  fullBtn.addEventListener("click", () => void setPreviewFull(!preview.classList.contains("full")));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && preview.classList.contains("full") && !document.querySelector("dialog[open]")) {
      e.preventDefault();
      void setPreviewFull(false);
    }
  });

  return {
    /** Shows how many photos are waiting, so a minimized inbox still tells you something arrived. */
    setInboxCount(n: number) {
      badge.textContent = String(n);
      badge.hidden = n === 0;
    },
  };
}
