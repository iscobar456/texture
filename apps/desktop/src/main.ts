import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { EditorView, basicSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { Compartment, Prec } from "@codemirror/state";
import { StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { vim, Vim } from "@replit/codemirror-vim";
import { softTheme, softHighlight } from "./theme";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { indentWithTab } from "@codemirror/commands";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { createApi, type Photo } from "@hwscan/api";
import { runSync } from "./sync";
import { EditorState } from "@codemirror/state";
import { latexSource, loadSnippets, snippetKeymap, userSnippets } from "./completions";
import { initSnippetsUi } from "./snippets-ui";
import { DEFAULTS, EDITOR_THEMES, OCR_MODELS, loadSettings, saveSettings, applyAppearance, type Settings } from "./settings";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Api = ReturnType<typeof createApi>;
type DocInfo = { path: string; dirty: boolean; snippet: string; has_preview: boolean };
type TemplateInfo = { path: string; builtin: boolean };
type FolderInfo = { path: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (s: string) => ($("status").textContent = s);

// ---- session state (set once signed in) ----
let api: Api;
let user = "";
let docPath = ""; // path of the open document, e.g. "Physics/Week 3/HW 1"
/** Set while a template (not a document) is loaded in the editor; docPath keeps the last open document. */
let templateName: string | null = null;

// ---- editor ----
let view: EditorView | undefined;
const vimSlot = new Compartment();
const wrapSlot = new Compartment();
const snippetSlot = new Compartment();
loadSnippets();

let settings: Settings = loadSettings();
applyAppearance(settings); // before sign-in, so the login screen is themed too
let loadingDoc = false; // true while replacing the whole document, so it isn't saved as a user edit


const source = () => view!.state.doc.toString();

// What a pending edit belongs to; captured at edit time so switching documents can't misfile a save.
let pendingDoc: { template: boolean; path: string } | null = null;
let saveTimer: number | undefined;
let autoTimer: number | undefined;

async function flushSave() {
  clearTimeout(saveTimer);
  if (pendingDoc === null) return;
  const p = pendingDoc;
  pendingDoc = null;
  if (p.template) await invoke("save_template", { user, name: p.path, source: source(), overwrite: true });
  else await invoke("save_source", { user, path: p, source: source() });
  syncSoon();
}

function createEditor(doc: string) {
  view = new EditorView({
    doc,
    parent: $("editor"),
    extensions: [
      // Listed before vim() so Ctrl+Enter still wins over its key handling.
      Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => (void compile(), true) }])),
      snippetSlot.of(snippetKeymap(userSnippets())), // before vim(), at the same precedence, so it wins
      vimSlot.of(settings.editing === "vim" ? vim() : []),
      basicSetup,
      StreamLanguage.define(stex),
      wrapSlot.of(settings.wrap ? EditorView.lineWrapping : []),
      EditorState.languageData.of(() => [{ autocomplete: latexSource }]),
      softTheme,
      syntaxHighlighting(softHighlight),
      keymap.of([indentWithTab]),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged || loadingDoc) return;
        pendingDoc = templateName !== null ? { template: true, path: templateName } : { template: false, path: docPath };
        clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => void flushSave(), 800);
        if (settings.autoCompile) {
          clearTimeout(autoTimer);
          autoTimer = window.setTimeout(() => void compile(true), 1500);
        }
      }),
    ],
  });
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

// :w saves and compiles
Vim.defineEx("write", "w", () => void compile());

function insertAtCursor(text: string) {
  const { from, to } = view!.state.selection.main;
  view!.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  view!.focus();
}

// ---- compile + preview ----
let compiling = false;

/** `quiet` is for automatic compiles: a failure mid-typing shouldn't throw the error log at you. */
async function compile(quiet = false) {
  if (compiling || !view) return;
  compiling = true;
  status("Compiling…");
  const log = $("log");
  try {
    const bytes = new Uint8Array(await invoke<ArrayBuffer>("compile", { user, path: templateName ?? docPath, source: source(), scratch: templateName !== null }));
    log.hidden = true;
    const thumb = await renderPdf(bytes);
    if (thumb && templateName === null) void savePreview(docPath, thumb);
    status("Compiled");
  } catch (e) {
    if (quiet) {
      status("Compile errors (press Ctrl+Enter to see them)");
    } else {
      log.hidden = false;
      log.textContent = String(e);
      status("Compile failed");
    }
  } finally {
    compiling = false;
  }
}

async function renderPdf(data: Uint8Array): Promise<HTMLCanvasElement | undefined> {
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
  return canvases[0];
}

