import { invoke } from "@tauri-apps/api/core";
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

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Api = ReturnType<typeof createApi>;
type DocInfo = { path: string; dirty: boolean; snippet: string; has_preview: boolean };
type TemplateInfo = { path: string; builtin: boolean };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (s: string) => ($("status").textContent = s);

// ---- session state (set once signed in) ----
let api: Api;
let user = "";
let docPath = ""; // path of the open document, e.g. "Physics/Week 3/HW 1"

// ---- editor ----
let view: EditorView | undefined;
const vimSlot = new Compartment();
let loadingDoc = false; // true while replacing the whole document, so it isn't saved as a user edit

function vimPref(): boolean {
  try { return localStorage.getItem("vim") !== "off"; } catch { return true; }
}

const source = () => view!.state.doc.toString();

// The document a pending edit belongs to; captured at edit time so switching documents can't misfile a save.
let pendingDoc: string | null = null;
let saveTimer: number | undefined;

async function flushSave() {
  clearTimeout(saveTimer);
  if (pendingDoc === null) return;
  const p = pendingDoc;
  pendingDoc = null;
  await invoke("save_source", { user, path: p, source: source() });
  syncSoon();
}

function createEditor(doc: string) {
  view = new EditorView({
    doc,
    parent: $("editor"),
    extensions: [
      // Listed before vim() so Ctrl+Enter still wins over its key handling.
      Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => (void compile(), true) }])),
      vimSlot.of(vimPref() ? vim() : []),
      basicSetup,
      StreamLanguage.define(stex),
      EditorView.lineWrapping,
      softTheme,
      syntaxHighlighting(softHighlight),
      keymap.of([indentWithTab]),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged || loadingDoc) return;
        pendingDoc = docPath;
        clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => void flushSave(), 800);
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

const vimToggle = $<HTMLInputElement>("vim-toggle");
vimToggle.checked = vimPref();
vimToggle.addEventListener("change", () => {
  try { localStorage.setItem("vim", vimToggle.checked ? "on" : "off"); } catch {}
  view?.dispatch({ effects: vimSlot.reconfigure(vimToggle.checked ? vim() : []) });
  view?.focus();
});

// :w saves and compiles
Vim.defineEx("write", "w", () => void compile());

function insertAtCursor(text: string) {
  const { from, to } = view!.state.selection.main;
  view!.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  view!.focus();
}

// ---- compile + preview ----
let compiling = false;

async function compile() {
  if (compiling || !view) return;
  compiling = true;
  status("Compiling…");
  const log = $("log");
  try {
    const bytes = new Uint8Array(await invoke<ArrayBuffer>("compile", { user, path: docPath, source: source() }));
    log.hidden = true;
    const thumb = await renderPdf(bytes);
    if (thumb) void savePreview(docPath, thumb);
    status("Compiled");
  } catch (e) {
    log.hidden = false;
    log.textContent = String(e);
    status("Compile failed");
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
  }).catch(() => {});
}

$("compile").addEventListener("click", compile);

// ---- documents, folders, templates ----
const lastKey = () => `hwscan:last:${user}`;
const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0));
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

async function openDocument(path: string) {
  await flushSave();
  docPath = path;
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

function dialogOpen(dlg: HTMLDialogElement, input: HTMLInputElement) {
  input.value = "";
  dlg.showModal();
  input.focus();
}

// -- document picker --
let pickerFolder = ""; // "" is the top level
let previewUrls: string[] = [];

async function renderPicker() {
  previewUrls.forEach((u) => URL.revokeObjectURL(u));
  previewUrls = [];
  const [docs, folders] = await Promise.all([
    invoke<DocInfo[]>("list_documents", { user }),
    invoke<string[]>("list_folders", { user }),
  ]);

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
  for (const f of folders.filter((f) => parentOf(f) === pickerFolder)) {
    const count = docs.filter((d) => d.path.startsWith(f + "/")).length;
    const card = document.createElement("button");
    card.className = "card folder";
    card.innerHTML = `<div class="thumb">📁</div><div class="title"></div><div class="meta">${count} document${count === 1 ? "" : "s"}</div>`;
    card.querySelector(".title")!.textContent = baseOf(f);
    card.onclick = () => { pickerFolder = f; void renderPicker(); };
    cards.push(card);
  }
  for (const d of docs.filter((d) => parentOf(d.path) === pickerFolder)) {
    const card = document.createElement("button");
    card.className = "card doc" + (d.path === docPath ? " current" : "");
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
    }
    if (!d.has_preview) {
      // Never compiled on this device: show the start of the source instead.
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
    card.onclick = async () => {
      $<HTMLDialogElement>("picker").close();
      await openDocument(d.path);
    };
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
  $<HTMLSelectElement>("new-template").replaceChildren(...templates.map((t) => new Option(t.path, t.path)));
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

// -- save current document as a template --
let tplOverwrite = false;
$("save-template").addEventListener("click", () => {
  tplOverwrite = false;
  $("tpl-error").textContent = "";
  $("tpl-ok").textContent = "Save";
  dialogOpen($<HTMLDialogElement>("tpl-dialog"), $<HTMLInputElement>("tpl-name"));
});

$("tpl-form").addEventListener("submit", async (e) => {
  const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value !== "ok") return;
  try {
    await invoke("save_template", {
      user, name: $<HTMLInputElement>("tpl-name").value.trim(), source: source(), overwrite: tplOverwrite,
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
    if (res.pulled.includes(docPath)) setDoc(await invoke<string>("load_source", { user, path: docPath }));
    if ($<HTMLDialogElement>("picker").open) void renderPicker();
    setSync("Synced");
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

  const saveImage = async () => {
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
      status("Running OCR…");
      const latex = await api.ocr(p.id);
      // Inserted as visible text for review; user edits before compiling.
      insertAtCursor(`% --- OCR from photo ${p.id}: review before use ---\n${latex}\n`);
      await api.markImported(p.id);
      await refreshInbox();
      status("OCR inserted");
    }),
  );
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

  let docs = await invoke<DocInfo[]>("list_documents", { user });
  if (!docs.length) {
    await invoke("create_document", { user, path: "Untitled", template: "Homework" });
    docs = await invoke<DocInfo[]>("list_documents", { user });
  }
  let last: string | null = null;
  try { last = localStorage.getItem(lastKey()); } catch {}
  await openDocument(docs.find((d) => d.path === last)?.path ?? docs[0].path);

  api.onNewPhoto(() => void refreshInbox());
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
