import { invoke } from "@tauri-apps/api/core";
import type { createApi, DocKind, RemoteDoc } from "@texture/api";

type Api = ReturnType<typeof createApi>;
type LocalDoc = {
  path: string;
  /** Stable server identity; null until the item has been seen by (or pushed to) the server. */
  id?: string | null;
  /** The path the server had when this copy last matched it; a different `path` is a local rename to push. */
  remote_path?: string | null;
  dirty: boolean;
  remote_at: string | null;
  builtin?: boolean;
  has_preview?: boolean;
  preview_at?: string | null;
  preview_dirty?: boolean;
};
type Tombstone = { kind: DocKind; path: string; id?: string | null; remote_at: string };

export type SyncResult = {
  /** Documents whose local files were replaced by a newer server copy. */
  pulled: string[];
  /** Documents created locally to hold the server's version after an edit conflict. */
  conflicts: string[];
  /** Documents/folders removed locally because they were deleted on another device. */
  removed: string[];
  /** Items renamed or moved here because that happened on another device. */
  renamed: { kind: DocKind; from: string; to: string }[];
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
async function syncDeletions(api: Api, user: string, out: SyncResult) {
  for (const t of await invoke<Tombstone[]>("list_deletions", { user })) {
    const id = t.id ? fixId(t.id) : null;
    const done = await api.deleteDoc(t.kind, { id, path: t.path }, t.remote_at);
    // Files live under the id; items from before ids existed used their path as id.
    const key = id ?? t.path;
    if (done && t.kind === "document") await api.removeDocFiles(key).catch(() => {});
    if (done && t.kind === "template") await api.removePreview("template", key).catch(() => {});
    if (!done) {
      // Normally the row changed or vanished since (an edit elsewhere wins over this delete). If it is live and
      // still at the deleted version, the delete simply did not apply: keep it queued and say so, rather than
      // forgetting it and letting the item come back on the next pull.
      const stuck = (await api.listDocs(t.kind)).find(
        (d) => !d.deleted_at && d.updated_at === t.remote_at && (id ? d.id === id : d.path === t.path),
      );
      if (stuck) {
        out.errors.push(`${t.kind} ${JSON.stringify(t.path)}: the server did not apply the deletion`);
        continue;
      }
    }
    await invoke("clear_deletion", { user, kind: t.kind, path: t.path, id: t.id ?? null });
  }
}

/** '!' cannot appear in a name, so a generated id never equals a path. (Storage rejects '~', which ids briefly used.) */
const newId = () => `!${crypto.randomUUID()}`;
const fixId = (id: string) => (id.startsWith("~") ? `!${id.slice(1)}` : id);

/**
 * Local-first sync of one kind of item. Items are matched by id, never by path, so a rename is an update
 * of the server row's path. Each item remembers the server `updated_at` it was last in step with (remote_at)
 * and the path the server had then (remote_path):
 *  - clean + server moved on   -> pull (content and, if another device renamed it, the new path)
 *  - dirty or renamed here + server unchanged -> push (conditional on remote_at, so a racing writer can't be clobbered)
 *  - dirty + server moved on   -> conflict: the server's version is kept as "<path> (conflict)",
 *                                 then the local version is pushed over it
 *  - renamed on both devices   -> the local name wins
 *  - server deleted it         -> clean local copies are removed; locally edited/renamed/new ones are restored
 * Items that predate ids are matched to the server row with their path once, then keep that id.
 * Throws if the network is unreachable; callers treat that as "offline".
 */
async function syncKind(api: Api, user: string, kind: DocKind, out: SyncResult): Promise<() => Promise<void>> {
  const rows = await api.listDocs(kind);
  const remote = new Map<string, RemoteDoc>(rows.map((d) => [d.id, d]));
  const livePath = new Map(rows.filter((d) => !d.deleted_at).map((d) => [d.path, d]));
  const items = (await invoke<LocalDoc[]>(LIST_CMD[kind], { user })).filter((d) => !d.builtin);

  // Ids from the short-lived '~' form map to their '!' form (migration 0010 renamed the server rows).
  for (const l of items) {
    if (l.id && l.id !== fixId(l.id)) {
      l.id = fixId(l.id);
      await invoke("set_item_id", { user, kind, path: l.path, id: l.id });
    }
  }
  // Give every local item its identity.
  const claimed = new Set(items.map((d) => d.id).filter(Boolean));
  for (const l of items) {
    if (l.id) continue;
    if (kind === "config") {
      l.id = l.path;
      continue;
    }
    // Synced before ids existed: the server row's id is the path it had then. Never synced: join a live row of
    // the same name (another device made it first) so the usual conflict handling applies.
    let hit = (l.remote_at !== null ? remote.get(l.path) : undefined) ?? livePath.get(l.path);
    if (hit && claimed.has(hit.id)) hit = undefined; // that row already belongs to another local item (renamed here)
    l.id = hit ? hit.id : newId();
    claimed.add(l.id);
    await invoke("set_item_id", { user, kind, path: l.path, id: l.id });
  }
  const local = new Map(items.map((d) => [d.id!, d]));
  const localByPath = new Map(items.map((d) => [d.path, d]));
  const removals: string[] = [];

  const rename = async (l: LocalDoc, to: string) => {
    const from = l.path;
    await invoke("rename_local", { user, kind, from, to });
    out.renamed.push({ kind, from, to });
    localByPath.delete(from);
    localByPath.set(to, l);
    l.path = to;
  };

  const pull = async (id: string, asPath: string, dirty = false) => {
    const doc = await api.getDoc(kind, id);
    await invoke("apply_remote", {
      user, kind, path: asPath, source: doc.source, remoteAt: dirty ? null : doc.updated_at, dirty,
      id: dirty ? null : doc.id, remotePath: dirty ? null : doc.path,
    });
    if (kind === "document" && !dirty) out.pulled.push(asPath);
    if (kind === "config") out.configPulled = true;
  };

  /** Writes the local copy (content and path) to the server. `baseAt` null means a new row. */
  const push = async (l: LocalDoc, baseAt: string | null, undelete = false) => {
    const taken = livePath.get(l.path);
    if (taken && taken.id !== l.id) throw new Error(`the name ${JSON.stringify(l.path)} is already used on the server`);
    const source = await readLocal(user, kind, l.path);
    const at =
      baseAt === null
        ? await api.insertDoc(kind, l.id!, l.path, source)
        : await api.updateDoc(kind, l.id!, { path: l.path, source }, baseAt, undelete);
    if (at === null) return; // lost a race; the next pass will see the new server state
    const kept = await invoke<boolean>("mark_synced", { user, kind, path: l.path, pushed: source, remoteAt: at, id: l.id });
    if (kept === false) {
      // Deleted here while the push was on its way: the row just written must not outlive it.
      await api.deleteDoc(kind, { id: l.id, path: l.path }, at);
      return;
    }
    // Later items in this pass see the name as taken (or freed, when this was a rename).
    for (const [p, d] of livePath) if (d.id === l.id) livePath.delete(p);
    livePath.set(l.path, { id: l.id!, path: l.path, updated_at: at, deleted_at: null });
    if (kind === "document") out.touched.add(l.path);
  };

  // Items known on both sides first (renames free up names), then ones only the server has, then new local ones.
  const order = [
    ...[...remote.keys()].filter((id) => local.has(id)),
    ...[...remote.keys()].filter((id) => !local.has(id)),
    ...[...local.keys()].filter((id) => !remote.has(id)),
  ];
  for (const id of order) {
    const l = local.get(id);
    try {
      await syncOne(id);
    } catch (e) {
      // One bad item must not block the rest. Network failures surface from the listing calls above.
      out.errors.push(`${kind} ${JSON.stringify(l?.path ?? remote.get(id)?.path ?? id)}: ${e}`);
    }
  }

  async function syncOne(id: string) {
    const r = remote.get(id);
    const l = local.get(id);
    // Renamed on this device since the last sync. (A folder renamed elsewhere also leaves its children with a stale
    // remote_path, but they already sit at the server's path, so there is nothing to push.)
    const renamedHere = !!l && l.remote_path != null && l.path !== l.remote_path && l.path !== r?.path;

    if (r?.deleted_at) {
      if (!l) return;
      // Never synced (remote_at null) or changed since: local work wins over the deletion.
      if (l.dirty || renamedHere || l.remote_at === null) await push(l, r.updated_at, true);
      else removals.push(l.path);
    } else if (r && !l) {
      const clash = localByPath.get(r.path);
      if (clash) throw new Error(`${JSON.stringify(r.path)} on the server clashes with a different local item of that name`);
      await pull(id, r.path);
    } else if (!r && l) {
      await push(l, null);
    } else if (r && l) {
      if (l.remote_at === null && r.path === l.path) {
        // Never marked as synced, yet the server has this exact item: an earlier push got there but this device never
        // heard back. If the content matches, there is nothing to reconcile.
        const source = await readLocal(user, kind, l.path);
        if ((await api.getDoc(kind, id)).source === source) {
          await invoke("mark_synced", { user, kind, path: l.path, pushed: source, remoteAt: r.updated_at, id });
          return;
        }
      }
      if (r.updated_at === l.remote_at) {
        if (l.dirty || renamedHere) await push(l, r.updated_at);
      } else if (!l.dirty) {
        // The server moved on: take its content, and its name unless this device renamed it too.
        if (!renamedHere && l.path !== r.path) await rename(l, r.path);
        await pull(id, l.path);
        if (renamedHere) await push(l, r.updated_at);
      } else if (kind === "document") {
        // Preserve the server's version before overwriting it, next to the original.
        let copy = `${r.path} (conflict)`;
        for (let i = 2; localByPath.has(copy) || livePath.has(copy); i++) copy = `${r.path} (conflict ${i})`;
        await pull(id, copy, true);
        out.conflicts.push(copy);
        if (!renamedHere && l.path !== r.path) await rename(l, r.path);
        await push(l, r.updated_at);
      } else {
        // Templates (and folders, which carry no content): newest save wins, no copy.
        if (!renamedHere && l.path !== r.path) await rename(l, r.path);
        await push(l, r.updated_at);
      }
    }
  }

  // Deepest first, so a folder is only considered once the items inside it are gone.
  return async () => {
    for (const path of removals.sort((a, b) => depth(b) - depth(a))) {
      await invoke("remove_local", { user, kind, path });
      out.removed.push(path);
    }
  };
}

/** The commands and argument names that differ between document and template thumbnails. */
const PREVIEW = {
  document: { list: "list_documents", read: "read_preview", apply: "apply_preview", mark: "mark_preview", arg: "path", header: "x-path" },
  template: { list: "list_templates", read: "read_template_preview", apply: "apply_template_preview", mark: "mark_template_preview", arg: "name", header: "x-name" },
} as const;

/** Uploads previews rendered here and downloads ones rendered on other devices. Best effort. */
async function syncPreviewKind(api: Api, user: string, kind: "document" | "template") {
  const c = PREVIEW[kind];
  const remote = new Map((await api.listDocs(kind)).map((d) => [d.id, d]));
  for (const l of await invoke<LocalDoc[]>(c.list, { user })) {
    if (l.builtin || !l.id) continue; // built-in templates have no server row; unsynced items are retried after the push
    const r = remote.get(l.id);
    if (!r || r.deleted_at) continue;
    if (l.preview_dirty && l.has_preview) {
      const bytes = new Uint8Array(await invoke<ArrayBuffer>(c.read, { user, [c.arg]: l.path }));
      await api.uploadPreview(kind, l.id, bytes);
      const marker = crypto.randomUUID();
      if (await api.setPreviewAt(kind, l.id, marker)) await invoke(c.mark, { user, [c.arg]: l.path, previewAt: marker });
    } else if (r.preview_at && r.preview_at !== l.preview_at) {
      const bytes = await api.downloadPreview(kind, l.id);
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

async function syncImages(api: Api, user: string, path: string, id: string) {
  const [remote, local] = await Promise.all([
    api.listDocImages(id),
    invoke<string[]>("list_images", { user, path }),
  ]);
  for (const name of local) {
    if (remote.includes(name)) continue;
    const bytes = new Uint8Array(await invoke<ArrayBuffer>("read_image", { user, path, name }));
    await api.uploadDocImage(id, name, bytes);
  }
  for (const name of remote) {
    if (local.includes(name) || name.startsWith(".")) continue;
    const bytes = await api.downloadDocImage(id, name);
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
  const out: SyncResult = { pulled: [], conflicts: [], removed: [], renamed: [], touched: new Set(), errors: [], configPulled: false };
  try {
    await syncDeletions(api, user, out);
    await (await syncKind(api, user, "template", out))();
    // A problem here (e.g. the server table is not set up yet) must not stop documents from syncing.
    await syncKind(api, user, "config", out).then((done) => done()).catch((e) => out.errors.push(`config: ${e?.message ?? e}`));
    // Folders first, so a folder renamed elsewhere is moved as a whole before its contents are looked at (they are
    // then already in place). Folders deleted elsewhere are removed last, once their contents are gone.
    const removeFolders = await syncKind(api, user, "folder", out);
    await (await syncKind(api, user, "document", out))();
    await removeFolders();
    for (const p of out.pulled) out.touched.add(p);
    if (current) out.touched.add(current);
    // Images are keyed by the document's id; paths may have changed during this pass.
    const ids = new Map((await invoke<LocalDoc[]>("list_documents", { user })).map((d) => [d.path, d.id]));
    for (const p of out.touched) {
      const id = ids.get(p);
      if (id && !out.removed.includes(p)) await syncImages(api, user, p, id);
    }
    await syncPreviews(api, user).catch((e) => console.warn("preview sync failed", e));
    return out;
  } finally {
    running = false;
  }
}
