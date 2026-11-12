import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { EditorView, basicSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { Compartment, Prec } from "@codemirror/state";
import { StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { vim, Vim } from "@replit/codemirror-vim";
import { softTheme, softHighlight } from "./theme";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { indentWithTab, undo } from "@codemirror/commands";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { createApi, type Photo } from "@texture/api";
import { runSync } from "./sync";
import { EditorState } from "@codemirror/state";
import { latexSource, showKey, snippetKeymap } from "./completions";
import {
  DEFAULT_SNIPPETS_TOML,
  SNIPPETS_CONFIG,
  clearLegacySnippets,
  compile as compileSnippets,
  defaultCompiled,
  getActive,
  legacySnippetsToml,
  parseSnippets,
  setActive,
} from "./snippets";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { initSnippetsUi } from "./snippets-ui";
import { initShortcutsUi } from "./shortcuts";
import { initLayout } from "./layout";
import { formatDoc } from "./format";
import { initDialogs } from "./dialogs";
import { kebab, type MenuItem } from "./popup";
import { initInbox } from "./inbox";
import { initLatexSetup, latexSetupRunning, startLatexSetup } from "./latex-setup";
import { initPlacement } from "./placement";
import { toast } from "./toast";
import { initSwitcher, splitPath } from "./switcher";
import { initSyncUi, type Pending } from "./sync-ui";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { DEFAULTS, EDITOR_THEMES, OCR_MODELS, OCR_PROMPT_MAX, loadSettings, saveSettings, applyAppearance, type Settings } from "./settings";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Api = ReturnType<typeof createApi>;
type DocInfo = { path: string; dirty: boolean; snippet: string; has_preview: boolean };
type TemplateInfo = { path: string; builtin: boolean; dirty: boolean; has_preview: boolean };
type FolderInfo = { path: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
// Keyboard-navigation marker: set when Tab is pressed, cleared on any pointer press.
window.addEventListener("keydown", (e) => { if (e.key === "Tab") document.documentElement.setAttribute("data-keynav", ""); }, true);
window.addEventListener("pointerdown", () => document.documentElement.removeAttribute("data-keynav"), true);

/** One-off notices (export result, conflicts, errors) appear as toasts, not in the header. */
const status = (s: string) => { if (s) toast(s); };
/** A short-lived note over the bottom of the editor, for results of editor actions (e.g. Format). */
let noteTimer = 0;
function editorNote(s: string) {
  const el = $("editor-note");
  el.textContent = s;
  el.hidden = false;
  window.clearTimeout(noteTimer);
  noteTimer = window.setTimeout(() => (el.hidden = true), 5000);
}

// ---- session state (set once signed in) ----
let api: Api;
let user = "";
let docPath = ""; // path of the open document, e.g. "Physics/Week 3/HW 1"
/** Set while a template (not a document) is loaded in the editor; docPath keeps the last open document. */
let templateName: string | null = null;
/** Set while the snippets file is loaded in the editor (it edits like a document, but is TOML, not LaTeX). */
let snippetsOpen = false;
/** Problems found the last time the snippets file was parsed; empty means the active snippets match the file. */
let snippetErrors: string[] = [];

// ---- editor ----
let view: EditorView | undefined;
const vimSlot = new Compartment();
const wrapSlot = new Compartment();
const snippetSlot = new Compartment();
const langSlot = new Compartment();

let settings: Settings = loadSettings();
applyAppearance(settings); // before sign-in, so the login screen is themed too
let loadingDoc = false; // true while replacing the whole document, so it isn't saved as a user edit


const source = () => view!.state.doc.toString();

// What a pending edit belongs to; captured at edit time so switching documents can't misfile a save.
let pendingDoc: { kind: "document" | "template" | "snippets"; path: string } | null = null;
let saveTimer: number | undefined;
let autoTimer: number | undefined;

async function flushSave() {
  clearTimeout(saveTimer);
  if (pendingDoc === null) return;
  const p = pendingDoc;
  pendingDoc = null;
  if (p.kind === "template") await invoke("save_template", { user, name: p.path, source: source(), overwrite: true });
  else if (p.kind === "snippets") {
    // Always saved, even with mistakes (it is work in progress); only a valid file becomes active.
    await invoke("save_config", { user, name: p.path, source: source() });
    applySnippetsText(source());
  } else await invoke("save_source", { user, path: p.path, source: source() });
  syncSoon();
}

/** LaTeX (with its autocomplete) for documents and templates; plain TOML highlighting for the snippets file. */
function languageFor() {
  return snippetsOpen
    ? StreamLanguage.define(toml)
    : [StreamLanguage.define(stex), EditorState.languageData.of(() => [{ autocomplete: latexSource }])];
}

/** Snippet shortcuts must not fire while editing the snippets file itself. */
const snippetKeys = () => (snippetsOpen ? [] : snippetKeymap(getActive().keys));

/** Re-points the editor's language and shortcuts at whatever is loaded now. */
function applyEditorMode() {
  view?.dispatch({ effects: [langSlot.reconfigure(languageFor()), snippetSlot.reconfigure(snippetKeys())] });
}

function createEditor(doc: string) {
  view = new EditorView({
    doc,
    parent: $("editor"),
    extensions: [
      // Listed before vim() so Ctrl+Enter still wins over its key handling.
      Prec.highest(keymap.of([
        { key: "Mod-Enter", run: () => (void compile(), true) },
        { key: "Mod-Shift-f", run: () => (void formatDocument(), true), preventDefault: true },
      ])),
      snippetSlot.of(snippetKeys()), // before vim(), at the same precedence, so it wins
      vimSlot.of(settings.editing === "vim" ? vim() : []),
      basicSetup,
      langSlot.of(languageFor()),
      wrapSlot.of(settings.wrap ? EditorView.lineWrapping : []),
      softTheme,
      syntaxHighlighting(softHighlight),
      keymap.of([indentWithTab]),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged || loadingDoc) return;
        markStale();
        pendingDoc = snippetsOpen
          ? { kind: "snippets", path: SNIPPETS_CONFIG }
          : templateName !== null
            ? { kind: "template", path: templateName }
            : { kind: "document", path: docPath };
        clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => void flushSave(), 800);
        if (settings.autoCompile && !snippetsOpen) {
          clearTimeout(autoTimer);
          autoTimer = window.setTimeout(() => void compile(true), 1500);
        }
      }),
    ],
  });
  placement.attachDrop(view);
}

function setDoc(text: string) {
  loadingDoc = true;
  try {
    view!.dispatch({ changes: { from: 0, to: view!.state.doc.length, insert: text } });
  } finally {
    loadingDoc = false;
  }
}

/** Pushes the current settings into the live editor and the page. */
function applySettings() {
  applyAppearance(settings);
  view?.dispatch({
    effects: [
      vimSlot.reconfigure(settings.editing === "vim" ? vim() : []),
      wrapSlot.reconfigure(settings.wrap ? EditorView.lineWrapping : []),
    ],
  });
}

