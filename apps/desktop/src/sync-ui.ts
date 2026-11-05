import { invoke } from "@tauri-apps/api/core";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- what is waiting to be uploaded ----

export type PendingItem = { group: string; label: string };
export type Pending = {
  items: PendingItem[];
  /** Documents with edits the server has not seen. */
  dirtyDocs: Set<string>;
  dirtyTemplates: Set<string>;
  snippetsDirty: boolean;
};

type Doc = { path: string; dirty: boolean; remote_at: string | null; has_preview?: boolean; preview_dirty?: boolean };
type Tombstone = { kind: string; path: string };

/** Reads the local sync state (dirty flags, pending deletions). Local only; never touches the network. */
export async function collectPending(user: string): Promise<Pending> {
  const [docs, folders, templates, configs, deletions] = await Promise.all([
    invoke<Doc[]>("list_documents", { user }),
    invoke<Doc[]>("list_folders", { user }),
    invoke<(Doc & { builtin: boolean })[]>("list_templates", { user }),
    invoke<Doc[]>("list_configs", { user }),
    invoke<Tombstone[]>("list_deletions", { user }),
  ]);
  const p: Pending = { items: [], dirtyDocs: new Set(), dirtyTemplates: new Set(), snippetsDirty: false };
  for (const d of docs) {
    if (d.dirty) {
      p.dirtyDocs.add(d.path);
      p.items.push({ group: "Documents", label: d.remote_at ? d.path : `${d.path} (new)` });
    }
    if (d.preview_dirty && d.has_preview) p.items.push({ group: "Previews", label: d.path });
  }
  for (const f of folders) if (f.dirty || f.remote_at === null) p.items.push({ group: "Folders", label: f.path });
  for (const t of templates) {
    if (!t.builtin && t.dirty) {
      p.dirtyTemplates.add(t.path);
      p.items.push({ group: "Templates", label: t.path });
    }
  }
  for (const c of configs) {
    if (c.dirty) {
      p.snippetsDirty = true;
      p.items.push({ group: "Snippets file", label: "your snippets" });
    }
  }
  for (const t of deletions) p.items.push({ group: "Deletions", label: `${t.kind}: ${t.path}` });
  return p;
}

// ---- the chip and the panel ----

export type Phase = "idle" | "syncing" | "offline" | "failed";

