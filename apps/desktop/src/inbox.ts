import { PHOTO_MIME } from "./placement";
import { invoke } from "@tauri-apps/api/core";
import type { createApi, Photo } from "@texture/api";
import { toast } from "./toast";
import { OCR_MODELS, type Settings } from "./settings";

type Api = ReturnType<typeof createApi>;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export type InboxDeps = {
  api: () => Api;
  user: () => string;
  settings: () => Settings;
  /** Where a photo would go: the open document's path, or null when a template or the snippets file is open. */
  target: () => string | null;
  /** Place mode: resolves to a document offset the user chose for `what` ("photo", "transcription"), or null if cancelled. */
  pickInsertPoint: (what: string) => Promise<number | null>;
  insertAt: (pos: number, text: string) => void;
  status: (msg: string) => void;
  /** Opens the app's delete confirmation for a photo. */
  askDelete: (p: Photo) => void;
  /** How many photos are waiting (the minimized inbox shows it). */
  onCount: (n: number) => void;
};

// ---- images ----

/** The EXIF orientation (1-8) of a JPEG, or 1 when there is none. LaTeX ignores this tag; browsers apply it. */
function exifOrientation(b: Uint8Array): number {
  if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 2;
  while (o + 4 < b.length && b[o] === 0xff) {
    const marker = b[o + 1];
    if (marker === 0xda) break; // start of image data
    const len = v.getUint16(o + 2);
    if (marker === 0xe1 && v.getUint32(o + 4) === 0x45786966) { // "Exif"
      const t = o + 10; // TIFF header
      const le = v.getUint16(t) === 0x4949;
      const ifd = t + v.getUint32(t + 4, le);
      if (ifd + 2 > b.length) return 1;
      const n = v.getUint16(ifd, le);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > b.length) return 1;
        if (v.getUint16(e, le) === 0x0112) return v.getUint16(e + 8, le) || 1;
      }
      return 1;
    }
    o += 2 + len;
  }
  return 1;
}

/**
 * Draws a photo rotated by `deg` (a multiple of 90, clockwise), scaled so its long side is at most `maxSide`,
 * and returns it as a JPEG. createImageBitmap applies the file's EXIF orientation first.
 */
async function renderRotated(blob: Blob, deg: number, maxSide: number, quality: number): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const turned = deg % 180 !== 0;
  const w = turned ? bitmap.height : bitmap.width;
  const h = turned ? bitmap.width : bitmap.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  const dw = bitmap.width * scale;
  const dh = bitmap.height * scale;
  ctx.drawImage(bitmap, -dw / 2, -dh / 2, dw, dh);
  bitmap.close();
  const out = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", quality));
  if (!out) throw new Error("Could not prepare the photo");
  return out;
}

const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

type Section = "pending" | "used" | "trash";

const TRASH_DAYS = 7;

