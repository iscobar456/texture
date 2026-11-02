import { invoke } from "@tauri-apps/api/core";
import type { createApi, DocKind, RemoteDoc } from "@texture/api";

type Api = ReturnType<typeof createApi>;
type LocalDoc = {
  path: string;
  dirty: boolean;
  remote_at: string | null;
  builtin?: boolean;
  has_preview?: boolean;
  preview_at?: string | null;
  preview_dirty?: boolean;
};
type Tombstone = { kind: DocKind; path: string; remote_at: string };

export type SyncResult = {
  /** Documents whose local files were replaced by a newer server copy. */
  pulled: string[];
  /** Documents created locally to hold the server's version after an edit conflict. */
  conflicts: string[];
  /** Documents/folders removed locally because they were deleted on another device. */
  removed: string[];
  /** Documents that need their images synced (pulled, or newly pushed such as after a move). */
  touched: Set<string>;
  /** The snippets file was replaced by a newer copy from another device. */
  configPulled: boolean;
  /** Items that failed individually (e.g. a malformed name on the server). Everything else still synced. */
  errors: string[];
};

const LIST_CMD: Record<DocKind, string> = {
  document: "list_documents",
  folder: "list_folders",
  template: "list_templates",
  config: "list_configs",
};

async function readLocal(user: string, kind: DocKind, path: string): Promise<string> {
  if (kind === "folder") return "";
  if (kind === "config") return (await invoke<string | null>("load_config", { user, name: path })) ?? "";
  return kind === "document"
    ? invoke<string>("load_source", { user, path })
    : invoke<string>("read_template", { user, name: path });
}

const depth = (p: string) => p.split("/").length;

/**
 * Applies local deletions on the server. A deletion only wins if the server copy is still the
 * version that was deleted; if it was edited elsewhere in the meantime, the edit wins and the
 * normal pass below pulls it back.
 */
async function syncDeletions(api: Api, user: string) {
  for (const t of await invoke<Tombstone[]>("list_deletions", { user })) {
    const done = await api.deleteDoc(t.kind, t.path, t.remote_at);
    if (done && t.kind === "document") await api.removeDocFiles(t.path).catch(() => {});
    if (done && t.kind === "template") await api.removePreview("template", t.path).catch(() => {});
    await invoke("clear_deletion", { user, kind: t.kind, path: t.path });
  }
}

/**
 * Local-first sync of one kind of item.
 * Each item remembers the server `updated_at` it was last in step with (remote_at):
 *  - clean + server moved on   -> pull
 *  - dirty + server unchanged  -> push (conditional on remote_at, so a racing writer can't be clobbered)
 *  - dirty + server moved on   -> conflict: the server's version is kept as "<path> (conflict)",
 *                                 then the local version is pushed over it
 *  - server deleted it         -> clean local copies are removed; locally edited/new ones are restored
 * Throws if the network is unreachable; callers treat that as "offline".
 */
async function syncKind(api: Api, user: string, kind: DocKind, out: SyncResult) {
  const remote = new Map<string, RemoteDoc>((await api.listDocs(kind)).map((d) => [d.path, d]));
  const local = new Map(
    (await invoke<LocalDoc[]>(LIST_CMD[kind], { user })).filter((d) => !d.builtin).map((d) => [d.path, d]),
  );

  const pull = async (path: string, asPath = path, dirty = false) => {
    const doc = await api.getDoc(kind, path);
    await invoke("apply_remote", {
      user, kind, path: asPath, source: doc.source, remoteAt: dirty ? null : doc.updated_at, dirty,
    });
    if (kind === "document" && !dirty) out.pulled.push(asPath);
    if (kind === "config") out.configPulled = true;
  };

  const push = async (path: string, baseAt: string | null, undelete = false) => {
    const source = await readLocal(user, kind, path);
    const at =
      baseAt === null
        ? await api.insertDoc(kind, path, source)
        : await api.updateDoc(kind, path, source, baseAt, undelete);
    if (at === null) return; // lost a race; the next pass will see the new server state
    await invoke("mark_synced", { user, kind, path, pushed: source, remoteAt: at });
    if (kind === "document") out.touched.add(path);
  };

  const removals: string[] = [];

  for (const path of new Set([...remote.keys(), ...local.keys()])) {
    try {
      await syncOne(path);
    } catch (e) {
      // One bad item must not block the rest. Network failures surface from the listing calls above.
      out.errors.push(`${kind} ${JSON.stringify(path)}: ${e}`);
    }
  }

  async function syncOne(path: string) {
    const r = remote.get(path);
    const l = local.get(path);

    if (r?.deleted_at) {
      if (!l) return;
      // Never synced (remote_at null) or edited since: local work wins over the deletion.
      if (l.dirty || l.remote_at === null) await push(path, r.updated_at, true);
      else removals.push(path);
    } else if (r && !l) {
      await pull(path);
    } else if (!r && l) {
      await push(path, null);
    } else if (r && l) {
      if (!l.dirty) {
        if (r.updated_at !== l.remote_at) await pull(path);
      } else if (l.remote_at === r.updated_at) {
        await push(path, r.updated_at);
      } else if (kind === "document") {
        // Preserve the server's version before overwriting it, next to the original.
        let copy = `${path} (conflict)`;
        for (let i = 2; local.has(copy) || remote.has(copy); i++) copy = `${path} (conflict ${i})`;
        await pull(path, copy, true);
        out.conflicts.push(copy);
        await push(path, r.updated_at);
      } else {
        // Templates (and folders, which carry no content): newest save wins, no copy.
        await push(path, r.updated_at);
      }
    }
  }

  // Deepest first, so a folder is only considered once the items inside it are gone.
  for (const path of removals.sort((a, b) => depth(b) - depth(a))) {
    await invoke("remove_local", { user, kind, path });
    out.removed.push(path);
  }
}

