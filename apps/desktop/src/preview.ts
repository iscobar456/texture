import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- zoom: a per-device factor on the page width; pages are drawn sharper to match on the next render ----
const ZOOM_KEY = "texture:preview-zoom";
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
let zoom = 1;

function applyZoom() {
  $("pages").style.setProperty("--zoom", String(zoom));
  $("zoom-label").textContent = `${Math.round(zoom * 100)}%`;
  $<HTMLButtonElement>("zoom-out").disabled = zoom <= ZOOMS[0];
  $<HTMLButtonElement>("zoom-in").disabled = zoom >= ZOOMS[ZOOMS.length - 1];
}

function setZoom(z: number) {
  zoom = z;
  try { localStorage.setItem(ZOOM_KEY, String(z)); } catch {}
  applyZoom();
}

/** Wires the zoom buttons in the compile bar (− / 100% / +; the label resets to 100%). */
export function initPreviewZoom() {
  try {
    const saved = Number(localStorage.getItem(ZOOM_KEY));
    if (ZOOMS.includes(saved)) zoom = saved;
  } catch {}
  const step = (d: number) => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, ZOOMS.indexOf(zoom) + d))]);
  $("zoom-out").addEventListener("click", () => step(-1));
  $("zoom-in").addEventListener("click", () => step(1));
  $("zoom-label").addEventListener("click", () => setZoom(1));
  applyZoom();
}

/** Pixels per PDF point: 2 is crisp at 100%; zoomed-in pages get more, up to a cap that keeps long documents affordable. */
const renderScale = () => Math.min(4, 2 * Math.max(1, zoom));

/** Draws every page into the preview pane. Returns the first page (for thumbnails) and the page count. */
export async function renderPdf(data: Uint8Array): Promise<{ first: HTMLCanvasElement | undefined; pages: number }> {
  const pdf = await pdfjs.getDocument({ data }).promise;
  const canvases: HTMLCanvasElement[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: renderScale() });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvas, viewport }).promise;
    canvases.push(canvas);
  }
  $("pages").replaceChildren(...canvases); // swap at the end to avoid flicker
  return { first: canvases[0], pages: canvases.length };
}

/** A page canvas shrunk to a 360px-wide PNG, for thumbnails. */
export async function thumbPng(page: HTMLCanvasElement): Promise<Uint8Array | null> {
  const thumb = document.createElement("canvas");
  thumb.width = 360;
  thumb.height = Math.round((page.height / page.width) * 360);
  thumb.getContext("2d")!.drawImage(page, 0, 0, thumb.width, thumb.height);
  const blob = await new Promise<Blob | null>((r) => thumb.toBlob(r, "image/png"));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/** Renders only page 1 of a PDF (for thumbnails; the preview pane uses `renderPdf`). */
export async function firstPageCanvas(data: Uint8Array): Promise<HTMLCanvasElement> {
  const pdf = await pdfjs.getDocument({ data }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvas, viewport }).promise;
  return canvas;
}
