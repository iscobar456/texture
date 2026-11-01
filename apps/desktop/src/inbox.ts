import { invoke } from "@tauri-apps/api/core";
import type { createApi, Photo } from "@hwscan/api";
import { attachMenu } from "./popup";
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
  insertAtCursor: (text: string) => void;
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
  let usedOpen = false;
  let trashOpen = false;
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

  async function refresh() {
    try {
      // The photos waiting must always show. "Used" and "Trash" are extras: if they cannot be read (for example
      // before the matching database migration is applied), they are simply left out.
      const [pending, used, trash] = await Promise.all([
        deps.api().listPending(),
        deps.api().listUsed().catch(() => [] as Photo[]),
        deps.api().listTrashed().catch(() => [] as Photo[]),
      ]);
      lists = { pending, used, trash };
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
    const parts: HTMLElement[] = [];

    if (lists.pending.length) {
      const wrap = document.createElement("div");
      wrap.append(...lists.pending.map((p, i) => card(p, "pending", i)));
      parts.push(wrap);
    } else {
      parts.push(emptyState());
    }
    if (lists.used.length) {
      parts.push(section("Recently used", lists.used.length, usedOpen, (o) => (usedOpen = o), lists.used.map((p, i) => card(p, "used", i))));
    }
    if (lists.trash.length) {
      parts.push(section("Trash", lists.trash.length, trashOpen, (o) => (trashOpen = o), lists.trash.map((p, i) => card(p, "trash", i))));
    }
    list.replaceChildren(...parts);
  }

  function emptyState() {
    const all = [...lists.pending, ...lists.used, ...lists.trash];
    const newest = all.map((p) => p.created_at).sort().pop();
    const el = document.createElement("div");
    el.className = "inbox-empty";
    el.innerHTML = '<p><strong>No photos waiting</strong></p><p class="muted">Photos you take in the hwscan phone app appear here.</p>';
    const last = document.createElement("p");
    last.className = "muted";
    last.textContent = newest ? `Last photo received ${ago(newest)}.` : "Nothing has arrived from your phone yet.";
    el.append(last);
    return el;
  }

  /** A collapsible group ("Recently used", "Trash") that remembers whether it is open. */
  function section(title: string, count: number, open: boolean, remember: (open: boolean) => void, cards: HTMLElement[]) {
    const d = document.createElement("details");
    d.className = "inbox-section";
    d.open = open;
    const sum = document.createElement("summary");
    sum.textContent = `${title} (${count})`;
    d.append(sum, ...cards);
    d.addEventListener("toggle", () => remember(d.open));
    return d;
  }

  function card(p: Photo, kind: Section, index: number) {
    const el = document.createElement("div");
    el.className = "photo";

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
      imgBtn.addEventListener("click", () => openViewer(kind, index));
    }
    lazy.observe(img);

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
        button("Restore", "Move it back to the inbox", () => restore(p), "primary"),
        button("Delete forever…", "Permanently delete this photo", async () => deps.askDelete(p), ""),
      );
      actions.classList.add("two");
    } else {
      const more = document.createElement("button");
      more.textContent = "⋮";
      more.title = "More";
      more.setAttribute("aria-label", "More actions");
      attachMenu(more, document.body, [
        { label: "View larger", run: () => openViewer(kind, index) },
        { label: "Move to trash", danger: true, run: () => void trash(p) },
      ]);
      actions.append(
        button(kind === "used" ? "Insert again" : "Insert", "Insert the photo into the document at the cursor", async () => insertPhoto(p), "primary"),
        button("OCR…", "Transcribe the handwriting to LaTeX and review it first", async () => openOcr(p), ""),
        more,
      );
    }

    el.append(imgBtn, when, actions);
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

  async function insertPhoto(p: Photo, deg = 0) {
    deps.insertAtCursor(await placeImage(p, deg));
    await deps.api().markImported(p.id);
    await refresh();
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
      await insertPhoto(p, vDeg);
      if (viewer.open) viewer.close();
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

  // ---- OCR with review ----

  const ocrDialog = $<HTMLDialogElement>("ocr-dialog");
  const ocrImg = $<HTMLImageElement>("ocr-img");
  const ocrText = $<HTMLTextAreaElement>("ocr-text");
  const ocrState = $("ocr-state");
  const ocrInsert = $<HTMLButtonElement>("ocr-insert");
  const ocrRetry = $<HTMLButtonElement>("ocr-retry");
  const ocrWithImage = $<HTMLInputElement>("ocr-with-image");
  let ocrPhoto: Photo | null = null;
  let ocrDeg = 0;
  let ocrRun = 0;
  let ocrUrl = "";

  function cost(inTok: number, outTok: number): string {
    const m = OCR_MODELS.find(([v]) => v === deps.settings().ocrModel)!;
    const dollars = (inTok * m[2] + outTok * m[3]) / 1_000_000;
    return dollars < 0.01 ? `about ${(dollars * 100).toFixed(2)}¢` : `about $${dollars.toFixed(3)}`;
  }

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

  /** Saves the text with the photo (best effort: a failure only means the next OCR… run is billed again). */
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
      setOcrState(`Done · ${r.input_tokens} in / ${r.output_tokens} out · ${cost(r.input_tokens, r.output_tokens)}.${cut} Check it against the photo, then insert.`, cut ? "error" : "ok");
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
      deps.insertAtCursor(`${image}${text}\n`);
      await rememberOcr(p, text); // keeps any edits you made
      await deps.api().markImported(p.id);
      ocrDialog.close();
      if (viewer.open) viewer.close();
      deps.status("Transcription inserted");
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

  return { refresh };
}