/** The commands and argument names that differ between document and template thumbnails. */
const PREVIEW = {
  document: { list: "list_documents", read: "read_preview", apply: "apply_preview", mark: "mark_preview", arg: "path", header: "x-path" },
  template: { list: "list_templates", read: "read_template_preview", apply: "apply_template_preview", mark: "mark_template_preview", arg: "name", header: "x-name" },
} as const;

/** Uploads previews rendered here and downloads ones rendered on other devices. Best effort. */
async function syncPreviewKind(api: Api, user: string, kind: "document" | "template") {
  const c = PREVIEW[kind];
  const remote = new Map((await api.listDocs(kind)).map((d) => [d.path, d]));
  for (const l of await invoke<LocalDoc[]>(c.list, { user })) {
    if (l.builtin) continue; // built-in templates have no server row; their thumbnails are always local
    const r = remote.get(l.path);
    if (!r || r.deleted_at) continue; // not on the server yet; retried after it is pushed
    if (l.preview_dirty && l.has_preview) {
      const bytes = new Uint8Array(await invoke<ArrayBuffer>(c.read, { user, [c.arg]: l.path }));
      await api.uploadPreview(kind, l.path, bytes);
      const marker = crypto.randomUUID();
      if (await api.setPreviewAt(kind, l.path, marker)) await invoke(c.mark, { user, [c.arg]: l.path, previewAt: marker });
    } else if (r.preview_at && r.preview_at !== l.preview_at) {
      const bytes = await api.downloadPreview(kind, l.path);
      if (bytes) {
        await invoke(c.apply, bytes, {
          headers: { "x-user": user, [c.header]: encodeURIComponent(l.path), "x-preview-at": r.preview_at },
        });
      }
    }
  }
}

async function syncPreviews(api: Api, user: string) {
  await syncPreviewKind(api, user, "document");
  await syncPreviewKind(api, user, "template");
}

async function syncImages(api: Api, user: string, path: string) {
  const [remote, local] = await Promise.all([
    api.listDocImages(path),
    invoke<string[]>("list_images", { user, path }),
  ]);
  for (const name of local) {
    if (remote.includes(name)) continue;
    const bytes = new Uint8Array(await invoke<ArrayBuffer>("read_image", { user, path, name }));
    await api.uploadDocImage(path, name, bytes);
  }
  for (const name of remote) {
    if (local.includes(name) || name.startsWith(".")) continue;
    const bytes = await api.downloadDocImage(path, name);
    await invoke("save_image", bytes, {
      headers: { "x-user": user, "x-path": encodeURIComponent(path), "x-name": name },
    });
  }
}

let running = false;

/** Runs one full pass. Returns null if a pass is already running. */
export async function runSync(api: Api, user: string, current: string | null): Promise<SyncResult | null> {
  if (running) return null;
  running = true;
  const out: SyncResult = { pulled: [], conflicts: [], removed: [], touched: new Set(), errors: [], configPulled: false };
  try {
    await syncDeletions(api, user);
    await syncKind(api, user, "template", out);
    // A problem here (e.g. the server table is not set up yet) must not stop documents from syncing.
    await syncKind(api, user, "config", out).catch((e) => out.errors.push(`config: ${e?.message ?? e}`));
    // Documents before folders, so folders deleted elsewhere are already empty when we try to remove them.
    await syncKind(api, user, "document", out);
    await syncKind(api, user, "folder", out);
    for (const p of out.pulled) out.touched.add(p);
    if (current) out.touched.add(current);
    for (const p of out.touched) {
      if (!out.removed.includes(p)) await syncImages(api, user, p);
    }
    await syncPreviews(api, user).catch((e) => console.warn("preview sync failed", e));
    return out;
  } finally {
    running = false;
  }
}