/** Formats the LaTeX with tex-fmt. One undo step; refuses (and says why) if the text does not balance. */
async function formatDocument() {
  if (!view) return;
  if (snippetsOpen) return void editorNote("Format is for LaTeX; the snippets file is TOML");
  const target = view;
  const startDoc = target.state.doc;
  const r = await formatDoc(startDoc, { wrap: settings.formatWrap, wrapLen: settings.formatWrapLen, indent: settings.formatIndent });
  if (!r.ok) return void editorNote(`Can't format: ${r.error}`);
  if (target.state.doc !== startDoc) return void editorNote("Edited while formatting; try again"); // the edits no longer line up
  if (!r.edits.length) return void editorNote("Already formatted");
  target.dispatch({ changes: r.edits, userEvent: "format" });
  editorNote(`Formatted: ${r.changedLines} line${r.changedLines === 1 ? "" : "s"} changed (Ctrl+Z undoes it)`);
}
$("format-doc").addEventListener("click", formatDocument);

// :w saves and compiles
Vim.defineEx("write", "w", () => void compile());
Vim.defineEx("fmt", "fmt", () => void formatDocument());

const placement = initPlacement(() => view, { onDrop: (id, pos) => void inbox.dropPhoto(id, pos) });

/** Inserts whole lines at a line boundary (see placement.ts), scrolls there and offers Undo. */
function insertAt(pos: number, text: string) {
  const v = view!;
  const at = Math.min(pos, v.state.doc.length);
  // At the very end of a file that lacks a final newline, start on a fresh line.
  const lead = at === v.state.doc.length && at > 0 && v.state.sliceDoc(at - 1, at) !== "\n" ? "\n" : "";
  const insert = lead + text;
  v.dispatch({
    changes: { from: at, insert },
    selection: { anchor: at + insert.length },
    effects: EditorView.scrollIntoView(at + lead.length, { y: "center" }),
  });
  v.focus();
  toast(`Inserted at line ${v.state.doc.lineAt(at + lead.length).number}`, { actionLabel: "Undo", onAction: () => { undo(v); v.focus(); }, ms: 8000 });
}

// ---- compile + preview ----
let compiling = false;

// ---- compile status bar (bottom of the preview) ----
type BarState =
  | { kind: "idle" }
  | { kind: "compiling" }
  | { kind: "ok"; text: string }
  | { kind: "failed"; text: string };

let bar: BarState = { kind: "idle" };
/** The document changed after the state in `bar` was produced. */
let stale = false;
/** Full text of the last problem report; "Show log" displays it again after it was hidden. */
let lastLog = "";

function renderBar() {
  const el = $("compile-state");
  el.className = bar.kind === "failed" ? "failed" : "muted";
  el.replaceChildren();
  if (bar.kind === "compiling") {
    const sp = document.createElement("span");
    sp.className = "spinner";
    el.append(sp, latexSetupRunning() ? "Setting up LaTeX (first run only)…" : "Compiling…");
  } else {
    el.append(bar.kind === "idle" ? "Not compiled yet" : bar.text);
    if (stale && bar.kind !== "idle") el.append(" · edited since");
  }
  const toggle = $("compile-log-toggle");
  const hasLog = bar.kind === "failed" || lastLog !== "";
  toggle.hidden = !hasLog;
  toggle.textContent = $("log").hidden ? "Show log" : "Hide log";
}

/** Shows (or hides, with null) the log text under the pages. */
function setLog(text: string | null) {
  if (text !== null) lastLog = text;
  $("log").hidden = text === null;
  if (text !== null) $("log").textContent = text;
  renderBar();
}

function setBar(next: BarState) {
  bar = next;
  if (next.kind !== "compiling") stale = false;
  renderBar();
}

/** Called when switching documents/templates: nothing has been compiled for this one yet. */
function resetBar() {
  lastLog = "";
  stale = false;
  $("log").hidden = true;
  setBar({ kind: "idle" });
}

function markStale() {
  if (stale) return;
  stale = true;
  renderBar();
}

$("compile-log-toggle").addEventListener("click", () => {
  if ($("log").hidden) setLog(lastLog);
  else setLog(null);
});

/** Bumped whenever the editor switches to a different document, template or the snippets file. */
let viewEpoch = 0;
/** A compile asked for while another was running; it runs afterwards, so the latest text always gets compiled. */
let queuedCompile: { quiet: boolean } | null = null;

/** `quiet` is for automatic compiles: a failure mid-typing shouldn't throw the error log at you. */
async function compile(quiet = false) {
  if (!view) return;
  if (snippetsOpen) {
    // Nothing to typeset: save, validate and apply the snippets file instead.
    pendingDoc = { kind: "snippets", path: SNIPPETS_CONFIG };
    await flushSave();
    return;
  }
  if (compiling) {
    // One manual request among the queued ones makes the whole follow-up manual (it should show errors).
    queuedCompile = { quiet: (queuedCompile?.quiet ?? true) && quiet };
    return;
  }
  compiling = true;
  stale = false; // edits made while this runs mark it stale again
  setBar({ kind: "compiling" });
  // What is being compiled, fixed now: by the time it finishes the editor may be showing something else.
  const epoch = viewEpoch;
  const path = docPath;
  const tname = templateName;
  const scratch = tname !== null;
  try {
    const bytes = new Uint8Array(await invoke<ArrayBuffer>("compile", { user, path: scratch ? tname : path, source: source(), scratch }));
    if (epoch !== viewEpoch) return; // you moved on; this result belongs to something no longer open
    lastLog = "";
    setLog(null);
    const { first, pages } = await renderPdf(bytes);
    if (first) void (scratch ? saveTemplateThumb(tname, first) : savePreview(path, first));
    const wasStale = stale; // typed while compiling
    setBar({ kind: "ok", text: `✓ Compiled ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${pages} page${pages === 1 ? "" : "s"}` });
    if (wasStale) markStale();
  } catch (e) {
    if (epoch !== viewEpoch) return;
    const wasStale = stale;
    lastLog = String(e);
    // A manual compile shows the log at once; an automatic one only reports it, with a link.
    setBar({ kind: "failed", text: "✗ Compile failed" });
    setLog(quiet ? null : lastLog);
    if (wasStale) markStale();
  } finally {
    compiling = false;
    if (queuedCompile) {
      const next = queuedCompile;
      queuedCompile = null;
      void compile(next.quiet);
    }
  }
}

async function renderPdf(data: Uint8Array): Promise<{ first: HTMLCanvasElement | undefined; pages: number }> {
  const pdf = await pdfjs.getDocument({ data }).promise;
  const canvases: HTMLCanvasElement[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 2 });
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
async function thumbPng(page: HTMLCanvasElement): Promise<Uint8Array | null> {
  const thumb = document.createElement("canvas");
  thumb.width = 360;
  thumb.height = Math.round((page.height / page.width) * 360);
  thumb.getContext("2d")!.drawImage(page, 0, 0, thumb.width, thumb.height);
  const blob = await new Promise<Blob | null>((r) => thumb.toBlob(r, "image/png"));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/** Renders only page 1 of a PDF (for thumbnails; the preview pane uses `renderPdf`). */
async function firstPageCanvas(data: Uint8Array): Promise<HTMLCanvasElement> {
  const pdf = await pdfjs.getDocument({ data }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvas, viewport }).promise;
  return canvas;
}

/** Stores a small PNG of page 1 for the document picker. Best effort. */
async function savePreview(path: string, page: HTMLCanvasElement) {
  const png = await thumbPng(page);
  if (!png) return;
  await invoke("save_preview", png, {
    headers: { "x-user": user, "x-path": encodeURIComponent(path) },
  }).then(syncSoon, () => {});
}