export function initInbox(deps: InboxDeps) {
  const list = $("inbox-list");
  let lists: Record<Section, Photo[]> = { pending: [], used: [], trash: [] };
  let tab: Section = "pending"; // which list the sidebar shows
  /** Pending photos already announced; null until the first load, so existing photos never trigger a toast. */
  let seen: Set<string> | null = null;
  let purged = false;

  // ---- loading images: lazily, from a disk cache, and only as many originals as are in use ----

  /** Full-size originals, downloaded only when something needs them (viewer, insert, OCR); the last few are kept. */
  const originals = new Map<string, Promise<Blob>>();
  function original(p: Photo): Promise<Blob> {
    let pr = originals.get(p.id);
    if (pr) {
      originals.delete(p.id); // move to the most recent position
    } else {
      pr = deps.api().downloadPhoto(p);
      pr.catch(() => originals.delete(p.id));
    }
    originals.set(p.id, pr);
    while (originals.size > 4) originals.delete(originals.keys().next().value!);
    return pr;
  }

  const thumbs = new Map<string, string>(); // object URLs of small previews, this session
  const thumbJobs = new Map<string, Promise<string>>();
  const headers = (p: Photo) => ({ "x-user": deps.user(), "x-id": p.id });

  /** A small preview: from memory, else the disk cache, else made once from the original and cached. */
  function thumbUrl(p: Photo): Promise<string> {
    const have = thumbs.get(p.id);
    if (have) return Promise.resolve(have);
    let job = thumbJobs.get(p.id);
    if (!job) {
      job = (async () => {
        let blob: Blob;
        try {
          blob = new Blob([await invoke<ArrayBuffer>("thumb_get", { user: deps.user(), id: p.id })], { type: "image/jpeg" });
        } catch {
          blob = await renderRotated(await original(p), 0, 640, 0.8);
          invoke("thumb_put", await bytesOf(blob), { headers: headers(p) }).catch(() => {});
        }
        const url = URL.createObjectURL(blob);
        thumbs.set(p.id, url);
        return url;
      })().finally(() => thumbJobs.delete(p.id));
      thumbJobs.set(p.id, job);
    }
    return job;
  }

  // At most a few previews are prepared at once, so a long inbox does not stall the app.
  let active = 0;
  const queue: (() => Promise<void>)[] = [];
  function schedule(task: () => Promise<void>) {
    queue.push(task);
    pump();
  }
  function pump() {
    while (active < 3 && queue.length) {
      active++;
      void queue.shift()!().finally(() => { active--; pump(); });
    }
  }

  // Previews load when a card comes near the visible part of the inbox.
  const lazy = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        lazy.unobserve(e.target);
        const img = e.target as HTMLImageElement;
        const p = findPhoto(img.dataset.id!);
        if (p) schedule(async () => { try { img.src = await thumbUrl(p); img.parentElement?.classList.remove("loading"); } catch { img.parentElement?.classList.add("failed"); } });
      }
    },
    { root: $("inbox"), rootMargin: "240px" },
  );

  const findPhoto = (id: string) => [...lists.pending, ...lists.used, ...lists.trash].find((p) => p.id === id);

  // ---- the lists ----

  /** Many realtime events arrive at once after a bulk action; overlapping calls share one trailing reload. */
  let running: Promise<void> | null = null;
  let again = false;
  function refresh(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await load();
      } while (again);
    })().finally(() => { running = null; });
    return running;
  }

  async function load() {
    try {
      // The photos waiting must always show. "Used" and "Trash" are extras: if they cannot be read (for example
      // before the matching database migration is applied), they are simply left out.
      const [pending, used, trash] = await Promise.all([
        deps.api().listPending(),
        deps.api().listUsed().catch(() => [] as Photo[]),
        deps.api().listTrashed().catch(() => [] as Photo[]),
      ]);
      lists = { pending: applyOrder(pending), used, trash };
      render();
      deps.onCount(pending.length);
      announce(pending);
      syncViewer();
      // Housekeeping, once the list is on screen.
      const keep = [...pending, ...used, ...trash].map((p) => p.id);
      invoke("thumb_prune", { user: deps.user(), keep }).catch(() => {});
      for (const [id, url] of thumbs) if (!keep.includes(id)) { URL.revokeObjectURL(url); thumbs.delete(id); }
      if (!purged) {
        purged = true;
        deps.api().purgeTrash(TRASH_DAYS).then((n) => n && void refresh()).catch(() => {});
      }
    } catch {
      list.textContent = "The photo inbox needs a connection.";
    }
  }

  /** A toast for photos that arrived while the app was open (the minimized inbox otherwise only shows a count). */
  function announce(pending: Photo[]) {
    if (seen === null) {
      seen = new Set(pending.map((p) => p.id));
      return;
    }
    const fresh = pending.filter((p) => !seen!.has(p.id));
    for (const p of pending) seen.add(p.id);
    if (!fresh.length) return;
    toast(fresh.length === 1 ? "New photo from your phone" : `${fresh.length} new photos from your phone`, {
      actionLabel: "View",
      onAction: () => openViewer("pending", Math.max(0, lists.pending.findIndex((p) => p.id === fresh[0].id))),
    });
  }

  function render() {
    lazy.disconnect();
    barUpdaters = [];
    // Selection survives a reload, minus photos that are gone.
    if (selecting) {
      const ids = new Set(lists[selecting].map((p) => p.id));
      for (const id of selected) if (!ids.has(id)) selected.delete(id);
      if (!selected.size) selecting = null;
    }
    updateTabs();
    const parts: HTMLElement[] = [];
    if (lists[tab].length) {
      parts.push(bar(tab), ...lists[tab].map((p) => card(p, tab)));
    } else {
      parts.push(emptyState(tab));
    }
    list.replaceChildren(...parts);
    applySelection();
  }

  // ---- reordering the inbox (per device for now) ----

  const orderKey = () => `texture:inbox-order:${deps.user()}`;

  /** Your order first; photos that arrived since stay on top, newest first, as before. */
  function applyOrder(ps: Photo[]): Photo[] {
    let order: string[] = [];
    try { order = JSON.parse(localStorage.getItem(orderKey()) ?? "[]"); } catch {}
    if (!order.length) return ps;
    const rank = new Map(order.map((id, i) => [id, i]));
    const fresh = ps.filter((p) => !rank.has(p.id));
    const known = ps.filter((p) => rank.has(p.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    return [...fresh, ...known];
  }

  function saveOrder() {
    try { localStorage.setItem(orderKey(), JSON.stringify(lists.pending.map((p) => p.id))); } catch {}
  }

  const pendingCards = () => [...list.querySelectorAll<HTMLElement>('.photo[data-kind="pending"]')];

  /** Moves a photo to index `to` of the pending list and updates the page in place, so no thumbnail reloads. */
  function movePhoto(id: string, to: number) {
    const from = lists.pending.findIndex((p) => p.id === id);
    if (from < 0) return;
    const [p] = lists.pending.splice(from, 1);
    to = Math.max(0, Math.min(lists.pending.length, to));
    lists.pending.splice(to, 0, p);
    saveOrder();
    const cards = new Map(pendingCards().map((c) => [c.dataset.id!, c]));
    const el = cards.get(id);
    if (!el) return;
    const after = lists.pending[to + 1];
    const ref = after ? cards.get(after.id) : null;
    if (ref) ref.before(el);
    else (pendingCards().filter((c) => c !== el).pop())?.after(el);
  }

  /** Where the dragged card would land: how many of the other cards have their middle above the pointer. */
  function dropIndex(clientY: number, skip: HTMLElement) {
    return pendingCards().filter((c) => {
      if (c === skip) return false;
      const r = c.getBoundingClientRect();
      return clientY > r.top + r.height / 2;
    }).length;
  }

  function showDrop(idx: number | null, skip: HTMLElement) {
    const others = pendingCards().filter((c) => c !== skip);
    others.forEach((c, i) => {
      c.classList.toggle("drop-before", idx === i);
      c.classList.toggle("drop-after", idx !== null && idx === others.length && i === others.length - 1);
    });
  }

  /**
   * Reordering follows the pointer itself rather than the browser's drag-and-drop, which is unreliable in some
   * webviews: the card follows the pointer, a line shows where it will land, and the list scrolls near its edges.
   */
  function startReorder(el: HTMLElement, id: string, grip: HTMLElement, e: PointerEvent) {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const box = $("inbox");
    const y0 = e.clientY;
    const scroll0 = box.scrollTop;
    let y = y0;
    el.draggable = false; // the whole card is draggable into the editor; not while it is being reordered
    el.classList.add("dragging");
    const place = () => {
      el.style.transform = `translateY(${y - y0 + box.scrollTop - scroll0}px)`;
      showDrop(dropIndex(y, el), el);
    };
    const timer = setInterval(() => {
      const edge = box.getBoundingClientRect();
      if (y < edge.top + 48) box.scrollBy(0, -12);
      else if (y > edge.bottom - 48) box.scrollBy(0, 12);
      place();
    }, 30);
    const move = (ev: PointerEvent) => { y = ev.clientY; place(); };
    const end = (ev: PointerEvent) => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      clearInterval(timer);
      if (grip.hasPointerCapture(ev.pointerId)) grip.releasePointerCapture(ev.pointerId);
      const idx = dropIndex(y, el);
      showDrop(null, el);
      el.style.transform = "";
      el.classList.remove("dragging");
      el.draggable = selecting !== "pending";
      if (ev.type !== "pointercancel") movePhoto(id, idx);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  }

  // ---- selecting several photos (to trash, restore or delete them together) ----

  /** The section the ticked photos belong to (null when none are ticked), and the ticked ids. Ticking in another section starts over. */
  let selecting: Section | null = null;
  const selected = new Set<string>();
  let barUpdaters: (() => void)[] = [];

  function clearSelection() {
    selecting = null;
    selected.clear();
    applySelection();
  }

  function toggleSelected(id: string, kind: Section) {
    if (selecting !== kind) {
      selected.clear();
      selecting = kind;
    }
    if (!selected.delete(id)) selected.add(id);
    if (!selected.size) selecting = null;
    applySelection();
  }

  /** Updates cards and toolbars in place, so ticking a box never reloads the thumbnails. */
  function applySelection() {
    list.querySelectorAll<HTMLElement>(".photo").forEach((el) => {
      const kind = el.dataset.kind as Section;
      const on = selecting === kind;
      const ticked = on && selected.has(el.dataset.id!);
      el.classList.toggle("selectable", on);
      el.classList.toggle("selected", ticked);
      el.querySelector(".sel-box")?.setAttribute("aria-checked", String(ticked));
      el.draggable = kind !== "trash" && !on;
    });
    barUpdaters.forEach((u) => u());
  }

  const icon = (d: string) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    none: icon('<rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="currentColor"/><path d="M5.5 8.5l2 2 3.5-4.5" stroke="Canvas"/>'),
    all: icon('<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5.5 8.5l2 2 3.5-4.5"/>'),
    trash: icon('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4"/>'),
    cancel: icon('<path d="M4 4l8 8M12 4l-8 8"/>'),
    ocr: icon('<path d="M2.5 4h11M2.5 8h11M2.5 12h6"/>'),
    restore: icon('<path d="M3 7a5 5 0 1 1 1.6 3.7M3 3.5V7h3.5"/>'),
  };

  /** A button that asks for a second click before doing something permanent. It shows words only while armed. */
  function confirmButton(label: string, glyph: string, confirmLabel: () => string, fn: () => Promise<void>, cls = "") {
    const b = document.createElement("button");
    b.className = `danger ${cls}`.trim();
    b.title = label;
    b.setAttribute("aria-label", label);
    b.innerHTML = glyph;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reset = () => { clearTimeout(timer); b.dataset.armed = ""; b.innerHTML = glyph; };
    b.addEventListener("click", async () => {
      if (!b.dataset.armed) {
        b.dataset.armed = "1";
        b.textContent = confirmLabel();
        timer = setTimeout(reset, 4000);
        return;
      }
      reset();
      b.disabled = true;
      try { await fn(); } catch (e) { deps.status(String((e as Error)?.message ?? e)); } finally { b.disabled = false; }
    });
    return Object.assign(b, { reset });
  }

  /**
   * The toolbar above a section's photos. Nothing shows until a photo is ticked; then it offers Select all, the
   * bulk action (Move to trash, or Restore / Delete forever in Trash) and Cancel. Trash also always has Empty trash.
   */
  function bar(kind: Section) {
    const el = document.createElement("div");
    el.className = "inbox-bar";
    const photos = () => lists[kind];
    const plural = (n: number) => `${n} photo${n === 1 ? "" : "s"}`;
    const mk = (glyph: string, title: string, fn: () => void | Promise<void>, cls = "") => {
      const b = document.createElement("button");
      b.innerHTML = glyph;
      b.title = title;
      b.setAttribute("aria-label", title);
      if (cls) b.className = cls;
      b.addEventListener("click", async () => {
        b.disabled = true;
        try { await fn(); } catch (e) { deps.status(String((e as Error)?.message ?? e)); } finally { b.disabled = false; }
      });
      return b;
    };
    const chosen = () => photos().filter((p) => selected.has(p.id));

    const count = document.createElement("span");
    count.className = "inbox-bar-count";
    const all = mk(ICON.all, "Select all", () => {
      const every = photos().every((p) => selected.has(p.id));
      selected.clear();
      if (!every) for (const p of photos()) selected.add(p.id);
      selecting = selected.size ? kind : null;
      applySelection();
    });
    const cancel = mk(ICON.cancel, "Cancel", clearSelection);

    const actions: (HTMLButtonElement & { reset?: () => void })[] = [];
    if (kind === "trash") {
      actions.push(
        mk(ICON.restore, "Restore to inbox", async () => {
          const ids = chosen().map((p) => p.id);
          clearSelection();
          if (ids.length) { ids.forEach((id) => seen?.add(id)); await deps.api().restorePhotos(ids); await refresh(); }
        }),
        confirmButton("Delete forever", ICON.trash, () => `Delete ${selected.size}?`, async () => {
          const ps = chosen();
          clearSelection();
          if (ps.length) { await deps.api().deletePhotos(ps); await refresh(); }
        }, "solid"),
      );
    } else {
      actions.push(
        kind === "used"
          ? mk(ICON.restore, "Move to inbox", async () => {
              const ps = chosen();
              clearSelection();
              await moveToInbox(ps);
            })
          // chosen() is in the list's order, so the transcriptions come out in the order you arranged the photos
          : mk(ICON.ocr, "Transcribe the selected photos (OCR)…", () => openBatchOcr(chosen())),
        mk(ICON.trash, "Move to trash", async () => {
          const ids = chosen().map((p) => p.id);
          clearSelection();
          if (!ids.length) return;
          await deps.api().trashPhotos(ids);
          await refresh();
          toast(`${plural(ids.length)} moved to trash`, {
            actionLabel: "Undo",
            onAction: () => { ids.forEach((id) => seen?.add(id)); void deps.api().restorePhotos(ids).then(refresh); },
          });
        }, "danger solid"),
      );
    }

    const empty = kind === "trash"
      ? confirmButton("Empty trash", `${ICON.trash}Empty trash`, () => `Delete all ${lists.trash.length}?`, async () => {
          const ps = [...lists.trash];
          if (ps.length) { clearSelection(); await deps.api().deletePhotos(ps); await refresh(); toast(`Trash emptied (${plural(ps.length)})`); }
        }, "wide")
      : null;

    el.append(count, all, ...actions, cancel, ...(empty ? [empty] : []));
    barUpdaters.push(() => {
      const on = selecting === kind;
      count.hidden = all.hidden = cancel.hidden = !on;
      for (const a of actions) {
        a.hidden = !on;
        if (!on) a.reset?.();
      }
      if (empty) { empty.hidden = on; if (on) empty.reset(); }
      const everyone = photos().every((p) => selected.has(p.id));
      all.title = everyone ? "Select none" : "Select all";
      all.classList.toggle("on", everyone);
      all.innerHTML = everyone ? ICON.none : ICON.all;
      all.setAttribute("aria-label", all.title);
      count.textContent = `${selected.size} selected`;
      el.hidden = !on && !empty; // an empty toolbar would only leave a gap
    });
    return el;
  }

  function emptyState(which: Section) {
    const el = document.createElement("div");
    el.className = "inbox-empty";
    const [title, hint] =
      which === "used" ? ["Nothing used yet", "Photos you insert or transcribe are kept here, so you can use them again."]
      : which === "trash" ? ["Trash is empty", `Deleted photos stay here for ${TRASH_DAYS} days.`]
      : ["No photos waiting", "Photos you take in the Texture phone app appear here."];
    el.innerHTML = `${EMPTY_ICON}<p class="inbox-empty-title">${title}</p><p class="muted">${hint}</p>`;
    if (which === "pending") {
      const all = [...lists.pending, ...lists.used, ...lists.trash];
      const newest = all.map((p) => p.created_at).sort().pop();
      const last = document.createElement("p");
      last.className = "muted";
      last.textContent = newest ? `Last photo received ${ago(newest)}.` : "Nothing has arrived from your phone yet.";
      el.append(last);
    }
    return el;
  }

  // ---- tabs: Inbox / Used / Trash ----

  const tabsEl = $("inbox-tabs");
  const TABS: [Section, string][] = [["pending", "Inbox"], ["used", "Used"], ["trash", "Trash"]];
  const tabButtons = new Map<Section, HTMLButtonElement>();
  for (const [which, label] of TABS) {
    const b = document.createElement("button");
    b.setAttribute("role", "tab");
    b.className = "inbox-tab";
    const name = document.createElement("span");
    name.textContent = label;
    const count = document.createElement("span");
    count.className = "count";
    b.append(name, count);
    b.addEventListener("click", () => setTab(which));
    b.addEventListener("keydown", (e) => {
      const i = TABS.findIndex(([w]) => w === which);
      const to = e.key === "ArrowRight" ? TABS[(i + 1) % TABS.length] : e.key === "ArrowLeft" ? TABS[(i + TABS.length - 1) % TABS.length] : null;
      if (!to) return;
      e.preventDefault();
      setTab(to[0]);
      tabButtons.get(to[0])!.focus();
    });
    tabButtons.set(which, b);
    tabsEl.append(b);
  }

  function updateTabs() {
    for (const [which] of TABS) {
      const b = tabButtons.get(which)!;
      const on = which === tab;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle("on", on);
      const n = lists[which].length;
      const c = b.querySelector<HTMLElement>(".count")!;
      c.textContent = String(n);
      c.hidden = n === 0;
    }
  }

  function setTab(which: Section) {
    if (which === tab) return;
    tab = which;
    selecting = null; // a selection belongs to one list
    selected.clear();
    render();
    $("inbox").scrollTop = 0;
  }

  const EMPTY_ICON = '<svg class="inbox-empty-icon" viewBox="0 0 16 16" width="28" height="28" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="5.8" cy="6.2" r="1.1" fill="currentColor"/><path d="M2.6 11.6l3.1-3 2.6 2.4 2-1.8 3.1 2.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function card(p: Photo, kind: Section) {
    const el = document.createElement("div");
    el.className = "photo";
    el.dataset.id = p.id;
    el.dataset.kind = kind;
    const at = () => Math.max(0, lists[kind].findIndex((x) => x.id === p.id)); // the list can be reordered after this card was built
    const box = document.createElement("button");
    box.className = "sel-box";
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", "false");
    box.setAttribute("aria-label", "Select this photo");
    box.addEventListener("click", () => toggleSelected(p.id, kind));
    // Once something in this section is ticked, a click anywhere on a card ticks it too, instead of opening the viewer.
    el.addEventListener("click", (e) => {
      if (selecting !== kind) return;
      e.preventDefault();
      e.stopPropagation(); // also keeps the box's own handler from toggling twice
      toggleSelected(p.id, kind);
    }, true);

    const imgBtn = document.createElement("button");
    imgBtn.className = "photo-img loading";
    const img = document.createElement("img");
    img.alt = "";
    img.dataset.id = p.id;
    imgBtn.append(img);
    if (kind === "trash") {
      imgBtn.disabled = true; // restore a photo to look at or use it again
    } else {
      imgBtn.title = "View larger";
      imgBtn.setAttribute("aria-label", "View photo larger");
      imgBtn.addEventListener("click", () => openViewer(kind, at()));
    }
    lazy.observe(img);
    if (kind !== "trash") {
      img.draggable = false; // drag the whole card, not the bare image
      el.draggable = true;
      el.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData(PHOTO_MIME, p.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
      });
    }
    if (kind === "pending") {
      const grip = document.createElement("button");
      grip.className = "grip";
      grip.title = "Drag to reorder (or press ↑ / ↓ here)";
      grip.setAttribute("aria-label", "Reorder this photo");
      grip.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor"><circle cx="5.5" cy="4" r="1.2"/><circle cx="10.5" cy="4" r="1.2"/><circle cx="5.5" cy="8" r="1.2"/><circle cx="10.5" cy="8" r="1.2"/><circle cx="5.5" cy="12" r="1.2"/><circle cx="10.5" cy="12" r="1.2"/></svg>';
      grip.addEventListener("pointerdown", (e) => { if (e.button === 0) startReorder(el, p.id, grip, e); });
      grip.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        movePhoto(p.id, at() + (e.key === "ArrowUp" ? -1 : 1));
        grip.focus();
        el.scrollIntoView({ block: "nearest" });
      });
      el.append(grip);
    }

    const when = document.createElement("div");
    when.className = "photo-meta";
    const stamp = kind === "trash" ? p.trashed_at ?? p.created_at : kind === "used" ? p.imported_at ?? p.created_at : p.created_at;
    when.dataset.at = stamp;
    when.dataset.prefix = kind === "trash" ? "Trashed " : kind === "used" ? "Used " : "";
    const left = Math.max(0, Math.ceil(TRASH_DAYS - (Date.now() - new Date(stamp).getTime()) / 86_400_000));
    when.dataset.suffix = kind === "trash" ? ` · deleted for good in ${left} day${left === 1 ? "" : "s"}` : "";
    when.textContent = `${when.dataset.prefix}${ago(stamp)}${when.dataset.suffix}`;

    const actions = document.createElement("div");
    actions.className = "photo-actions";
    if (kind === "trash") {
      actions.append(
        button("Restore", "Move it back to the inbox", () => restore(p), ""),
        button("Delete forever…", "Permanently delete this photo", async () => deps.askDelete(p), ""),
      );
      actions.classList.add("two");
    } else {
      actions.append(
        kind === "used"
          ? button("Move to inbox", "Move it back to the inbox", async () => moveToInbox([p]), "")
          : button("Insert", "Insert the photo into the document at the cursor", async () => chooseAndInsert(p), ""),
        button("Transcribe", "Turn the handwriting into LaTeX and review it before inserting", async () => openOcr(p), ""),
      );
      actions.classList.add("two");
    }

    el.append(box, imgBtn, when, actions);
    return el;
  }

  function button(label: string, title: string, fn: () => Promise<void>, cls: string) {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    if (cls) b.className = cls;
    b.addEventListener("click", async () => {
      b.disabled = true;
      try { await fn(); } catch (e) { deps.status(String((e as Error)?.message ?? e)); } finally { b.disabled = false; }
    });
    return b;
  }

  // Keep "2 min ago" honest.
  setInterval(() => {
    list.querySelectorAll<HTMLElement>(".photo-meta").forEach((m) => {
      m.textContent = `${m.dataset.prefix}${ago(m.dataset.at!)}${m.dataset.suffix}`;
    });
  }, 30_000);

  // ---- trash and undo ----

  async function trash(p: Photo) {
    try {
      await deps.api().trashPhoto(p.id);
      await refresh();
      toast("Photo moved to trash", { actionLabel: "Undo", onAction: () => void restore(p) });
    } catch (e) {
      deps.status(String((e as Error)?.message ?? e));
    }
  }

  /** Puts used photos back among the waiting ones (they land on top, as new arrivals do). */
  async function moveToInbox(ps: Photo[]) {
    if (!ps.length) return;
    const ids = ps.map((p) => p.id);
    ids.forEach((id) => seen?.add(id)); // not new arrivals
    await deps.api().restorePhotos(ids);
    await refresh();
    toast(ids.length === 1 ? "Photo moved to inbox" : `${ids.length} photos moved to inbox`, {
      actionLabel: "Undo",
      onAction: () => void Promise.all(ids.map((id) => deps.api().markImported(id))).then(refresh),
    });
  }

  async function restore(p: Photo) {
    seen?.add(p.id); // it is not a new arrival
    await deps.api().restorePhoto(p.id);
    await refresh();
  }

  // ---- inserting ----

  /** Saves the photo (rotated if asked) into the open document's images and returns the LaTeX that shows it. */
  async function placeImage(p: Photo, deg: number): Promise<string> {
    const target = deps.target();
    if (target === null) throw new Error("Open a document to insert photos");
    const blob = await original(p);
    let bytes: Uint8Array;
    let ext: string;
    const raw = deg === 0 ? await bytesOf(blob) : null;
    if (raw && exifOrientation(raw) === 1) {
      bytes = raw; // the original, untouched
      ext = p.storage_path.split(".").pop() ?? "jpg";
    } else { // rotated by you, or tagged with an EXIF orientation that LaTeX would ignore
      bytes = await bytesOf(await renderRotated(blob, deg, 10_000, 0.92));
      ext = "jpg";
    }
    const rel = await invoke<string>("save_image", bytes, {
      headers: { "x-user": deps.user(), "x-path": encodeURIComponent(target), "x-name": `${p.id}.${ext}` },
    });
    return `\\begin{center}\n\\includegraphics[width=0.8\\linewidth]{${rel}}\n\\end{center}\n`;
  }

  async function insertPhoto(p: Photo, deg: number, pos: number) {
    deps.insertAt(pos, await placeImage(p, deg));
    await deps.api().markImported(p.id);
    await refresh();
  }

  /** Insert / Insert again: choose the spot first, then insert there. */
  async function chooseAndInsert(p: Photo, deg = 0) {
    if (deps.target() === null) throw new Error("Open a document to insert photos");
    if (viewer.open) viewer.close(); // the editor has to be visible to pick a spot
    const pos = await deps.pickInsertPoint("photo");
    if (pos !== null) await insertPhoto(p, deg, pos);
  }

  /** A card was dragged onto the editor. */
  async function dropPhoto(id: string, pos: number) {
    const p = findPhoto(id);
    if (!p || p.status === "trashed") return;
    try { await insertPhoto(p, 0, pos); } catch (e) { deps.status(String((e as Error)?.message ?? e)); }
  }

  // ---- the viewer ----

  const viewer = $<HTMLDialogElement>("viewer");
  const stage = $("viewer-stage");
  const vimg = $<HTMLImageElement>("viewer-img");
  const zoomLabel = $("viewer-zoom-label");
  let vList: Section = "pending";
  let vId = "";
  let vIndex = 0;
  let vDeg = 0;
  let vZoom = 1;
  let vUrl = "";
  let vToken = 0;

  const current = (): Photo | undefined => lists[vList][vIndex];

  async function showCurrent() {
    const p = current();
    if (!p) return;
    const token = ++vToken;
    vId = p.id;
    $("viewer-title").textContent = `Photo ${vIndex + 1} of ${lists[vList].length} · ${ago(p.created_at)}`;
    // Shown at up to 2400px; the full-size original is only re-encoded if you insert it rotated.
    const blob = await original(p);
    if (token !== vToken) return;
    const url = URL.createObjectURL(await renderRotated(blob, vDeg, 2400, 0.9));
    if (token !== vToken) return URL.revokeObjectURL(url);
    if (vUrl) URL.revokeObjectURL(vUrl);
    vUrl = url;
    vimg.src = url;
    await vimg.decode().catch(() => {});
    applyZoom();
  }

  function applyZoom() {
    if (!vimg.naturalWidth) return;
    const fit = Math.min(stage.clientWidth / vimg.naturalWidth, stage.clientHeight / vimg.naturalHeight, 1);
    vimg.style.width = `${vimg.naturalWidth * fit * vZoom}px`;
    zoomLabel.textContent = vZoom === 1 ? "Fit" : `${Math.round(vZoom * 100)}%`;
    stage.style.cursor = vZoom > 1 ? "grab" : "default";
  }

  function setZoom(z: number) {
    vZoom = Math.min(6, Math.max(0.25, z));
    applyZoom();
  }

  function goTo(i: number) {
    if (i < 0 || i >= lists[vList].length || i === vIndex) return;
    vIndex = i;
    vDeg = 0;
    vZoom = 1;
    void showCurrent();
  }

  function openViewer(which: Section, index: number) {
    vList = which;
    vIndex = index;
    vDeg = 0;
    vZoom = 1;
    viewer.showModal();
    void showCurrent();
  }

  /** After the lists changed: stay on the same photo, follow a removed one to its neighbour, or close if none is left. */
  function syncViewer() {
    if (!viewer.open) return;
    const l = lists[vList];
    if (!l.length) return viewer.close();
    const i = l.findIndex((p) => p.id === vId);
    vIndex = i >= 0 ? i : Math.min(vIndex, l.length - 1);
    if (i < 0) {
      vDeg = 0;
      vZoom = 1;
      void showCurrent(); // a different photo; a plain refresh of the same one must not flash the image
    }
  }

  viewer.addEventListener("close", () => {
    vToken++;
    if (vUrl) URL.revokeObjectURL(vUrl);
    vUrl = "";
    vimg.removeAttribute("src");
  });
  $("viewer-rot-left").addEventListener("click", () => { vDeg = (vDeg + 270) % 360; vZoom = 1; void showCurrent(); });
  $("viewer-rot-right").addEventListener("click", () => { vDeg = (vDeg + 90) % 360; vZoom = 1; void showCurrent(); });
  $("viewer-zoom-in").addEventListener("click", () => setZoom(vZoom * 1.25));
  $("viewer-zoom-out").addEventListener("click", () => setZoom(vZoom / 1.25));
  zoomLabel.addEventListener("click", () => setZoom(1));
  $("viewer-insert").addEventListener("click", async () => {
    const p = current();
    if (!p) return;
    try {
      await chooseAndInsert(p, vDeg);
    } catch (e) {
      deps.status(String((e as Error)?.message ?? e));
    }
  });
  $("viewer-ocr").addEventListener("click", () => {
    const p = current();
    if (p) openOcr(p, vDeg).catch((e) => deps.status(String((e as Error)?.message ?? e)));
  });
  $("viewer-delete").addEventListener("click", () => {
    const p = current();
    if (p) void trash(p);
  });
  viewer.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    if (e.key === "ArrowLeft") goTo(vIndex - 1);
    else if (e.key === "ArrowRight") goTo(vIndex + 1);
    else if (e.key === "+" || e.key === "=") setZoom(vZoom * 1.25);
    else if (e.key === "-") setZoom(vZoom / 1.25);
    else if (e.key === "0") setZoom(1);
    else if (e.key.toLowerCase() === "r" && !e.ctrlKey && !e.metaKey) $(e.shiftKey ? "viewer-rot-left" : "viewer-rot-right").click();
    else return;
    e.preventDefault();
  });
  // Ctrl+wheel zooms; dragging pans a zoomed photo.
  stage.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(vZoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
  }, { passive: false });
  stage.addEventListener("pointerdown", (e) => {
    if (vZoom <= 1) return;
    stage.setPointerCapture(e.pointerId);
    stage.style.cursor = "grabbing";
    let x = e.clientX;
    let y = e.clientY;
    const move = (ev: PointerEvent) => {
      stage.scrollLeft -= ev.clientX - x;
      stage.scrollTop -= ev.clientY - y;
      x = ev.clientX;
      y = ev.clientY;
    };
    const up = () => {
      stage.releasePointerCapture(e.pointerId);
      stage.style.cursor = "grab";
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerup", up);
      stage.removeEventListener("pointercancel", up);
    };
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerup", up);
    stage.addEventListener("pointercancel", up);
  });
  new ResizeObserver(() => { if (viewer.open) applyZoom(); }).observe(stage);

  // ---- OCR for several selected photos at once, inserted in inbox order ----

  const batchDialog = $<HTMLDialogElement>("obatch-dialog");
  const batchList = $("obatch-list");
  const batchNote = $("obatch-note");
  const batchStart = $<HTMLButtonElement>("obatch-start");
  const batchInsert = $<HTMLButtonElement>("obatch-insert");
  const batchWithImage = $<HTMLInputElement>("obatch-with-image");
  type BatchItem = {
    p: Photo;
    text: HTMLTextAreaElement;
    state: HTMLElement;
    retry: HTMLButtonElement;
    status: "idle" | "busy" | "done" | "error" | "saved";
  };
  let batch: BatchItem[] = [];
  let batchPos = 0;
  let batchRun = 0; // bumped on open and close, so a request that returns late is ignored
  let batchStarted = false;
  const modelLabel = () => {
    const m = OCR_MODELS.find(([v]) => v === deps.settings().ocrModel);
    return m ? m[1].split(" - ")[0] : "";
  };

  function setItemState(it: BatchItem, text: string, kind: "busy" | "ok" | "error" | "info") {
    it.state.className = `obi-state ${kind === "error" ? "error" : ""}`;
    it.state.replaceChildren();
    if (kind === "busy") {
      const sp = document.createElement("span");
      sp.className = "spinner";
      it.state.append(sp);
    }
    it.state.append(text);
  }

  function updateBatchUi() {
    const plural = (n: number) => `${n} photo${n === 1 ? "" : "s"}`;
    const idle = batch.filter((i) => i.status === "idle").length;
    const saved = batch.filter((i) => i.status === "saved").length;
    const busy = batch.filter((i) => i.status === "busy").length;
    const failed = batch.filter((i) => i.status === "error" && !i.text.value.trim()).length;
    const filled = batch.filter((i) => i.text.value.trim()).length;
    let msg: string;
    let kind: "busy" | "ok" | "error" | "info" = "info";
    if (!batchStarted && idle) {
      msg = `${plural(idle)} will be transcribed with ${modelLabel()} and billed to your Anthropic account.` +
        (saved ? ` ${saved} already ${saved === 1 ? "has" : "have"} a saved transcription (no charge).` : "");
    } else if (busy) {
      msg = `Transcribing… ${batch.length - idle - busy} of ${batch.length} finished.`;
      kind = "busy";
    } else if (failed) {
      msg = `${failed} failed and will be skipped when you insert, unless you retry or type the text yourself.`;
      kind = "error";
    } else {
      msg = "Check each transcription against its photo, then insert them all.";
      kind = "ok";
    }
    batchNote.className = `ocr-state ${kind}`;
    batchNote.replaceChildren();
    if (kind === "busy") {
      const sp = document.createElement("span");
      sp.className = "spinner";
      batchNote.append(sp);
    }
    batchNote.append(msg);
    batchStart.hidden = batchStarted || !idle;
    batchStart.textContent = `Transcribe ${plural(idle)}`;
    batchInsert.disabled = busy > 0 || !filled;
    batchInsert.textContent = filled ? `Insert ${plural(filled)}` : "Insert";
    for (const it of batch) it.retry.hidden = it.status === "idle" || it.status === "busy";
  }

  async function openBatchOcr(ps: Photo[]) {
    if (!ps.length) return;
    if (deps.target() === null) throw new Error("Open a document to insert the transcriptions");
    const pos = await deps.pickInsertPoint("transcriptions");
    if (pos === null) return; // cancelled before anything was billed
    batchPos = pos;
    batchRun++;
    batchStarted = false;
    batchWithImage.checked = false;
    $("obatch-title").textContent = `Transcribe ${ps.length} photo${ps.length === 1 ? "" : "s"}`;
    $("obatch-model").textContent = modelLabel();
    batch = ps.map((p, i) => {
      const row = document.createElement("div");
      row.className = "obi";
      const imgBox = document.createElement("div");
      imgBox.className = "obi-img";
      const img = document.createElement("img");
      img.alt = "";
      imgBox.append(img);
      schedule(async () => { try { img.src = await thumbUrl(p); } catch {} });
      const head = document.createElement("div");
      head.className = "obi-head";
      const n = document.createElement("span");
      n.className = "obi-n";
      n.textContent = String(i + 1);
      n.title = "Position in the inserted text";
      const state = document.createElement("span");
      state.className = "obi-state";
      const retry = document.createElement("button");
      retry.className = "obi-retry";
      retry.textContent = "Transcribe again";
      retry.title = "Run the model again for this photo (billed)";
      head.append(n, state, retry);
      const text = document.createElement("textarea");
      text.spellcheck = false;
      text.placeholder = "The transcription appears here. You can edit it before inserting.";
      text.addEventListener("input", updateBatchUi);
      const main = document.createElement("div");
      main.className = "obi-main";
      main.append(head, text);
      row.append(imgBox, main);
      const it: BatchItem = { p, text, state, retry, status: p.ocr_latex ? "saved" : "idle" };
      if (p.ocr_latex) {
        text.value = p.ocr_latex;
        setItemState(it, "Saved transcription (no charge)", "info");
      } else {
        setItemState(it, "Not transcribed yet", "info");
      }
      retry.addEventListener("click", () => void retryItem(it));
      batchList.append(row);
      return it;
    });
    updateBatchUi();
    batchDialog.showModal();
  }

  async function transcribe(it: BatchItem, run: number) {
    it.status = "busy";
    setItemState(it, "Transcribing…", "busy");
    updateBatchUi();
    try {
      const jpeg = await bytesOf(await renderRotated(await original(it.p), 0, 1568, 0.85));
      const r = await invoke<{ latex: string; input_tokens: number; output_tokens: number; stop_reason: string }>(
        "ocr_image", jpeg, { headers: { "x-user": deps.user(), "x-model": deps.settings().ocrModel } },
      );
      if (run !== batchRun || !batchDialog.open) return;
      it.text.value = r.latex;
      void rememberOcr(it.p, r.latex);
      it.status = "done";
      const cut = r.stop_reason === "max_tokens";
      setItemState(it, cut ? "Done, but the output was cut off. Consider a smaller part." : "Done", cut ? "error" : "ok");
    } catch (e) {
      if (run !== batchRun || !batchDialog.open) return;
      it.status = "error";
      setItemState(it, String((e as Error)?.message ?? e), "error");
    }
    updateBatchUi();
  }

  async function hasKey(): Promise<boolean> {
    if (await invoke<boolean>("has_api_key", { user: deps.user() })) return true;
    batchNote.className = "ocr-state error";
    batchNote.textContent = "Add your Anthropic API key under Menu → Settings → Photo OCR, then try again.";
    return false;
  }

  async function startBatch() {
    if (!(await hasKey())) return;
    batchStarted = true;
    const run = batchRun;
    const todo = batch.filter((i) => i.status === "idle");
    updateBatchUi();
    let next = 0;
    // A few at a time: quick, but kind to the API's rate limits. The rows stay in inbox order regardless.
    const worker = async () => {
      while (next < todo.length && run === batchRun) await transcribe(todo[next++], run);
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  async function retryItem(it: BatchItem) {
    if (!(await hasKey())) return;
    batchStarted = true;
    await transcribe(it, batchRun);
  }

  async function insertBatch() {
    const items = batch.filter((i) => i.text.value.trim());
    if (!items.length) return;
    batchInsert.disabled = true;
    try {
      const parts: string[] = [];
      for (const it of items) {
        const image = batchWithImage.checked ? `${await placeImage(it.p, 0)}\n` : "";
        parts.push(`${image}${it.text.value.trim()}\n`);
      }
      await Promise.all(items.map(async (it) => {
        await rememberOcr(it.p, it.text.value); // keeps any edits you made
        await deps.api().markImported(it.p.id);
      }));
      batchDialog.close(); // before inserting, so the Undo toast is clickable
      deps.insertAt(batchPos, parts.join("\n")); // one insertion, so one Undo
      clearSelection();
      await refresh();
    } catch (e) {
      batchNote.className = "ocr-state error";
      batchNote.textContent = String((e as Error)?.message ?? e);
      batchInsert.disabled = false;
    }
  }

  batchStart.addEventListener("click", () => void startBatch());
  batchInsert.addEventListener("click", () => void insertBatch());
  batchDialog.addEventListener("close", () => {
    batchRun++;
    for (const it of batch) if (it.text.value.trim()) void rememberOcr(it.p, it.text.value);
    batchList.replaceChildren();
    batch = [];
  });

  // ---- OCR with review ----

  const ocrDialog = $<HTMLDialogElement>("ocr-dialog");
  const ocrImg = $<HTMLImageElement>("ocr-img");
  const ocrText = $<HTMLTextAreaElement>("ocr-text");
  const ocrState = $("ocr-state");
  const ocrInsert = $<HTMLButtonElement>("ocr-insert");
  const ocrRetry = $<HTMLButtonElement>("ocr-retry");
  const ocrWithImage = $<HTMLInputElement>("ocr-with-image");
  let ocrPhoto: Photo | null = null;
  let ocrPos = 0; // where the transcription goes, chosen before the dialog opened
  let ocrDeg = 0;
  let ocrRun = 0;
  let ocrUrl = "";

  function setOcrState(text: string, kind: "busy" | "ok" | "error" | "info") {
    ocrState.className = `ocr-state ${kind}`;
    ocrState.replaceChildren();
    if (kind === "busy") {
      const sp = document.createElement("span");
      sp.className = "spinner";
      ocrState.append(sp);
    }
    ocrState.append(text);
  }

  async function openOcr(p: Photo, deg = 0) {
    if (deps.target() === null) throw new Error("Open a document to insert the transcription");
    if (viewer.open) viewer.close(); // the editor has to be visible to pick a spot
    const pos = await deps.pickInsertPoint("transcription");
    if (pos === null) return; // cancelled before anything was billed
    ocrPos = pos;
    ocrPhoto = p;
    ocrDeg = deg;
    ocrText.value = "";
    ocrInsert.disabled = true;
    ocrWithImage.checked = false;
    const m = OCR_MODELS.find(([v]) => v === deps.settings().ocrModel);
    $("ocr-model").textContent = m ? m[1].split(" - ")[0] : "";
    if (ocrUrl) URL.revokeObjectURL(ocrUrl);
    ocrUrl = URL.createObjectURL(await renderRotated(await original(p), deg, 2400, 0.9));
    ocrImg.src = ocrUrl;
    ocrImg.classList.remove("zoomed");
    ocrDialog.showModal();
    // A saved transcription is shown as is; only "Transcribe again" pays for a new one.
    if (p.ocr_latex) {
      ocrText.value = p.ocr_latex;
      setOcrState("Saved transcription from earlier (no new charge). Check it against the photo, then insert. “Transcribe again” runs the model again and is billed.", "info");
      ocrInsert.disabled = false;
      return;
    }
    await runOcr();
  }

  /** Saves the text with the photo (best effort: a failure only means the next transcription is billed again). */
  async function rememberOcr(p: Photo, latex: string) {
    const text = latex.trim();
    if (!text || text === p.ocr_latex) return;
    try {
      await deps.api().saveOcr(p.id, text);
      p.ocr_latex = text;
    } catch {}
  }

  async function runOcr() {
    const p = ocrPhoto;
    if (!p) return;
    const run = ++ocrRun;
    ocrRetry.disabled = true;
    ocrInsert.disabled = true;
    if (!(await invoke<boolean>("has_api_key", { user: deps.user() }))) {
      setOcrState("Add your Anthropic API key under Menu → Settings → Photo OCR, then press Transcribe again.", "info");
      ocrRetry.disabled = false;
      return;
    }
    setOcrState("Transcribing…", "busy");
    try {
      const jpeg = await bytesOf(await renderRotated(await original(p), ocrDeg, 1568, 0.85));
      const r = await invoke<{ latex: string; input_tokens: number; output_tokens: number; stop_reason: string }>(
        "ocr_image", jpeg, { headers: { "x-user": deps.user(), "x-model": deps.settings().ocrModel } },
      );
      if (run !== ocrRun || !ocrDialog.open) return; // closed or restarted meanwhile
      ocrText.value = r.latex;
      void rememberOcr(p, r.latex);
      const cut = r.stop_reason === "max_tokens" ? " The output was cut off; consider transcribing a smaller part." : "";
      setOcrState(`Done.${cut} Check it against the photo, then insert.`, cut ? "error" : "ok");
      ocrInsert.disabled = false;
      ocrText.focus();
    } catch (e) {
      if (run !== ocrRun || !ocrDialog.open) return;
      setOcrState(String((e as Error)?.message ?? e), "error");
    } finally {
      if (run === ocrRun) ocrRetry.disabled = false;
    }
  }

  async function insertTranscription() {
    const p = ocrPhoto;
    const text = ocrText.value.trim();
    if (!p || !text) return;
    ocrInsert.disabled = true;
    try {
      const image = ocrWithImage.checked ? `${await placeImage(p, ocrDeg)}\n` : "";
      await rememberOcr(p, text); // keeps any edits you made
      await deps.api().markImported(p.id);
      ocrDialog.close(); // before inserting, so the Undo toast is clickable
      deps.insertAt(ocrPos, `${image}${text}\n`);
      await refresh();
    } catch (e) {
      setOcrState(String((e as Error)?.message ?? e), "error");
      ocrInsert.disabled = false;
    }
  }

  ocrRetry.addEventListener("click", () => void runOcr());
  ocrInsert.addEventListener("click", () => void insertTranscription());
  ocrImg.addEventListener("click", () => ocrImg.classList.toggle("zoomed"));
  ocrText.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void insertTranscription();
    }
  });
  ocrDialog.addEventListener("close", () => {
    ocrRun++; // a request still running is ignored when it comes back
    if (ocrPhoto && ocrText.value.trim()) void rememberOcr(ocrPhoto, ocrText.value);
    if (ocrUrl) URL.revokeObjectURL(ocrUrl);
    ocrUrl = "";
    ocrImg.removeAttribute("src");
  });

  return { refresh, dropPhoto };
}
