import { invoke } from "@tauri-apps/api/core";
import type { createApi, DocKind } from "@hwscan/api";

type Api = ReturnType<typeof createApi>;
type LocalDoc = { path: string; dirty: boolean; remote_at: string | null; builtin?: boolean };

export type SyncResult = {
  /** Documents whose local files were replaced by a newer server copy. */
  pulled: string[];
  /** Documents created locally to hold the server's version after an edit conflict. */
  conflicts: string[];
};

const LIST_CMD: Record<DocKind, string> = { document: "list_documents", template: "list_templates" };

async function readLocal(user: string, kind: DocKind, path: string): Promise<string> {
  return kind === "document"
    ? invoke<string>("load_source", { user, path })
    : invoke<string>("read_template", { user, name: path });
}

/**
 * Local-first sync of one kind of doc.
 * Each doc remembers the server `updated_at` it was last in step with (remote_at):
 *  - clean + server moved on  -> pull
 *  - dirty + server unchanged -> push (conditional on remote_at, so a racing writer can't be clobbered)
 *  - dirty + server moved on  -> conflict: the server's version is kept as "<path> (conflict)",
 *                                then the local version is pushed over it.
 * Throws if the network is unreachable; callers treat that as "offline".
 */
async function syncKind(api: Api, user: string, kind: DocKind, out: SyncResult) {
  const remote = new Map((await api.listDocs(kind)).map((d) => [d.path, d.updated_at]));
  const local = new Map(
    (await invoke<LocalDoc[]>(LIST_CMD[kind], { user })).filter((d) => !d.builtin).map((d) => [d.path, d]),
  );

  const pull = async (path: string, asPath = path, dirty = false) => {
    const doc = await api.getDoc(kind, path);
    await invoke("apply_remote", {
      user, kind, path: asPath, source: doc.source, remoteAt: dirty ? null : doc.updated_at, dirty,
    });
    if (kind === "document" && !dirty) out.pulled.push(asPath);
    return doc.updated_at;
  };

  const push = async (path: string, baseAt: string | null) => {
    const source = await readLocal(user, kind, path);
    const at = baseAt === null ? await api.insertDoc(kind, path, source) : await api.updateDoc(kind, path, source, baseAt);
    if (at === null) return false; // lost a race; the next pass will see the new server state
    await invoke("mark_synced", { user, kind, path, pushed: source, remoteAt: at });
    return true;
  };

  for (const path of new Set([...remote.keys(), ...local.keys()])) {
    const r = remote.get(path);
    const l = local.get(path);
    if (r && !l) {
      await pull(path);
    } else if (!r && l) {
      await push(path, null);
    } else if (r && l) {
      if (!l.dirty) {
        if (r !== l.remote_at) await pull(path);
      } else if (l.remote_at === r) {
        await push(path, r);
      } else if (kind === "document") {
        // Preserve the server's version before overwriting it, next to the original.
        let copy = `${path} (conflict)`;
        for (let i = 2; local.has(copy) || remote.has(copy); i++) copy = `${path} (conflict ${i})`;
        await pull(path, copy, true);
        out.conflicts.push(copy);
        await push(path, r);
      } else {
        // Templates: newest save wins, no copy.
        await push(path, r);
      }
    }
  }
}

/** Folders only ever get added (no delete yet), so syncing is a set union. */
async function syncFolders(api: Api, user: string) {
  const remote = new Set(await api.listFolders());
  const local = new Set(await invoke<string[]>("list_folders", { user }));
  for (const p of local) if (!remote.has(p)) await api.insertFolder(p);
  for (const p of remote) if (!local.has(p)) await invoke("create_folder", { user, path: p }).catch(() => {});
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
  const out: SyncResult = { pulled: [], conflicts: [] };
  try {
    await syncKind(api, user, "template", out);
    await syncFolders(api, user);
    await syncKind(api, user, "document", out);
    for (const p of new Set([...out.pulled, ...(current ? [current] : [])])) await syncImages(api, user, p);
    return out;
  } finally {
    running = false;
  }
}