/** Same for a template (local only; thumbnails are rebuilt on each device). Best effort. */
async function saveTemplateThumb(name: string, page: HTMLCanvasElement) {
  const png = await thumbPng(page);
  if (!png) return;
  await invoke("save_template_preview", png, {
    headers: { "x-user": user, "x-name": encodeURIComponent(name) },
  }).catch(() => {});
}

$("compile").addEventListener("click", () => void compile());

// Documents live in the app's private data folder; this is how a PDF gets out.
$("export-pdf").addEventListener("click", async () => {
  if (!view) return;
  if (snippetsOpen) return void status("The snippets file has nothing to export");
  const target = templateName ?? docPath;
  let dest = await save({
    defaultPath: `${baseOf(target)}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!dest) return;
  if (!dest.toLowerCase().endsWith(".pdf")) dest += ".pdf";
  try {
    await flushSave();
    await invoke("export_pdf", { user, path: target, source: source(), scratch: templateName !== null, dest });
    status(`Exported to ${dest}`);
  } catch (e) {
    setLog(String(e));
    status("Export failed");
  }
});

$("preview-export").addEventListener("click", () => $("export-pdf").click());

initShortcutsUi(() => settings.editing === "vim");
initDialogs(() => view?.focus());
initLatexSetup(renderBar); // the compile bar says so when a compile is waiting on the first-run download
const layout = initLayout();
const inbox = initInbox({
  api: () => api,
  user: () => user,
  settings: () => settings,
  target: () => (templateName !== null || snippetsOpen ? null : docPath),
  pickInsertPoint: (what) => placement.pick(what),
  insertAt,
  status,
  askDelete: (p) => askDeletePhoto(p),
  onCount: (n) => layout.setInboxCount(n),
});

const inboxRefresh = $<HTMLButtonElement>("inbox-refresh");
inboxRefresh.addEventListener("click", async () => {
  inboxRefresh.classList.add("spinning");
  inboxRefresh.disabled = true;
  const minShown = new Promise((r) => setTimeout(r, 500)); // so a fast refresh still visibly happens
  await Promise.all([inbox.refresh(), minShown]);
  inboxRefresh.classList.remove("spinning");
  inboxRefresh.disabled = false;
});

// ---- snippets: one user-owned TOML file (see default-snippets.toml) ----
const snippetsUi = initSnippetsUi({
  errors: () => snippetErrors,
  onEdit: () => void openSnippetsFile(),
  onReset: resetSnippets,
});

/** Parses the file text. A valid file becomes active; an invalid one is reported and the old one stays. */
function applySnippetsText(text: string): boolean {
  const r = parseSnippets(text);
  snippetErrors = r.errors;
  if (r.config) {
    setActive(compileSnippets(r.config));
    view?.dispatch({ effects: snippetSlot.reconfigure(snippetKeys()) });
  }
  snippetsUi.render();
  if (snippetsOpen) showSnippetStatus();
  return r.config !== null;
}

function showSnippetStatus() {
  if (snippetErrors.length) {
    const n = snippetErrors.length;
    const text = `The snippets file has ${n} problem${n === 1 ? "" : "s"}. ` +
      `The last working version stays active until they are fixed:\n\n${snippetErrors.map((e) => `• ${e}`).join("\n")}`;
    setBar({ kind: "failed", text: `✗ Snippets: ${n} problem${n === 1 ? "" : "s"}` });
    setLog(text);
  } else {
    setLog(null);
    lastLog = "";
    setBar({ kind: "ok", text: "✓ Snippets applied" });
  }
}

const SNIPPETS_ORIGINAL_URL = "https://github.com/iscobar456/texture/blob/main/apps/desktop/src/default-snippets.toml";
/** What was open before the snippets file, so Back can return to it. */
let snippetsReturn: { template: string | null } = { template: null };

/** Shows the snippets bar above the editor only while the snippets file is the thing being edited. */
function syncSnippetsBar() {
  $("snip-bar").hidden = !snippetsOpen;
  $("editor").classList.toggle("snip-mode", snippetsOpen);
}

async function closeSnippetsFile() {
  if (snippetsReturn.template !== null) await openTemplate(snippetsReturn.template);
  else if (docPath) await openDocument(docPath);
  else await openAnyDocument();
}

$("snip-back").addEventListener("click", () => void closeSnippetsFile());
$("snip-restore").addEventListener("click", () => $<HTMLDialogElement>("snip-reset-dialog").showModal());
$("snip-original").addEventListener("click", () => void openUrl(SNIPPETS_ORIGINAL_URL).catch(() => status("Could not open the browser")));

async function openSnippetsFile() {
  await flushSave();
  if (!snippetsOpen) snippetsReturn = { template: templateName };
  const text = (await invoke<string | null>("load_config", { user, name: SNIPPETS_CONFIG })) ?? DEFAULT_SNIPPETS_TOML;
  viewEpoch++;
  snippetsOpen = true;
  templateName = null;
  syncSnippetsBar();
  if (view) setDoc(text);
  else createEditor(text);
  applyEditorMode();
  $("pages").replaceChildren();
  setDocLabel("", "Snippets file");
  markOpenItem(syncUi.getPending());
  showSnippetStatus();
  view?.focus();
}

async function resetSnippets() {
  await flushSave();
  await invoke("save_config", { user, name: SNIPPETS_CONFIG, source: DEFAULT_SNIPPETS_TOML });
  applySnippetsText(DEFAULT_SNIPPETS_TOML);
  if (snippetsOpen) setDoc(DEFAULT_SNIPPETS_TOML);
  syncSoon();
}

/** At sign-in: load the user's file, or create it from the defaults (plus any snippets from the old editor). */
async function initSnippets() {
  let text = await invoke<string | null>("load_config", { user, name: SNIPPETS_CONFIG });
  if (text === null) {
    const withOld = DEFAULT_SNIPPETS_TOML + legacySnippetsToml();
    // Old snippets are only carried over if the result is still a valid file.
    text = parseSnippets(withOld).config ? withOld : DEFAULT_SNIPPETS_TOML;
    await invoke("save_config", { user, name: SNIPPETS_CONFIG, source: text });
    clearLegacySnippets();
    syncSoon();
  }
  if (!applySnippetsText(text)) {
    setActive(defaultCompiled());
    snippetsUi.render();
    status("Your snippets file has problems, so the defaults are in use. Fix it under Menu → Snippets.");
  }
}

// ---- settings ----
const field = {
  theme: $<HTMLSelectElement>("set-theme"),
  editorTheme: $<HTMLSelectElement>("set-editor-theme"),
  editing: $<HTMLSelectElement>("set-editing"),
  font: $<HTMLInputElement>("set-font"),
  wrap: $<HTMLInputElement>("set-wrap"),
  linenos: $<HTMLInputElement>("set-linenos"),
  fmtIndent: $<HTMLSelectElement>("set-fmt-indent"),
  fmtWrap: $<HTMLInputElement>("set-fmt-wrap"),
  fmtLen: $<HTMLInputElement>("set-fmt-len"),
  auto: $<HTMLInputElement>("set-auto"),
  template: $<HTMLSelectElement>("set-template"),
  ocrModel: $<HTMLSelectElement>("set-ocr-model"),
};

// The built-in OCR instructions live in Rust. The box shows what will actually be sent; settings store ""
// while it matches the default, so a future improvement to the default reaches people who never edited it.
let defaultOcrPrompt = "";
void invoke<string>("ocr_default_prompt").then((p) => {
  defaultOcrPrompt = p;
  showPromptState();
});

function showSettings() {
  field.theme.value = settings.theme;
  field.ocrModel.value = settings.ocrModel;
  showPromptState();
  field.editorTheme.value = settings.editorTheme;
  field.editing.value = settings.editing;
  field.font.value = String(settings.fontSize);
  field.wrap.checked = settings.wrap;
  field.linenos.checked = settings.lineNumbers;
  field.fmtIndent.value = settings.formatIndent;
  field.fmtWrap.checked = settings.formatWrap;
  field.fmtLen.value = String(settings.formatWrapLen);
  field.fmtLen.disabled = !settings.formatWrap;
  field.auto.checked = settings.autoCompile;
}

// -- OCR API key (stored by the Rust side; the key itself never comes back to the page) --
const ocrKey = $<HTMLInputElement>("set-ocr-key");
const ocrStatus = $("set-ocr-status");
const ocrBadge = $("set-ocr-badge");
const ocrSave = $<HTMLButtonElement>("set-ocr-save");
const ocrTest = $<HTMLButtonElement>("set-ocr-test");
const ocrRemove = $<HTMLButtonElement>("set-ocr-remove");
const ocrShow = $<HTMLButtonElement>("set-ocr-show");
let keySaved = false;

function keyNote(text: string, kind: "" | "ok" | "err" = "") {
  ocrStatus.textContent = text;
  ocrStatus.className = `muted ${kind}`.trim();
}

/** Save needs something typed; Test and Remove need a saved key. */
function syncKeyButtons(busy = false) {
  ocrSave.disabled = busy || !ocrKey.value.trim();
  ocrTest.disabled = busy || !keySaved;
  ocrRemove.disabled = busy || !keySaved;
}

async function refreshKeyStatus() {
  keySaved = await invoke<boolean>("has_api_key", { user });
  ocrBadge.textContent = keySaved ? "Key saved on this device" : "No key saved";
  ocrBadge.classList.toggle("saved", keySaved);
  ocrKey.placeholder = keySaved ? "Paste a new key to replace the saved one" : "sk-ant-…";
  syncKeyButtons();
}

async function keyAction(label: string, fn: () => Promise<void>) {
  keyNote(`${label}…`);
  syncKeyButtons(true);
  try {
    await fn();
  } catch (e) {
    keyNote(String(e), "err");
  }
  syncKeyButtons();
}

ocrKey.addEventListener("input", () => {
  syncKeyButtons();
  keyNote("");
});
ocrKey.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !ocrSave.disabled) {
    e.preventDefault();
    ocrSave.click();
  }
});
ocrShow.addEventListener("click", () => {
  const show = ocrKey.type === "password";
  ocrKey.type = show ? "text" : "password";
  ocrShow.textContent = show ? "Hide" : "Show";
  ocrShow.setAttribute("aria-pressed", String(show));
});

ocrSave.addEventListener("click", () =>
  keyAction("Saving", async () => {
    if (!ocrKey.value.trim()) throw new Error("Paste a key first.");
    await invoke("set_api_key", { user, key: ocrKey.value });
    ocrKey.value = "";
    await refreshKeyStatus();
    keyNote("Saved. Use Test key to check it works.", "ok");
  }),
);
ocrTest.addEventListener("click", () =>
  keyAction("Testing", async () => {
    await invoke("test_api_key", { user });
    keyNote("✓ The key works.", "ok");
  }),
);
ocrRemove.addEventListener("click", () =>
  keyAction("Removing", async () => {
    await invoke("set_api_key", { user, key: "" });
    await refreshKeyStatus();
    keyNote("Key removed.");
  }),
);

// Changes apply immediately; there is no OK button.
function readSettings() {
  const size = Number(field.font.value);
  settings = {
    theme: field.theme.value as Settings["theme"],
    editorTheme: field.editorTheme.value as Settings["editorTheme"],
    editing: field.editing.value as Settings["editing"],
    fontSize: Number.isFinite(size) && size >= 10 && size <= 28 ? Math.round(size) : settings.fontSize,
    wrap: field.wrap.checked,
    lineNumbers: field.linenos.checked,
    formatIndent: field.fmtIndent.value as Settings["formatIndent"],
    formatWrap: field.fmtWrap.checked,
    formatWrapLen: Number.isFinite(Number(field.fmtLen.value)) && Number(field.fmtLen.value) >= 20 && Number(field.fmtLen.value) <= 300 ? Math.round(Number(field.fmtLen.value)) : settings.formatWrapLen,
    autoCompile: field.auto.checked,
    defaultTemplate: field.template.value || settings.defaultTemplate,
    ocrModel: field.ocrModel.value as Settings["ocrModel"],
    ocrPrompt: settings.ocrPrompt,
  };
  field.fmtLen.disabled = !field.fmtWrap.checked;
  saveSettings(settings);
  applySettings();
}

field.ocrModel.replaceChildren(...OCR_MODELS.map(([value, label]) => new Option(label, value)));
field.editorTheme.replaceChildren(...EDITOR_THEMES.map(([value, label]) => new Option(label, value)));
Object.values(field).forEach((el) => el.addEventListener("change", readSettings));

const promptText = $<HTMLTextAreaElement>("ocr-prompt-text");
function showPromptState() {
  $("set-ocr-prompt-state").textContent = settings.ocrPrompt ? "Customized" : "Default";
}
function showPromptCount() {
  $("ocr-prompt-count").textContent = `${promptText.value.length} / ${OCR_PROMPT_MAX}`;
}
$("set-ocr-prompt-edit").addEventListener("click", () => {
  promptText.value = settings.ocrPrompt || defaultOcrPrompt;
  showPromptCount();
  $<HTMLDialogElement>("ocr-prompt-dialog").showModal();
  promptText.focus();
});
promptText.addEventListener("input", showPromptCount);
$("ocr-prompt-reset").addEventListener("click", () => {
  promptText.value = defaultOcrPrompt;
  showPromptCount();
});
$("ocr-prompt-save").addEventListener("click", () => {
  const v = promptText.value.trim();
  // Stored as "" while it matches the default, so a better default later reaches people who never edited it.
  settings = { ...settings, ocrPrompt: !v || v === defaultOcrPrompt.trim() ? "" : promptText.value };
  saveSettings(settings);
  showPromptState();
  $<HTMLDialogElement>("ocr-prompt-dialog").close();
});

$("settings-reset").addEventListener("click", () => {
  settings = { ...DEFAULTS };
  saveSettings(settings);
  applySettings();
  showSettings();
});

$("open-settings").addEventListener("click", async () => {
  showSettings();
  const templates = await invoke<TemplateInfo[]>("list_templates", { user });
  field.template.replaceChildren(...templates.map((t) => new Option(t.path, t.path)));
  field.template.value = templates.some((t) => t.path === settings.defaultTemplate) ? settings.defaultTemplate : templates[0].path;
  const email = (await api.sb.auth.getSession()).data.session?.user.email;
  $("set-account").textContent = email ? `Signed in as ${email}` : "";
  ocrKey.value = "";
  keyNote("");
  void refreshKeyStatus();
  $<HTMLDialogElement>("settings-dialog").showModal();
});

// ---- quick switcher (Ctrl+P) ----
const switcher = initSwitcher({
  docs: () => invoke<DocInfo[]>("list_documents", { user }),
  recents,
  current: () => (templateName === null && !snippetsOpen ? docPath : ""),
  open: (path) => openDocument(path),
  create: async (path) => {
    await invoke("create_document", { user, path, template: await defaultTemplateName() });
    await openDocument(path);
  },
});

/** Ctrl/Cmd+N: opens the picker on Documents (in the current document's folder) and its New document dialog. */
async function newDocumentShortcut() {
  await openPicker("documents");
  $("new-document").click();
}

$("menu-new-doc").addEventListener("click", () => void newDocumentShortcut());

// App-level shortcuts. Captured early so the editor (and Vim) never see them; ignored while a dialog is open.
document.addEventListener(
  "keydown",
  (e) => {
    if (!user || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (e.key.toLowerCase() === "p" && !document.querySelector("dialog[open]")) {
      e.preventDefault();
      e.stopPropagation();
      void switcher.open();
    } else if (e.key.toLowerCase() === "n" && !document.querySelector("dialog[open]")) {
      e.preventDefault();
      e.stopPropagation();
      void newDocumentShortcut();
    } else if (e.key === "," && !document.querySelector("dialog[open]")) {
      e.preventDefault();
      e.stopPropagation();
      $("open-settings").click();
    }
  },
  true,
);

// ---- menu ----
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
  if (!document.querySelector("dialog[open]")) view?.focus();
});
document.addEventListener("click", () => setMenu(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menuList.hidden) setMenu(false); });

// ---- documents, folders, templates ----
const lastKey = () => `texture:last:${user}`;
const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0));
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The document button: folder part dimmed, name in full strength; the whole path is the tooltip. */
function setDocLabel(dir: string, name: string, full = dir + name) {
  $("crumb-dir").textContent = dir;
  $("crumb-name").textContent = name;
  $("doc-button").title = `${full}\nOpen or create a document (Ctrl+P to search)`;
}

// Most recently opened documents, newest first, kept per account on this device.
const recentKey = () => `texture:recent:${user}`;
function recents(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(recentKey()) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function recordRecent(path: string) {
  try { localStorage.setItem(recentKey(), JSON.stringify([path, ...recents().filter((p) => p !== path)].slice(0, 30))); } catch {}
}

async function openDocument(path: string) {
  await flushSave();
  viewEpoch++;
  docPath = path;
  templateName = null;
  snippetsOpen = false;
  syncSnippetsBar();
  try { localStorage.setItem(lastKey(), path); } catch {}
  const text = await invoke<string>("load_source", { user, path });
  if (view) setDoc(text);
  else createEditor(text);
  applyEditorMode();
  $("pages").replaceChildren();
  resetBar();
  setDocLabel(splitPath(path).dir, splitPath(path).name, path);
  recordRecent(path);
  markOpenItem(syncUi.getPending());
  void inbox.refresh();
  syncSoon();
  void compile(true); // so the preview is there when you arrive; an error only shows in the status bar
}

async function openTemplate(name: string) {
  await flushSave();
  viewEpoch++;
  templateName = name;
  snippetsOpen = false;
  syncSnippetsBar();
  const text = await invoke<string>("read_template", { user, name });
  if (view) setDoc(text);
  else createEditor(text);
  applyEditorMode();
  $("pages").replaceChildren();
  resetBar();
  setDocLabel("Template / ", name);
  markOpenItem(syncUi.getPending());
  void compile(true); // same as opening a document: the preview is there on arrival
}

// Cancel is type="button" so that pressing Enter in a field submits via the OK button, not Cancel.
document.querySelectorAll<HTMLButtonElement>("dialog .cancel").forEach((b) => {
  b.addEventListener("click", () => b.closest("dialog")!.close());
});

function dialogOpen(dlg: HTMLDialogElement, input: HTMLInputElement) {
  input.value = "";
  dlg.showModal();
  input.focus();
}

// -- ⋮ menus --

// -- document picker --
let pickerFolder = ""; // "" is the top level
let previewUrls: string[] = [];

const FOLDER_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.3h8.8A1.5 1.5 0 0 1 21 8.8v8.7a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="currentColor"/></svg>';

/** A small amber dot marking something that has not been uploaded yet. */
function dotEl(tip: string): HTMLElement {
  const dot = document.createElement("span");
  dot.className = "dot warn";
  dot.title = tip;
  return dot;
}

/** Goes to the parent of the folder the picker is showing (no-op at the top level). */
function pickerUp() {
  if (!pickerFolder) return;
  pickerFolder = parentOf(pickerFolder);
  void renderPicker();
}

async function renderPicker() {
  previewUrls.forEach((u) => URL.revokeObjectURL(u));
  previewUrls = [];
  const [docs, folderInfos] = await Promise.all([
    invoke<DocInfo[]>("list_documents", { user }),
    invoke<FolderInfo[]>("list_folders", { user }),
  ]);
  const folders = folderInfos.map((f) => f.path);

  $("picker-up").hidden = pickerFolder === "";

  // Breadcrumb: Documents / Physics / Week 3
  const crumbs = $("crumbs");
  const parts = pickerFolder ? pickerFolder.split("/") : [];
  const crumb = (label: string, target: string) => {
    const b = document.createElement("button");
    b.className = "crumb";
    b.textContent = label;
    b.onclick = () => { pickerFolder = target; void renderPicker(); };
    return b;
  };
  crumbs.replaceChildren(
    crumb("All documents", ""),
    ...parts.flatMap((part, i) => [" / ", crumb(part, parts.slice(0, i + 1).join("/"))]),
  );

  const cards: HTMLElement[] = [];

  // A card is a div (not a button) because it contains the action buttons.
  const makeCard = (cls: string, path: string, kind: "document" | "folder", onOpen: () => void) => {
    const card = document.createElement("div");
    card.className = `card ${cls}`;
    card.tabIndex = 0;
    card.onclick = onOpen;
    card.onkeydown = (e) => { if (e.key === "Enter") onOpen(); };
    const items: MenuItem[] = [
      { label: "Rename…", run: () => askRename(path) },
      { label: "Move…", run: () => void askMove(path, kind) },
      ...(kind === "document" ? [{ label: "Duplicate", run: () => void duplicate("document", path) }] : []),
      ...(kind === "document" ? [{ label: "Save as template…", run: () => askSaveTemplate(path) }] : []),
      { label: "Delete", danger: true, run: () => askDelete(path, kind) },
    ];
    card.append(kebab($("picker"), items));
    return card;
  };

  for (const f of folders.filter((f) => parentOf(f) === pickerFolder)) {
    const count = docs.filter((d) => d.path.startsWith(f + "/")).length;
    const card = makeCard("folder", f, "folder", () => { pickerFolder = f; void renderPicker(); });
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    thumb.innerHTML = FOLDER_ICON;
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = baseOf(f);
    const meta = document.createElement("div");
    meta.className = "meta";
    const unsynced = docs.filter((d) => d.dirty && d.path.startsWith(f + "/")).length;
    meta.textContent = `${count} document${count === 1 ? "" : "s"}${unsynced ? ` · ${unsynced} waiting to upload` : ""}`;
    if (unsynced) title.prepend(dotEl("Contains changes waiting to upload"));
    card.append(thumb, title, meta);
    cards.push(card);
  }
  for (const d of docs.filter((d) => parentOf(d.path) === pickerFolder)) {
    const card = makeCard("doc" + (templateName === null && !snippetsOpen && d.path === docPath ? " current" : ""), d.path, "document", async () => {
      $<HTMLDialogElement>("picker").close();
      await openDocument(d.path);
    });
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    if (d.has_preview) {
      invoke<ArrayBuffer>("read_preview", { user, path: d.path })
        .then((buf) => {
          const url = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
          previewUrls.push(url);
          const img = document.createElement("img");
          img.src = url;
          thumb.replaceChildren(img);
        })
        .catch(() => {});
    } else {
      // Never compiled anywhere yet: show the start of the source instead.
      const pre = document.createElement("pre");
      pre.textContent = d.snippet || "(empty)";
      thumb.append(pre);
    }
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = baseOf(d.path);
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = d.dirty ? "Waiting to upload" : "";
    if (d.dirty) title.prepend(dotEl("Changes not uploaded yet"));
    card.append(thumb, title, meta);
    cards.push(card);
  }
  $("doc-grid").replaceChildren(...cards);
  if (!cards.length) $("doc-grid").textContent = "Nothing here yet.";
}

// The picker has two tabs, Documents and Templates; it opens on whichever kind you are editing now.
type PickerTab = "documents" | "templates";
let pickerTab: PickerTab = "documents";

async function setPickerTab(tab: PickerTab) {
  pickerTab = tab;
  const docs = tab === "documents";
  for (const t of ["documents", "templates"] as const) $(`tab-${t}`).setAttribute("aria-selected", String(t === tab));
  $("doc-grid").hidden = !docs;
  $("tpl-grid").hidden = docs;
  $("docs-subbar").hidden = !docs;
  $("new-folder").hidden = !docs;
  $("new-document").hidden = !docs;
  $("new-tpl").hidden = docs;
  if (docs) await renderPicker();
  else await renderTemplates();
}

/** Re-renders whatever the picker is showing (after a sync, a deletion, ...). */
const refreshPicker = () => (pickerTab === "documents" ? renderPicker() : renderTemplates());

async function openPicker(tab: PickerTab) {
  await flushSave(); // so snippets and dirty flags are current
  pickerFolder = parentOf(docPath);
  await setPickerTab(tab);
  $<HTMLDialogElement>("picker").showModal();
}

$("doc-button").addEventListener("click", () => void openPicker(templateName !== null ? "templates" : "documents"));
$("manage-templates").addEventListener("click", () => void openPicker("templates"));
$("tab-documents").addEventListener("click", () => void setPickerTab("documents"));
$("tab-templates").addEventListener("click", () => void setPickerTab("templates"));
// Arrow keys switch tabs when one has focus.
$("picker").querySelector('[role="tablist"]')!.addEventListener("keydown", (e) => {
  const k = (e as KeyboardEvent).key;
  if (k !== "ArrowLeft" && k !== "ArrowRight") return;
  e.preventDefault();
  const next: PickerTab = pickerTab === "documents" ? "templates" : "documents";
  void setPickerTab(next).then(() => $(`tab-${next}`).focus());
});
$("picker-up").addEventListener("click", pickerUp);
// File-manager habits: Alt+Up or Backspace (when not typing in a field) goes up a folder.
$("picker").addEventListener("keydown", (e) => {
  const typing = (e.target as HTMLElement).closest("input, textarea, select") !== null;
  if (pickerTab !== "documents") return;
  if ((e.altKey && e.key === "ArrowUp") || (e.key === "Backspace" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey)) {
    if (!pickerFolder) return;
    e.preventDefault();
    pickerUp();
  }
});
$("picker-close").addEventListener("click", () => $<HTMLDialogElement>("picker").close());

// -- rename / move / delete --
const remap = (path: string, from: string, to: string) =>
  path === from ? to : path.startsWith(from + "/") ? to + path.slice(from.length) : path;

/** After moving `from` to `to`, keep the editor pointed at the same document. */
function followMove(from: string, to: string) {
  const next = remap(docPath, from, to);
  if (next === docPath) return;
  docPath = next;
  setDocLabel(splitPath(next).dir, splitPath(next).name, next);
  try { localStorage.setItem(lastKey(), next); } catch {}
}

async function doMove(from: string, to: string) {
  await flushSave(); // pending edits belong to the old path
  await invoke("move_item", { user, from, to });
  followMove(from, to);
  syncSoon();
}

/** Copies a document or template next to the original and shows where the copy is. */
async function duplicate(kind: "document" | "template", path: string) {
  try {
    await flushSave();
    const copy = await invoke<string>(kind === "document" ? "duplicate_document" : "duplicate_template", kind === "document" ? { user, path } : { user, name: path });
    syncSoon();
    void refreshPicker();
    toast(`Created "${baseOf(copy)}"`);
  } catch (err) {
    toast(String(err));
  }
}

let renameFrom = "";
let renameTemplate = false;
function askRename(path: string, template = false) {
  renameFrom = path;
  renameTemplate = template;
  $("rename-error").textContent = "";
  dialogOpen($<HTMLDialogElement>("rename-dialog"), $<HTMLInputElement>("rename-name"));
  $<HTMLInputElement>("rename-name").value = template ? path : baseOf(path);
  $<HTMLInputElement>("rename-name").select();
}

$("rename-form").addEventListener("submit", async (e) => {
  const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value !== "ok") return;
  const parent = renameTemplate ? "" : parentOf(renameFrom);
  const name = $<HTMLInputElement>("rename-name").value.trim();
  const to = parent ? `${parent}/${name}` : name;
  if (to === renameFrom) return;
  try {
    if (renameTemplate) {
      await flushSave();
      await invoke("rename_template", { user, from: renameFrom, to });
      syncSoon();
      if (templateName === renameFrom) await openTemplate(to);
    } else await doMove(renameFrom, to);
  } catch (err) {
    e.preventDefault();
    $("rename-error").textContent = String(err);
    return;
  }
  void refreshPicker();
});

let moveFrom = "";
async function askMove(path: string, kind: "document" | "folder") {
  moveFrom = path;
  const folders = (await invoke<FolderInfo[]>("list_folders", { user })).map((f) => f.path);
  // A folder can't be moved into itself or anything inside it.
  const targets = folders.filter((f) => kind === "document" || (f !== path && !f.startsWith(path + "/")));
  const sel = $<HTMLSelectElement>("move-target");
  sel.replaceChildren(new Option("Documents (top level)", ""), ...targets.map((f) => new Option(f, f)));
  sel.value = parentOf(path);
  $("move-what").textContent = `Move "${baseOf(path)}" to:`;
  $("move-error").textContent = "";
  $<HTMLDialogElement>("move-dialog").showModal();
}

$("move-form").addEventListener("submit", async (e) => {
  const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value !== "ok") return;
  const dest = $<HTMLSelectElement>("move-target").value;
  const to = dest ? `${dest}/${baseOf(moveFrom)}` : baseOf(moveFrom);
  if (to === moveFrom) return;
  try {
    await doMove(moveFrom, to);
  } catch (err) {
    e.preventDefault();
    $("move-error").textContent = String(err);
    return;
  }
  void renderPicker();
});

let deletePath = "";
let deleteKind: "document" | "folder" | "template" | "photo" = "document";
let deletePhotoTarget: Photo | null = null;

function askDeletePhoto(p: Photo) {
  deleteKind = "photo";
  deletePhotoTarget = p;
  $("delete-what").textContent = "Delete this photo permanently? It is removed from your account and cannot be restored. A copy in your phone's gallery is not affected.";
  $("delete-error").textContent = "";
  $<HTMLDialogElement>("delete-dialog").showModal();
}

function askDelete(path: string, kind: "document" | "folder" | "template") {
  deletePath = path;
  deleteKind = kind;
  $("delete-what").textContent =
    kind === "template"
      ? `Delete the template "${path}"? This also deletes it on your other devices and cannot be undone.`
      : kind === "folder"
      ? `Delete the folder "${baseOf(path)}" and everything in it? This also deletes it on your other devices and cannot be undone.`
      : `Delete "${baseOf(path)}"? This also deletes it on your other devices and cannot be undone.`;
  $("delete-error").textContent = "";
  $<HTMLDialogElement>("delete-dialog").showModal();
}

$("delete-form").addEventListener("submit", async (e) => {
  const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value !== "ok") return;
  if (deleteKind === "photo") {
    try {
      await api.deletePhoto(deletePhotoTarget!);
    } catch (err) {
      e.preventDefault();
      $("delete-error").textContent = String(err);
      return;
    }
    void inbox.refresh();
    return;
  }
  try {
    await flushSave();
    if (deleteKind === "template") await invoke("delete_template", { user, name: deletePath });
    else await invoke("delete_item", { user, path: deletePath });
  } catch (err) {
    e.preventDefault();
    $("delete-error").textContent = String(err);
    return;
  }
  if (deleteKind === "template") {
    if (templateName === deletePath) await openAnyDocument();
    void renderTemplates();
  } else {
    if (templateName === null && remap(docPath, deletePath, "\0") !== docPath) await openAnyDocument();
    void renderPicker();
  }
  syncSoon();
});

/** The user's default template if it still exists (e.g. not the removed "Homework" built-in), else Blank. */
async function defaultTemplateName(): Promise<string> {
  const templates = await invoke<TemplateInfo[]>("list_templates", { user });
  return templates.some((t) => t.path === settings.defaultTemplate) ? settings.defaultTemplate : "Blank";
}

/** Opens some document, creating one if the account has none (e.g. after deleting the open one). */
async function openAnyDocument() {
  let docs = await invoke<DocInfo[]>("list_documents", { user });
  if (!docs.length) {
    await invoke("create_document", { user, path: "Untitled", template: await defaultTemplateName() });
    docs = await invoke<DocInfo[]>("list_documents", { user });
  }
  await openDocument(docs[0].path);
}

// -- new folder --
$("new-folder").addEventListener("click", () => {
  $("folder-error").textContent = "";
  dialogOpen($<HTMLDialogElement>("folder-dialog"), $<HTMLInputElement>("folder-name"));
});

$("folder-form").addEventListener("submit", async (e) => {
  const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value !== "ok") return;
  const name = $<HTMLInputElement>("folder-name").value.trim();
  const path = pickerFolder ? `${pickerFolder}/${name}` : name;
  try {
    await invoke("create_folder", { user, path });
  } catch (err) {
    e.preventDefault();
    $("folder-error").textContent = String(err);
    return;
  }
  syncSoon();
  void renderPicker();
});

// -- new document (created in the folder the picker is showing) --
$("new-document").addEventListener("click", async () => {
  const templates = await invoke<TemplateInfo[]>("list_templates", { user });
  const tplSelect = $<HTMLSelectElement>("new-template");
  tplSelect.replaceChildren(...templates.map((t) => new Option(t.path, t.path)));
  if (templates.some((t) => t.path === settings.defaultTemplate)) tplSelect.value = settings.defaultTemplate;
  $("new-in").textContent = pickerFolder ? `in ${pickerFolder}/` : "at the top level";
  $("new-error").textContent = "";
  dialogOpen($<HTMLDialogElement>("new-dialog"), $<HTMLInputElement>("new-name"));
});

$("new-form").addEventListener("submit", async (e) => {
  const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value !== "ok") return;
  const name = $<HTMLInputElement>("new-name").value.trim();
  const path = pickerFolder ? `${pickerFolder}/${name}` : name;
  try {
    await invoke("create_document", { user, path, template: $<HTMLSelectElement>("new-template").value });
  } catch (err) {
    e.preventDefault(); // keep the dialog open
    $("new-error").textContent = String(err);
    return;
  }
  $<HTMLDialogElement>("picker").close();
  await openDocument(path);
});

// -- save a document as a template (from its ⋮ menu) --
let tplOverwrite = false;
let tplFrom = "";
function askSaveTemplate(path: string) {
  tplOverwrite = false;
  tplFrom = path;
  $("tpl-title").textContent = path ? "Save as template" : "New template";
  $("tpl-error").textContent = "";
  $("tpl-ok").textContent = path ? "Save" : "Create";
  const input = $<HTMLInputElement>("tpl-name");
  dialogOpen($<HTMLDialogElement>("tpl-dialog"), input);
  if (path) {
    input.value = baseOf(path);
    input.select();
  }
}

// An empty `tplFrom` means a brand-new template, started from the Blank skeleton.
$("new-tpl").addEventListener("click", () => askSaveTemplate(""));

$("tpl-form").addEventListener("submit", async (e) => {
  const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value !== "ok") return;
  const name = $<HTMLInputElement>("tpl-name").value.trim();
  try {
    await flushSave(); // so the template reflects what's on screen if this is the open document
    await invoke("save_template", {
      user,
      name,
      source: tplFrom
        ? await invoke<string>("load_source", { user, path: tplFrom })
        : await invoke<string>("read_template", { user, name: "Blank" }),
      overwrite: tplOverwrite,
    });
  } catch (err) {
    e.preventDefault();
    if (String(err) === "exists") {
      tplOverwrite = true;
      $("tpl-error").textContent = "A template with that name exists. Save again to replace it.";
      $("tpl-ok").textContent = "Replace";
    } else {
      $("tpl-error").textContent = String(err);
    }
    return;
  }
  syncSoon();
  if (!tplFrom) {
    // A new template opens straight away so it can be written.
    $<HTMLDialogElement>("picker").close();
    await openTemplate(name);
  } else if ($<HTMLDialogElement>("picker").open && pickerTab === "templates") void renderTemplates();
});

// -- template manager (from the main menu): open to edit, or delete --
const DOC_ICON =
  '<svg class="placeholder" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.8h5l3.2 3.2v8.2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1zM9 1.8V5h3.2" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>';

let templateUrls: string[] = [];
let thumbRun = 0; // bumped on every render, so an older background run stops when the grid is rebuilt or closed

/** Shows the saved thumbnail in `thumb`. Returns false if there isn't one. */
async function showTemplateThumb(name: string, thumb: HTMLElement): Promise<boolean> {
  try {
    const buf = await invoke<ArrayBuffer>("read_template_preview", { user, name });
    const url = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
    templateUrls.push(url);
    const img = document.createElement("img");
    img.src = url;
    thumb.replaceChildren(img);
    return true;
  } catch {
    return false;
  }
}

/** Builds thumbnails for templates that have none, one at a time, in the background while the dialog is open. */
async function buildMissingThumbs(missing: { name: string; thumb: HTMLElement }[], run: number) {
  for (const m of missing) {
    if (run !== thumbRun || !$<HTMLDialogElement>("picker").open || pickerTab !== "templates") return;
    m.thumb.classList.add("loading");
    try {
      const pdf = new Uint8Array(await invoke<ArrayBuffer>("compile_template_preview", { user, name: m.name }));
      const png = await thumbPng(await firstPageCanvas(pdf));
      if (png) {
        await invoke("save_template_preview", png, { headers: { "x-user": user, "x-name": encodeURIComponent(m.name) } });
        await showTemplateThumb(m.name, m.thumb);
      }
    } catch (e) {
      console.warn("template thumbnail failed", m.name, e);
      m.thumb.title = "A preview could not be rendered for this template";
    } finally {
      m.thumb.classList.remove("loading");
    }
  }
}

async function renderTemplates() {
  templateUrls.forEach((u) => URL.revokeObjectURL(u));
  templateUrls = [];
  const run = ++thumbRun;
  // The built-in Blank is only the fallback for new documents; it is not offered for editing here.
  const templates = (await invoke<TemplateInfo[]>("list_templates", { user })).filter((t) => !t.builtin);
  const missing: { name: string; thumb: HTMLElement }[] = [];
  const cards = templates.map((t) => {
    const card = document.createElement("div");
    card.className = "card doc" + (templateName === t.path ? " current" : "");
    card.tabIndex = 0;
    const open = async () => {
      $<HTMLDialogElement>("picker").close();
      await openTemplate(t.path);
    };
    card.onclick = open;
    card.onkeydown = (e) => { if (e.key === "Enter") void open(); };
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    thumb.innerHTML = DOC_ICON; // until the real thumbnail is there
    if (t.has_preview) void showTemplateThumb(t.path, thumb).then((ok) => { if (!ok) missing.push({ name: t.path, thumb }); });
    else missing.push({ name: t.path, thumb });
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = t.path;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = t.builtin ? "Built-in" : t.dirty ? "Waiting to upload" : "";
    card.append(
      thumb, title, meta,
      kebab($("picker"), [
        { label: "Duplicate", run: () => void duplicate("template", t.path) },
        { label: "Rename…", disabled: t.builtin, run: () => askRename(t.path, true) },
        { label: "Delete", danger: true, disabled: t.builtin, run: () => askDelete(t.path, "template") },
      ]),
    );
    return card;
  });
  $("tpl-grid").replaceChildren(...cards);
  if (!cards.length) $("tpl-grid").textContent = "No templates yet. Use New template… or save a document as a template.";
  // Starts once the dialog is open (the loop checks), after any saved thumbnails had a moment to load.
  setTimeout(() => void buildMissingThumbs(missing, run), 300);
}


// ---- sync ----
let syncTimer: number | undefined;

const syncUi = initSyncUi({
  user: () => user,
  syncNow: () => {
    clearTimeout(syncTimer);
    void doSync();
  },
  onPending: (p) => markOpenItem(p),
});

/** Dot next to the open document's name while it has edits the server has not seen. */
function markOpenItem(p: Pending) {
  const dirty = snippetsOpen ? p.snippetsDirty : templateName !== null ? p.dirtyTemplates.has(templateName) : p.dirtyDocs.has(docPath);
  $("doc-dirty").hidden = !dirty;
}

function syncSoon() {
  clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => void doSync(), 2000);
  void syncUi.refreshPending(); // the chip should show "1 change waiting" right away, not after the next sync
}

let syncRun: Promise<void> | null = null;

/** One pass at a time; a caller that arrives mid-pass shares it. */
function doSync(): Promise<void> {
  if (!user) return Promise.resolve();
  if (!syncRun) syncRun = runPass().finally(() => (syncRun = null));
  return syncRun;
}

async function runPass() {
  syncUi.syncing();
  try {
    await flushSave();
    if (!navigator.onLine) return syncUi.failed("No network connection");
    const res = await runSync(api, user, docPath || null);
    if (res === null) return syncUi.skipped();
    // Renamed or moved on another device: keep the editor pointed at the same thing.
    for (const r of res.renamed) {
      if (r.kind === "template") {
        if (templateName === r.from) {
          templateName = r.to;
          setDocLabel("Template / ", r.to);
        }
      } else if (templateName === null && !snippetsOpen) followMove(r.from, r.to);
    }
    // Reload the open document if the server copy replaced it. flushSave() above means no edits were lost.
    if (res.configPulled) {
      const t = await invoke<string | null>("load_config", { user, name: SNIPPETS_CONFIG });
      if (t !== null) {
        applySnippetsText(t);
        if (snippetsOpen) setDoc(t);
      }
    }
    if (templateName === null && !snippetsOpen && res.pulled.includes(docPath)) setDoc(await invoke<string>("load_source", { user, path: docPath }));
    // The open document was deleted on another device (and had no local edits to keep it alive).
    if (templateName === null && !snippetsOpen && docPath && res.removed.some((p) => remap(docPath, p, "\0") !== docPath)) await openAnyDocument();
    if ($<HTMLDialogElement>("picker").open) void refreshPicker();
    if (res.errors.length) console.warn("sync errors", res.errors);
    if (res.conflicts.length) status(`Conflict: server version kept as "${res.conflicts.join('", "')}"`);
    syncUi.done({ errors: res.errors, conflicts: res.conflicts });
  } catch (e) {
    console.warn("sync failed", e);
    syncUi.failed(String((e as Error)?.message ?? e));
  }
}

// Closing the window: only flush the pending editor save; it never waits for a sync. Local-first, so
// unsynced changes stay safe on disk and go up the next time the app runs.
let closing = false;
void getCurrentWindow().onCloseRequested(async (event) => {
  if (!user || closing) return;
  closing = true;
  event.preventDefault();
  try {
    await flushSave();
  } catch (e) {
    console.warn("save on exit failed", e);
  }
  await getCurrentWindow().destroy();
});

window.addEventListener("online", () => { void doSync(); if (user) void inbox.refresh(); });
// Coming back to the window (e.g. after a long break) catches photos whose realtime events were missed.
window.addEventListener("focus", () => { if (user) void inbox.refresh(); });
setInterval(() => void doSync(), 60_000);

// ---- photo inbox ----
// ---- auth gate ----
// Nothing in #app is usable without a signed-in user: documents and templates belong to the account.
async function start(userId: string) {
  user = userId;
  $("auth").hidden = true;
  $("app").hidden = false;

  syncUi.start();
  await startLatexSetup(); // first run: downloads LaTeX support files, dialog shows progress
  // Pull first on a fresh device so we don't invent a document that the server already has.
  await doSync();
  await initSnippets();

  const docs = await invoke<DocInfo[]>("list_documents", { user });
  let last: string | null = null;
  try { last = localStorage.getItem(lastKey()); } catch {}
  const remembered = docs.find((d) => d.path === last)?.path;
  if (remembered) await openDocument(remembered);
  else await openAnyDocument();

  api.onInboxChange(() => void inbox.refresh());
}

async function initAuth() {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  const msg = $("auth-msg");
  if (!url || !key) {
    msg.textContent = "Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in apps/desktop/.env";
    $("login").querySelectorAll("input,button").forEach((el) => ((el as HTMLInputElement).disabled = true));
    return;
  }
  api = createApi(url, key);

  api.sb.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") location.reload();
  });

  $("sign-out").addEventListener("click", async () => {
    await flushSave();
    await api.sb.auth.signOut();
  });

  $("login").addEventListener("submit", async (e) => {
    e.preventDefault();
    msg.textContent = "Signing in…";
    const { data, error } = await api.sb.auth.signInWithPassword({
      email: $<HTMLInputElement>("email").value,
      password: $<HTMLInputElement>("password").value,
    });
    if (error || !data.user) msg.textContent = error?.message ?? "Sign-in failed";
    else await start(data.user.id);
  });

  // The session is persisted, so a returning user is signed in even when offline.
  const { data } = await api.sb.auth.getSession();
  if (data.session) await start(data.session.user.id);
}

void initAuth();
