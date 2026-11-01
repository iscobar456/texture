// Pane layout: the draggable editor/preview boundary and the collapsible photo inbox.
// Kept per device (it depends on the screen), like the other display preferences.

import { getCurrentWindow } from "@tauri-apps/api/window";

const KEY = "hwscan:layout";
const INBOX_DEFAULT = 260;
const INBOX_MIN = 200;
const INBOX_MAX = 520;
const INBOX_COLLAPSED = 44;
const MIN_SPLIT = 0.2;
const MAX_SPLIT = 0.8;

type Layout = { split: number; inboxCollapsed: boolean; inboxWidth: number };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function load(): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const split = Number(raw.split);
    const width = Number(raw.inboxWidth);
    return {
      split: Number.isFinite(split) ? Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, split)) : 0.5,
      inboxCollapsed: raw.inboxCollapsed === true,
      inboxWidth: Number.isFinite(width) ? Math.min(INBOX_MAX, Math.max(INBOX_MIN, width)) : INBOX_DEFAULT,
    };
  } catch {
    return { split: 0.5, inboxCollapsed: false, inboxWidth: INBOX_DEFAULT };
  }
}

export function initLayout() {
  const main = document.querySelector("main") as HTMLElement;
  const editor = $("editor");
  const preview = $("preview");
  const splitter = $("splitter");
  const splitter2 = $("splitter2");
  const inbox = $("inbox");
  const toggle = $<HTMLButtonElement>("inbox-toggle");
  const chevron = $("inbox-chevron");
  const badge = $("inbox-count");
  let layout = load();

  function apply() {
    // minmax(0, …) lets either pane shrink below its content instead of overflowing.
    // The second splitter has no width while the inbox is minimized.
    const cols = `minmax(0, ${layout.split}fr) 6px minmax(0, ${1 - layout.split}fr) ${layout.inboxCollapsed ? 0 : 6}px ${layout.inboxCollapsed ? INBOX_COLLAPSED : layout.inboxWidth}px`;
    main.style.setProperty("--cols", cols);
    inbox.classList.toggle("collapsed", layout.inboxCollapsed);
    toggle.setAttribute("aria-expanded", String(!layout.inboxCollapsed));
    toggle.title = layout.inboxCollapsed ? "Show the photo inbox" : "Minimize the photo inbox";
    chevron.textContent = layout.inboxCollapsed ? "«" : "»";
    splitter.setAttribute("aria-valuenow", String(Math.round(layout.split * 100)));
    splitter2.hidden = layout.inboxCollapsed;
    splitter2.setAttribute("aria-valuenow", String(layout.inboxWidth));
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(layout)); } catch {}
  }

  const setSplit = (v: number) => {
    layout.split = Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, v));
    apply();
  };
  const setInboxWidth = (v: number) => {
    layout.inboxWidth = Math.round(Math.min(INBOX_MAX, Math.max(INBOX_MIN, v)));
    apply();
  };

  /** Pointer-drags a splitter; `onMove` gets the pointer's x. The layout is saved when the drag ends. */
  function drag(handle: HTMLElement, start: () => ((x: number) => void)) {
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("dragging");
      document.body.style.userSelect = "none";
      const onMove = start();
      const move = (ev: PointerEvent) => onMove(ev.clientX);
      const up = () => {
        handle.releasePointerCapture(e.pointerId);
        handle.classList.remove("dragging");
        document.body.style.userSelect = "";
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        save();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }

  // Editor/preview: the fraction is measured against the width the two panes share, so it survives window resizes.
  drag(splitter, () => {
    const left = editor.getBoundingClientRect().left;
    const shared = editor.getBoundingClientRect().width + preview.getBoundingClientRect().width;
    return (x) => setSplit((x - left) / shared);
  });
  // Preview/inbox: the inbox is as wide as the distance from the pointer to the window's right edge.
  drag(splitter2, () => {
    const right = main.getBoundingClientRect().right;
    return (x) => setInboxWidth(right - x);
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
  splitter2.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowLeft") setInboxWidth(layout.inboxWidth + step); // moving the edge left widens the inbox
    else if (e.key === "ArrowRight") setInboxWidth(layout.inboxWidth - step);
    else if (e.key === "Home") setInboxWidth(INBOX_MAX);
    else if (e.key === "End") setInboxWidth(INBOX_MIN);
    else return;
    e.preventDefault();
    save();
  });
  splitter2.addEventListener("dblclick", () => {
    setInboxWidth(INBOX_DEFAULT);
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
