import type { EditorView } from "@codemirror/view";

/** Drag-and-drop payload type for an inbox photo (its id). */
export const PHOTO_MIME = "application/x-texture-photo";

/**
 * Choosing where an inbox photo (or its transcription) goes in the document.
 *
 * Insertion points are always line boundaries, never mid-line: "boundary b" means "before line b", and
 * boundary lines+1 is the end of the document. Hovering the top half of a line chooses the boundary above it,
 * the bottom half the one below, and a thin marker line shows the choice. Two ways in:
 *  - `pick()`: place mode, started by Insert / OCR… (click a spot, or ↑/↓ + Enter, Esc cancels);
 *  - dropping a dragged inbox card onto the editor, which calls `onDrop`.
 */
export function initPlacement(
  getView: () => EditorView | undefined,
  opts: { onDrop: (photoId: string, pos: number) => void },
) {
  let marker: HTMLElement | null = null;
  let session: { finish: (pos: number | null) => void } | null = null;

  const lineCount = (v: EditorView) => v.state.doc.lines;
  const posOf = (v: EditorView, b: number) => (b <= lineCount(v) ? v.state.doc.line(b).from : v.state.doc.length);

  /** The boundary nearest to a screen y. */
  function boundaryAt(v: EditorView, y: number): number {
    const box = v.contentDOM.getBoundingClientRect();
    const pos = v.posAtCoords({ x: box.left + 1, y }, false);
    const line = v.state.doc.lineAt(pos);
    const block = v.lineBlockAt(line.from);
    const mid = v.documentTop + (block.top + block.bottom) / 2;
    return y < mid ? line.number : line.number + 1;
  }

  function showMarker(v: EditorView, b: number) {
    if (!marker) {
      marker = document.createElement("div");
      marker.className = "place-marker";
      marker.setAttribute("aria-hidden", "true");
    }
    if (marker.parentElement !== v.dom) v.dom.append(marker);
    const doc = v.state.doc;
    const y = b <= doc.lines
      ? v.documentTop + v.lineBlockAt(doc.line(b).from).top
      : v.documentTop + v.lineBlockAt(doc.length).bottom;
    const area = v.scrollDOM.getBoundingClientRect();
    marker.hidden = y < area.top - 1 || y > area.bottom + 1;
    marker.style.top = `${y - v.dom.getBoundingClientRect().top}px`;
  }

  function hideMarker() {
    marker?.remove();
  }

  // ---- place mode ----

  function pick(what: string): Promise<number | null> {
    const v = getView();
    if (!v) return Promise.resolve(null);
    session?.finish(null); // a second request replaces the first

    return new Promise((resolve) => {
      let b = v.state.doc.lineAt(v.state.selection.main.head).number; // keyboard starts at the cursor's line
      const banner = document.createElement("div");
      banner.className = "place-banner";
      const text = document.createElement("span");
      text.textContent = `Choose where to insert the ${what}: click between lines (top half = above, bottom half = below), or use ↑ ↓ and Enter.`;
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel (Esc)";
      banner.append(text, cancel);
      v.dom.append(banner);
      v.dom.classList.add("placing");
      showMarker(v, b);

      let lastY: number | null = null;
      const onMove = (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest(".place-banner")) return;
        lastY = e.clientY;
        b = boundaryAt(v, e.clientY);
        showMarker(v, b);
      };
      // Without this, the press also reaches CodeMirror, which moves the cursor and focuses the editor, so the
      // blinking caret shows up while the photo is being saved or the OCR dialog is loading.
      const onDown = (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest(".place-banner")) return;
        e.preventDefault();
        e.stopPropagation();
      };
      const onClick = (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest(".place-banner")) return;
        e.preventDefault();
        e.stopPropagation();
        finish(posOf(v, boundaryAt(v, e.clientY)));
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        } else if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          finish(posOf(v, b));
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          e.stopPropagation();
          b = Math.min(lineCount(v) + 1, Math.max(1, b + (e.key === "ArrowDown" ? 1 : -1)));
          lastY = null;
          // Keep the marked line in view, then draw the marker again (scrolling moves it).
          const ln = v.state.doc.line(Math.min(b, lineCount(v)));
          const rect = v.coordsAtPos(ln.from);
          const area = v.scrollDOM.getBoundingClientRect();
          if (rect && rect.top < area.top + 40) v.scrollDOM.scrollTop -= area.top + 40 - rect.top;
          else if (rect && rect.bottom > area.bottom - 40) v.scrollDOM.scrollTop += rect.bottom - (area.bottom - 40);
          showMarker(v, b);
        }
      };
      const onScroll = () => {
        if (lastY !== null) b = boundaryAt(v, lastY);
        showMarker(v, b);
      };

      function finish(pos: number | null) {
        if (session?.finish !== finish) return;
        session = null;
        v!.dom.removeEventListener("mousemove", onMove);
        v!.dom.removeEventListener("mousedown", onDown, true);
        v!.dom.removeEventListener("click", onClick, true);
        document.removeEventListener("keydown", onKey, true);
        v!.scrollDOM.removeEventListener("scroll", onScroll);
        v!.dom.classList.remove("placing");
        banner.remove();
        hideMarker();
        resolve(pos);
      }
      session = { finish };
      v.dom.addEventListener("mousemove", onMove);
      v.dom.addEventListener("mousedown", onDown, true);
      v.dom.addEventListener("click", onClick, true);
      document.addEventListener("keydown", onKey, true);
      v.scrollDOM.addEventListener("scroll", onScroll);
      cancel.addEventListener("click", () => finish(null));
    });
  }

  // ---- drag and drop ----

  const isPhoto = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes(PHOTO_MIME);

  /** Called once the editor exists. */
  function attachDrop(v: EditorView) {
    // Capture phase, so CodeMirror's own drop handling never sees a photo drag.
    v.dom.addEventListener("dragover", (e) => {
      if (!isPhoto(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer!.dropEffect = "copy";
      showMarker(v, boundaryAt(v, e.clientY));
    }, true);
    v.dom.addEventListener("dragleave", (e) => {
      if (isPhoto(e) && !v.dom.contains(e.relatedTarget as Node | null)) hideMarker();
    }, true);
    v.dom.addEventListener("drop", (e) => {
      if (!isPhoto(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const id = e.dataTransfer!.getData(PHOTO_MIME);
      const pos = posOf(v, boundaryAt(v, e.clientY));
      hideMarker();
      if (id) opts.onDrop(id, pos);
    }, true);
  }

  return { pick, attachDrop };
}