function ago(d: Date): string {
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function initSyncUi(opts: {
  user: () => string;
  /** Starts a sync pass right now. */
  syncNow: () => void;
  /** Called whenever the pending list is recomputed (the header uses it to mark the open document). */
  onPending: (p: Pending) => void;
}) {
  const chip = $<HTMLButtonElement>("sync");
  const dialog = $<HTMLDialogElement>("sync-dialog");
  let phase: Phase = "idle";
  let pending: Pending = { items: [], dirtyDocs: new Set(), dirtyTemplates: new Set(), snippetsDirty: false };
  let errors: string[] = [];
  let conflicts: string[] = [];
  let lastOk: Date | null = null;
  let failure = "";

  const lastKey = () => `texture:lastsync:${opts.user()}`;

  function loadLast() {
    try {
      const v = localStorage.getItem(lastKey());
      if (v) lastOk = new Date(v);
    } catch {}
  }

  function render() {
    const n = pending.items.length;
    const waiting = `${n} change${n === 1 ? "" : "s"} waiting`;
    let text: string;
    let tone: "ok" | "busy" | "warn" | "bad" | "off";
    if (phase === "syncing") [text, tone] = ["Syncing…", "busy"];
    else if (phase === "offline") [text, tone] = [n ? `Offline · ${waiting}` : "Offline", "off"];
    else if (phase === "failed" || errors.length) [text, tone] = [n ? `Sync problem · ${waiting}` : "Sync problem", "bad"];
    else if (n) [text, tone] = [waiting, "warn"];
    else [text, tone] = [lastOk ? `Synced ${ago(lastOk)}` : "Not synced yet", "ok"];

    chip.className = `sync-chip ${tone}`;
    chip.replaceChildren();
    const dot = document.createElement("span");
    dot.className = tone === "busy" ? "spinner" : "dot";
    chip.append(dot, text);
    if (dialog.open) renderPanel();
  }

  function renderPanel() {
    const body = $("sync-body");
    const parts: HTMLElement[] = [];
    const add = (tag: string, text: string, cls = "") => {
      const el = document.createElement(tag);
      el.textContent = text;
      if (cls) el.className = cls;
      parts.push(el);
      return el;
    };

    const when = lastOk ? `synced ${ago(lastOk)}` : "not synced yet on this device";
    const n = pending.items.length;
    const state =
      phase === "syncing" ? "Syncing now…"
      : phase === "offline" ? "Offline. Changes are saved here and upload when you're back."
      : phase === "failed" ? `Sync failed: ${failure || "unknown error"}`
      : errors.length ? `Some items had problems · ${when}`
      : n ? `${n} ${n === 1 ? "change" : "changes"} waiting · ${when}`
      : `Up to date · ${when}`;
    const head = add("p", state, "sync-state");
    if (lastOk) head.title = lastOk.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

    if (errors.length) {
      add("h4", `Problems (${errors.length})`);
      const box = add("pre", errors.join("\n\n"), "sync-errors");
      box.tabIndex = 0;
    }
    if (conflicts.length) {
      add("h4", "Edited on two devices");
      add("p", `Kept both versions: ${conflicts.map((c) => `"${c}"`).join(", ")}.`, "muted");
    }

    if (pending.items.length) add("h4", `Waiting to upload (${pending.items.length})`);
    const groups = new Map<string, string[]>();
    for (const it of pending.items) groups.set(it.group, [...(groups.get(it.group) ?? []), it.label]);
    for (const [g, labels] of groups) {
      const shown = labels.slice(0, 30);
      const li = document.createElement("div");
      li.className = "sync-group";
      const t = document.createElement("strong");
      t.textContent = g;
      li.append(t);
      const ul = document.createElement("ul");
      for (const l of shown) {
        const item = document.createElement("li");
        item.textContent = l;
        ul.append(item);
      }
      if (labels.length > shown.length) {
        const more = document.createElement("li");
        more.className = "muted";
        more.textContent = `…and ${labels.length - shown.length} more`;
        ul.append(more);
      }
      li.append(ul);
      parts.push(li);
    }
    body.replaceChildren(...parts);
    ($("sync-now") as HTMLButtonElement).disabled = phase === "syncing";
  }

  let refreshing = false;
  let again = false;
  /** Recomputes the pending list from local state. Cheap; called after saves and syncs. */
  async function refreshPending() {
    if (!opts.user()) return;
    if (refreshing) return void (again = true);
    refreshing = true;
    try {
      pending = await collectPending(opts.user());
      opts.onPending(pending);
      render();
    } catch (e) {
      console.warn("could not read sync state", e);
    } finally {
      refreshing = false;
      if (again) {
        again = false;
        void refreshPending();
      }
    }
  }

  chip.addEventListener("click", async () => {
    await refreshPending();
    renderPanel();
    dialog.showModal();
  });
  $("sync-now").addEventListener("click", () => opts.syncNow());

  // Keep "Synced 3 min ago" honest without any other trigger.
  setInterval(render, 30_000);
  window.addEventListener("offline", () => { phase = "offline"; render(); });
  window.addEventListener("online", () => { if (phase === "offline") phase = "idle"; render(); });

  render();

  return {
    start() {
      loadLast();
      if (!navigator.onLine) phase = "offline";
      render();
      void refreshPending();
    },
    refreshPending,
    getPending: () => pending,
    syncing() {
      phase = "syncing";
      render();
    },
    /** A pass finished. Per-item problems are listed; conflict copies are mentioned. */
    done(res: { errors: string[]; conflicts: string[] }) {
      phase = "idle";
      errors = res.errors;
      conflicts = res.conflicts.length ? res.conflicts : conflicts;
      lastOk = new Date();
      try { localStorage.setItem(lastKey(), lastOk.toISOString()); } catch {}
      void refreshPending();
    },
    /** The pass could not run at all (network down, server error). */
    failed(message: string) {
      failure = message;
      phase = navigator.onLine ? "failed" : "offline";
      void refreshPending();
    },
    /** Another pass already running; leave the chip alone. */
    skipped() {
      render();
    },
  };
}