/** Stores a small PNG of page 1 for the document picker. Best effort. */
async function savePreview(path: string, page: HTMLCanvasElement) {
  const thumb = document.createElement("canvas");
  thumb.width = 360;
  thumb.height = Math.round((page.height / page.width) * 360);
  thumb.getContext("2d")!.drawImage(page, 0, 0, thumb.width, thumb.height);
  const blob = await new Promise<Blob | null>((r) => thumb.toBlob(r, "image/png"));
  if (!blob) return;
  await invoke("save_preview", new Uint8Array(await blob.arrayBuffer()), {
    headers: { "x-user": user, "x-path": encodeURIComponent(path) },
  }).then(syncSoon, () => {});
}

$("compile").addEventListener("click", () => void compile());

// Documents live in the app's private data folder; this is how a PDF gets out.
$("export-pdf").addEventListener("click", async () => {
  if (!view) return;
  const target = templateName ?? docPath;
  let dest = await save({
    defaultPath: `${baseOf(target)}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!dest) return;
  if (!dest.toLowerCase().endsWith(".pdf")) dest += ".pdf";
  status("Exporting…");
  try {
    await flushSave();
    await invoke("export_pdf", { user, path: target, source: source(), scratch: templateName !== null, dest });
    status(`Exported to ${dest}`);
  } catch (e) {
    $("log").hidden = false;
    $("log").textContent = String(e);
    status("Export failed");
  }
});

// ---- snippets ----
initSnippetsUi(() => view?.dispatch({ effects: snippetSlot.reconfigure(snippetKeymap(userSnippets())) }));

// ---- settings ----
const field = {
  theme: $<HTMLSelectElement>("set-theme"),
  editorTheme: $<HTMLSelectElement>("set-editor-theme"),
  editing: $<HTMLSelectElement>("set-editing"),
  font: $<HTMLInputElement>("set-font"),
  wrap: $<HTMLInputElement>("set-wrap"),
  linenos: $<HTMLInputElement>("set-linenos"),
  auto: $<HTMLInputElement>("set-auto"),
  template: $<HTMLSelectElement>("set-template"),
  ocrModel: $<HTMLSelectElement>("set-ocr-model"),
};

function showSettings() {
  field.theme.value = settings.theme;
  field.ocrModel.value = settings.ocrModel;
  field.editorTheme.value = settings.editorTheme;
  field.editing.value = settings.editing;
  field.font.value = String(settings.fontSize);
  field.wrap.checked = settings.wrap;
  field.linenos.checked = settings.lineNumbers;
  field.auto.checked = settings.autoCompile;
}

// -- OCR API key (stored by the Rust side; the key itself never comes back to the page) --
const ocrKey = $<HTMLInputElement>("set-ocr-key");
const ocrStatus = $("set-ocr-status");

async function refreshKeyStatus() {
  const has = await invoke<boolean>("has_api_key", { user });
  ocrStatus.textContent = has ? "A key is saved on this device." : "No key saved.";
  ocrKey.placeholder = has ? "(saved - paste a new key to replace it)" : "sk-ant-…";
}

async function keyAction(label: string, fn: () => Promise<void>) {
  ocrStatus.textContent = `${label}…`;
  try {
    await fn();
  } catch (e) {
    ocrStatus.textContent = String(e);
  }
}

$("set-ocr-save").addEventListener("click", () =>
  keyAction("Saving", async () => {
    if (!ocrKey.value.trim()) throw new Error("Paste a key first.");
    await invoke("set_api_key", { user, key: ocrKey.value });
    ocrKey.value = "";
    await refreshKeyStatus();
  }),
);
$("set-ocr-test").addEventListener("click", () =>
  keyAction("Testing", async () => {
    await invoke("test_api_key", { user });
    ocrStatus.textContent = "Key works.";
  }),
);
$("set-ocr-remove").addEventListener("click", () =>
  keyAction("Removing", async () => {
    await invoke("set_api_key", { user, key: "" });
    await refreshKeyStatus();
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
    autoCompile: field.auto.checked,
    defaultTemplate: field.template.value || settings.defaultTemplate,
    ocrModel: field.ocrModel.value as Settings["ocrModel"],
  };
  saveSettings(settings);
  applySettings();
}

field.ocrModel.replaceChildren(...OCR_MODELS.map(([value, label]) => new Option(label, value)));
field.editorTheme.replaceChildren(...EDITOR_THEMES.map(([value, label]) => new Option(label, value)));
Object.values(field).forEach((el) => el.addEventListener("change", readSettings));

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
  void refreshKeyStatus();
  $<HTMLDialogElement>("settings-dialog").showModal();
});

// ---- menu ----
const menuList = $("menu-list");
const setMenu = (open: boolean) => {
  menuList.hidden = !open;
  $("menu-button").setAttribute("aria-expanded", String(open));
};
$("menu-button").addEventListener("click", (e) => { e.stopPropagation(); setMenu(menuList.hasAttribute("hidden")); });
// Any item (or a click elsewhere, or Escape) closes the menu.
menuList.addEventListener("click", () => setMenu(false));
document.addEventListener("click", () => setMenu(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") setMenu(false); });
document.querySelectorAll<HTMLButtonElement>("#menu-list .stub").forEach((b) =>
  b.addEventListener("click", () => status(`${b.dataset.stub}: not implemented yet`)),
);

// ---- documents, folders, templates ----
const lastKey = () => `hwscan:last:${user}`;
const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0));
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

async function openDocument(path: string) {
  await flushSave();
  docPath = path;
  templateName = null;
  try { localStorage.setItem(lastKey(), path); } catch {}
  const text = await invoke<string>("load_source", { user, path });
  if (view) setDoc(text);
  else createEditor(text);
  $("pages").replaceChildren();
  $("log").hidden = true;
  $("doc-name").textContent = path;
  void refreshInbox();
  syncSoon();
}

async function openTemplate(name: string) {
  await flushSave();
  templateName = name;
  const text = await invoke<string>("read_template", { user, name });
  if (view) setDoc(text);
  else createEditor(text);
  $("pages").replaceChildren();
  $("log").hidden = true;
  $("doc-name").textContent = `Template: ${name}`;
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
type MenuItem = { label: string; run: () => void; danger?: boolean; disabled?: boolean };

/** A vertical-dots button that opens a small menu. The menu lives in `host` (a dialog) so it shows above it. */
function kebab(host: HTMLElement, items: MenuItem[]) {
  const btn = document.createElement("button");
  btn.className = "kebab";
  btn.textContent = "⋮";
  btn.title = "Actions";
  btn.setAttribute("aria-haspopup", "menu");
  btn.onclick = (e) => {
    e.stopPropagation();
    const existing = host.querySelector(".popup");
    existing?.remove();
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
    const r = btn.getBoundingClientRect();
    pop.style.top = `${r.bottom + 2}px`;
    pop.style.left = `${Math.max(8, r.right - 170)}px`;
    host.append(pop);
  };
  return btn;
}
// Clicking anywhere else closes an open ⋮ menu.
document.addEventListener("click", () => document.querySelectorAll(".popup").forEach((p) => p.remove()));

// -- document picker --
let pickerFolder = ""; // "" is the top level
let previewUrls: string[] = [];

async function renderPicker() {
  previewUrls.forEach((u) => URL.revokeObjectURL(u));
  previewUrls = [];
  const [docs, folderInfos] = await Promise.all([
    invoke<DocInfo[]>("list_documents", { user }),
    invoke<FolderInfo[]>("list_folders", { user }),
  ]);
  const folders = folderInfos.map((f) => f.path);

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
    crumb("Documents", ""),
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
    thumb.textContent = "📁";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = baseOf(f);
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${count} document${count === 1 ? "" : "s"}`;
    card.append(thumb, title, meta);
    cards.push(card);
  }
  for (const d of docs.filter((d) => parentOf(d.path) === pickerFolder)) {
    const card = makeCard("doc" + (d.path === docPath ? " current" : ""), d.path, "document", async () => {
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
    meta.textContent = d.dirty ? "Not synced yet" : "";
    card.append(thumb, title, meta);
    cards.push(card);
  }
  $("doc-grid").replaceChildren(...cards);
  if (!cards.length) $("doc-grid").textContent = "Nothing here yet.";
}

$("doc-button").addEventListener("click", async () => {
  await flushSave(); // so snippets and dirty flags are current
  pickerFolder = parentOf(docPath);
  await renderPicker();
  $<HTMLDialogElement>("picker").showModal();
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
  $("doc-name").textContent = next;
  try { localStorage.setItem(lastKey(), next); } catch {}
}

async function doMove(from: string, to: string) {
  await flushSave(); // pending edits belong to the old path
  await invoke("move_item", { user, from, to });
  followMove(from, to);
  syncSoon();
}

let renameFrom = "";
function askRename(path: string) {
  renameFrom = path;
  $("rename-error").textContent = "";
  dialogOpen($<HTMLDialogElement>("rename-dialog"), $<HTMLInputElement>("rename-name"));
  $<HTMLInputElement>("rename-name").value = baseOf(path);
  $<HTMLInputElement>("rename-name").select();
}

$("rename-form").addEventListener("submit", async (e) => {
  const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value !== "ok") return;
  const parent = parentOf(renameFrom);
  const name = $<HTMLInputElement>("rename-name").value.trim();
  const to = parent ? `${parent}/${name}` : name;
  if (to === renameFrom) return;
  try {
    await doMove(renameFrom, to);
  } catch (err) {
    e.preventDefault();
    $("rename-error").textContent = String(err);
    return;
  }
  void renderPicker();
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
  $("delete-what").textContent = "Delete this photo from your inbox? This cannot be undone. A copy in your phone's gallery is not affected.";
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
    void refreshInbox();
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

/** Opens some document, creating one if the account has none (e.g. after deleting the open one). */
async function openAnyDocument() {
  let docs = await invoke<DocInfo[]>("list_documents", { user });
  if (!docs.length) {
    await invoke("create_document", { user, path: "Untitled", template: "Homework" });
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
  $("tpl-error").textContent = "";
  $("tpl-ok").textContent = "Save";
  const input = $<HTMLInputElement>("tpl-name");
  dialogOpen($<HTMLDialogElement>("tpl-dialog"), input);
  input.value = baseOf(path);
  input.select();
}

$("tpl-form").addEventListener("submit", async (e) => {
  const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value !== "ok") return;
  try {
    await flushSave(); // so the template reflects what's on screen if this is the open document
    await invoke("save_template", {
      user,
      name: $<HTMLInputElement>("tpl-name").value.trim(),
      source: await invoke<string>("load_source", { user, path: tplFrom }),
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
});

// -- template manager (from the main menu): open to edit, or delete --
async function renderTemplates() {
  const templates = await invoke<(TemplateInfo & { snippet: string; dirty: boolean })[]>("list_templates", { user });
  const cards = templates.map((t) => {
    const card = document.createElement("div");
    card.className = "card doc" + (templateName === t.path ? " current" : "");
    card.tabIndex = 0;
    const open = async () => {
      $<HTMLDialogElement>("tpl-manager").close();
      await openTemplate(t.path);
    };
    card.onclick = open;
    card.onkeydown = (e) => { if (e.key === "Enter") void open(); };
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const pre = document.createElement("pre");
    pre.textContent = t.snippet || "(empty)";
    thumb.append(pre);
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = t.path;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = t.builtin ? "Built-in" : t.dirty ? "Not synced yet" : "";
    card.append(
      thumb, title, meta,
      kebab($("tpl-manager"), [
        { label: "Delete", danger: true, disabled: t.builtin, run: () => askDelete(t.path, "template") },
      ]),
    );
    return card;
  });
  $("tpl-grid").replaceChildren(...cards);
}

$("manage-templates").addEventListener("click", async () => {
  await flushSave();
  await renderTemplates();
  $<HTMLDialogElement>("tpl-manager").showModal();
});
$("tpl-manager-close").addEventListener("click", () => $<HTMLDialogElement>("tpl-manager").close());

// ---- sync ----
let syncTimer: number | undefined;
const setSync = (s: string) => ($("sync").textContent = s);

function syncSoon() {
  clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => void doSync(), 2000);
}

async function doSync() {
  if (!user) return;
  setSync("Syncing…");
  try {
    await flushSave();
    const res = await runSync(api, user, docPath || null);
    if (res === null) return;
    // Reload the open document if the server copy replaced it. flushSave() above means no edits were lost.
    if (templateName === null && res.pulled.includes(docPath)) setDoc(await invoke<string>("load_source", { user, path: docPath }));
    // The open document was deleted on another device (and had no local edits to keep it alive).
    if (templateName === null && docPath && res.removed.some((p) => remap(docPath, p, "\0") !== docPath)) await openAnyDocument();
    if ($<HTMLDialogElement>("picker").open) void renderPicker();
    if (res.errors.length) {
      console.warn("sync errors", res.errors);
      setSync(`Synced with ${res.errors.length} error${res.errors.length === 1 ? "" : "s"}`);
      $("sync").title = res.errors.join("\n");
    } else {
      setSync("Synced");
      $("sync").title = "";
    }
    if (res.conflicts.length) status(`Conflict: server version kept as "${res.conflicts.join('", "')}"`);
  } catch (e) {
    console.warn("sync failed", e);
    setSync(navigator.onLine ? "Sync failed — will retry" : "Offline — changes saved locally");
  }
}

window.addEventListener("online", () => void doSync());
setInterval(() => void doSync(), 60_000);

// ---- photo inbox ----
async function refreshInbox() {
  const list = $("inbox-list");
  try {
    const photos = await api.listPending();
    list.replaceChildren(...(await Promise.all(photos.map((p) => photoCard(p)))));
    if (!photos.length) list.textContent = "No pending photos";
  } catch {
    list.textContent = "Photo inbox needs a connection";
  }
}

/** Downscales to at most 1568 px on the long side as a JPEG: keeps the request small and the token cost down. */
async function shrinkToJpeg(blob: Blob, maxSide = 1568): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(blob); // honours the photo's EXIF rotation
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const out = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.85));
  if (!out) throw new Error("Could not prepare the photo");
  return new Uint8Array(await out.arrayBuffer());
}

function ocrCost(inTok: number, outTok: number): string {
  const m = OCR_MODELS.find(([v]) => v === settings.ocrModel)!;
  const dollars = (inTok * m[2] + outTok * m[3]) / 1_000_000;
  return dollars < 0.01 ? `about ${(dollars * 100).toFixed(2)}¢` : `about $${dollars.toFixed(3)}`;
}

async function photoCard(p: Photo) {
  const blob = await api.downloadPhoto(p);
  const card = document.createElement("div");
  card.className = "photo";
  const img = document.createElement("img");
  img.src = URL.createObjectURL(blob);
  const row = document.createElement("div");
  row.className = "row";

  const mk = (label: string, fn: () => Promise<void>) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = async () => {
      b.disabled = true;
      try { await fn(); } catch (e) { status(String(e)); b.disabled = false; }
    };
    return b;
  };

  const needDoc = () => {
    if (templateName !== null) throw new Error("Open a document to insert photos");
  };
  const saveImage = async () => {
    needDoc();
    const ext = p.storage_path.split(".").pop() ?? "jpg";
    return invoke<string>("save_image", new Uint8Array(await blob.arrayBuffer()), {
      headers: { "x-user": user, "x-path": encodeURIComponent(docPath), "x-name": `${p.id}.${ext}` },
    });
  };

  row.append(
    mk("Insert image", async () => {
      const rel = await saveImage();
      insertAtCursor(`\\begin{center}\n\\includegraphics[width=0.8\\linewidth]{${rel}}\n\\end{center}\n`);
      await api.markImported(p.id);
      await refreshInbox();
    }),
    mk("OCR → LaTeX", async () => {
      needDoc();
      if (!(await invoke<boolean>("has_api_key", { user }))) {
        throw new Error("Add your Anthropic API key in Menu → Settings → Photo OCR first.");
      }
      status("Running OCR…");
      const jpeg = await shrinkToJpeg(blob);
      const r = await invoke<{ latex: string; input_tokens: number; output_tokens: number; stop_reason: string }>(
        "ocr_image", jpeg, { headers: { "x-user": user, "x-model": settings.ocrModel } },
      );
      // Inserted as visible text for review; user edits before compiling.
      const cut = r.stop_reason === "max_tokens" ? "% --- OCR output was cut off ---\n" : "";
      insertAtCursor(`% --- OCR from photo ${p.id}: review before use ---\n${r.latex}\n${cut}`);
      await api.markImported(p.id);
      await refreshInbox();
      status(`OCR inserted (${r.input_tokens} in / ${r.output_tokens} out, ${ocrCost(r.input_tokens, r.output_tokens)})`);
    }),
  );
  const del = document.createElement("button");
  del.textContent = "🗑";
  del.title = "Delete photo";
  del.onclick = () => askDeletePhoto(p);
  row.append(del);
  card.append(img, row);
  return card;
}

// ---- auth gate ----
// Nothing in #app is usable without a signed-in user: documents and templates belong to the account.
async function start(userId: string) {
  user = userId;
  $("auth").hidden = true;
  $("app").hidden = false;

  // Pull first on a fresh device so we don't invent a document that the server already has.
  await doSync();

  const docs = await invoke<DocInfo[]>("list_documents", { user });
  let last: string | null = null;
  try { last = localStorage.getItem(lastKey()); } catch {}
  const remembered = docs.find((d) => d.path === last)?.path;
  if (remembered) await openDocument(remembered);
  else await openAnyDocument();

  api.onInboxChange(() => void refreshInbox());
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
