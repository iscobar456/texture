import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type Assignment = { id: string; user_id: string; title: string; created_at: string };
export type Photo = {
  id: string;
  user_id: string;
  assignment_id: string | null;
  storage_path: string;
  status: "pending" | "imported" | "trashed";
  ocr_latex: string | null;
  created_at: string;
  /** When it was last inserted into a document. */
  imported_at: string | null;
  trashed_at: string | null;
  /** When the desktop first showed it in the inbox (the phone's "Delivered"). Absent before migration 0008. */
  delivered_at?: string | null;
};

export const PHOTO_BUCKET = "photos";
export const FILES_BUCKET = "project-files";

/** Documents and folders share the `documents` table, told apart by its `kind` column. */
export type DocKind = "document" | "folder" | "template" | "config";
/** `path` is a folder path like "Physics/Week 3/HW 1"; for templates it is a plain name. */
/**
 * `id` is the stable identity (a rename changes `path`, never `id`) and the key of the item's files in storage.
 * Config files have no ids; their id is their path.
 */
export type RemoteDoc = { id: string; path: string; updated_at: string; deleted_at: string | null; preview_at?: string | null };
/** The column that identifies a row of this kind. */
const idCol = (k: DocKind) => (k === "config" ? "path" : "id");
const table = (k: DocKind) => (k === "template" ? "templates" : k === "config" ? "user_files" : "documents");
/** Documents and folders share a table and carry preview/kind columns; the others are plain path + source. */
const isDocTable = (k: DocKind) => k === "document" || k === "folder";

/** How long a request may wait for the server to start answering before it is abandoned. */
const RESPONSE_TIMEOUT_MS = 20_000;

/**
 * `fetch` with a limit on the wait for a response. After a sleep or a network change, a request can sit on a dead
 * connection without ever settling; since the auth client serializes token refreshes, one such request (typically the
 * refresh due after a long break) would stall every later call. The limit covers only the wait for the response
 * headers, not reading the body, so a large photo download on a slow link is not cut off part way.
 */
const fetchWithTimeout: typeof fetch = (input, init) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DOMException("The server did not respond in time", "TimeoutError")), RESPONSE_TIMEOUT_MS);
  const outer = init?.signal;
  if (outer) {
    if (outer.aborted) ctl.abort(outer.reason);
    else outer.addEventListener("abort", () => ctl.abort(outer.reason), { once: true });
  }
  return fetch(input, { ...init, signal: ctl.signal }).finally(() => clearTimeout(timer));
};

export function createApi(url: string, anonKey: string) {
  const sb: SupabaseClient = createClient(url, anonKey, { global: { fetch: fetchWithTimeout } });
  /** "<uid>/<id>/preview.png", or "<uid>/.templates/<id>/preview.png" (ids never start with '.'). */
  const previewKey = async (kind: "document" | "template", id: string) => {
    const uid = (await sb.auth.getSession()).data.session?.user.id;
    return `${uid}/${kind === "template" ? `.templates/${id}` : id}/preview.png`;
  };
  return {
    sb,
    /** Waiting in the inbox, newest first. */
    async listPending(): Promise<Photo[]> {
      const { data, error } = await sb.from("photos").select("*").eq("status", "pending").order("created_at", { ascending: false });
      if (error) throw error;
      return data as Photo[];
    },
    /** Photos already inserted, most recently used first. Older rows without a date fall back to their arrival time. */
    async listUsed(limit = 20): Promise<Photo[]> {
      const { data, error } = await sb
        .from("photos")
        .select("*")
        .eq("status", "imported")
        .order("imported_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data as Photo[];
    },
    async listTrashed(): Promise<Photo[]> {
      const { data, error } = await sb.from("photos").select("*").eq("status", "trashed").order("trashed_at", { ascending: false });
      if (error) throw error;
      return data as Photo[];
    },
    async downloadPhoto(p: Photo): Promise<Blob> {
      const { data, error } = await sb.storage.from(PHOTO_BUCKET).download(p.storage_path);
      if (error) throw error;
      return data;
    },
    /** Tells the phone these photos reached the inbox. Best effort: harmless if migration 0008 is missing. */
    async markDelivered(ids: string[]) {
      for (const part of chunks(ids)) {
        const { error } = await sb.from("photos").update({ delivered_at: new Date().toISOString() }).in("id", part).is("delivered_at", null);
        if (error) throw error;
      }
    },
    async markImported(id: string) {
      const { error } = await sb.from("photos").update({ status: "imported", imported_at: new Date().toISOString() }).eq("id", id);
      if (error) throw error;
    },
    /** Keeps a transcription with the photo so OCR is not paid for twice; null clears it. */
    async saveOcr(id: string, latex: string | null) {
      const { error } = await sb.from("photos").update({ ocr_latex: latex }).eq("id", id);
      if (error) throw error;
    },
    /** An undoable delete: the file stays until the trash is purged. */
    async trashPhoto(id: string) {
      const { error } = await sb.from("photos").update({ status: "trashed", trashed_at: new Date().toISOString() }).eq("id", id);
      if (error) throw error;
    },
    async restorePhoto(id: string) {
      const { error } = await sb.from("photos").update({ status: "pending", trashed_at: null }).eq("id", id);
      if (error) throw error;
    },
    /** Batch forms of trash / restore / delete, for multi-select. Rows go in chunks so the request URL stays short. */
    async trashPhotos(ids: string[]) {
      for (const part of chunks(ids)) {
        const { error } = await sb.from("photos").update({ status: "trashed", trashed_at: new Date().toISOString() }).in("id", part);
        if (error) throw error;
      }
    },
    async restorePhotos(ids: string[]) {
      for (const part of chunks(ids)) {
        const { error } = await sb.from("photos").update({ status: "pending", trashed_at: null }).in("id", part);
        if (error) throw error;
      }
    },
    /** Rows first, then the files (see deletePhoto). */
    async deletePhotos(ps: Photo[]) {
      for (const part of chunks(ps)) {
        const { error } = await sb.from("photos").delete().in("id", part.map((p) => p.id));
        if (error) throw error;
        await sb.storage.from(PHOTO_BUCKET).remove(part.map((p) => p.storage_path)).catch(() => {});
      }
    },
    /** Permanently deletes photos that have been in the trash longer than `days`. Returns how many. */
    async purgeTrash(days = 7): Promise<number> {
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const { data, error } = await sb.from("photos").select("*").eq("status", "trashed").lt("trashed_at", cutoff);
      if (error) throw error;
      for (const p of data as Photo[]) {
        const del = await sb.from("photos").delete().eq("id", p.id);
        if (del.error) throw del.error;
        await sb.storage.from(PHOTO_BUCKET).remove([p.storage_path]).catch(() => {});
      }
      return data.length;
    },
    // ---- synced documents and templates ----
    /** Includes soft-deleted rows: a tombstone is how this device learns of a deletion. */
    async listDocs(kind: DocKind): Promise<RemoteDoc[]> {
      const cols = kind === "config" ? "path, updated_at, deleted_at" : "id, path, updated_at, deleted_at, preview_at";
      let q = sb.from(table(kind)).select(cols);
      if (isDocTable(kind)) q = q.eq("kind", kind);
      const { data, error } = await q;
      if (error) throw error;
      const rows = data as unknown as RemoteDoc[];
      return kind === "config" ? rows.map((r) => ({ ...r, id: r.path })) : rows;
    },
    async getDoc(kind: DocKind, id: string): Promise<RemoteDoc & { source: string }> {
      const { data, error } = await sb.from(table(kind)).select(`${idCol(kind)}, path, source, updated_at, deleted_at`).eq(idCol(kind), id).single();
      if (error) throw error;
      const row = data as unknown as RemoteDoc & { source: string };
      return kind === "config" ? { ...row, id: row.path } : row;
    },
    /** Insert a new doc. Returns the server updated_at, or null if that id is already taken (a lost race). */
    async insertDoc(kind: DocKind, id: string, path: string, source: string): Promise<string | null> {
      const row: Record<string, string> =
        kind === "config" ? { path, source } : isDocTable(kind) ? { id, path, source, kind } : { id, path, source };
      const { data, error } = await sb.from(table(kind)).insert(row).select("updated_at").single();
      if (error) {
        if (error.code === "23505") return null; // unique violation: someone else created it first
        throw error;
      }
      return data.updated_at as string;
    },
    /**
     * Update only if the server copy is still at baseAt. Returns the new updated_at, or null on conflict.
     * `path` renames or moves it. `undelete` also clears a deletion marker (an edit made elsewhere wins over a delete).
     */
    async updateDoc(kind: DocKind, id: string, patch: { path?: string; source?: string }, baseAt: string, undelete = false): Promise<string | null> {
      const { data, error } = await sb
        .from(table(kind))
        .update(undelete ? { ...patch, deleted_at: null } : patch)
        .eq(idCol(kind), id)
        .eq("updated_at", baseAt)
        .select("updated_at");
      if (error) throw error;
      return data.length ? (data[0].updated_at as string) : null;
    },
    /**
     * Soft-delete, only if the server copy is still the version that was deleted locally.
     * Deletions recorded before ids existed carry no id and are found by path.
     */
    async deleteDoc(kind: DocKind, ref: { id?: string | null; path: string }, baseAt: string): Promise<boolean> {
      let q = sb.from(table(kind)).update({ deleted_at: new Date().toISOString() });
      q = ref.id && kind !== "config" ? q.eq("id", ref.id) : q.eq("path", ref.path);
      const { data, error } = await q.eq("updated_at", baseAt).is("deleted_at", null).select("path");
      if (error) throw error;
      return data.length > 0;
    },
    async setPreviewAt(kind: "document" | "template", id: string, marker: string): Promise<boolean> {
      const { data, error } = await sb.from(table(kind)).update({ preview_at: marker }).eq("id", id).is("deleted_at", null).select("id");
      if (error) throw error;
      return data.length > 0;
    },
    async uploadPreview(kind: "document" | "template", id: string, bytes: Uint8Array) {
      const { error } = await sb.storage.from(FILES_BUCKET).upload(await previewKey(kind, id), bytes, { upsert: true, contentType: "image/png" });
      if (error) throw error;
    },
    async downloadPreview(kind: "document" | "template", id: string): Promise<Uint8Array | null> {
      const { data, error } = await sb.storage.from(FILES_BUCKET).download(await previewKey(kind, id));
      if (error) return null; // not uploaded (yet)
      return new Uint8Array(await data.arrayBuffer());
    },
    /** Best-effort: a deleted template's thumbnail. */
    async removePreview(kind: "document" | "template", id: string) {
      await sb.storage.from(FILES_BUCKET).remove([await previewKey(kind, id)]);
    },
    /** Best-effort cleanup of a deleted document's images and preview. */
    async removeDocFiles(id: string) {
      const uid = (await sb.auth.getSession()).data.session?.user.id;
      const images = await sb.storage.from(FILES_BUCKET).list(`${uid}/${id}/images`);
      const names = (images.data ?? []).map((f) => `${uid}/${id}/images/${f.name}`);
      await sb.storage.from(FILES_BUCKET).remove([...names, `${uid}/${id}/preview.png`]);
    },
    async listDocImages(id: string): Promise<string[]> {
      const uid = (await sb.auth.getSession()).data.session?.user.id;
      const { data, error } = await sb.storage.from(FILES_BUCKET).list(`${uid}/${id}/images`);
      if (error) throw error;
      return data.map((f) => f.name);
    },
    async uploadDocImage(id: string, name: string, bytes: Uint8Array) {
      const uid = (await sb.auth.getSession()).data.session?.user.id;
      const { error } = await sb.storage.from(FILES_BUCKET).upload(`${uid}/${id}/images/${name}`, bytes, { upsert: true });
      if (error) throw error;
    },
    async downloadDocImage(id: string, name: string): Promise<Uint8Array> {
      const uid = (await sb.auth.getSession()).data.session?.user.id;
      const { data, error } = await sb.storage.from(FILES_BUCKET).download(`${uid}/${id}/images/${name}`);
      if (error) throw error;
      return new Uint8Array(await data.arrayBuffer());
    },
    /** Row first, then the file: a leftover file is harmless, a row pointing at nothing is not. */
    async deletePhoto(p: Photo) {
      const { error } = await sb.from("photos").delete().eq("id", p.id);
      if (error) throw error;
      await sb.storage.from(PHOTO_BUCKET).remove([p.storage_path]).catch(() => {});
    },
    /** Fires when photos arrive, are imported or are deleted (here or on another device). */
    onInboxChange(cb: () => void) {
      return sb
        .channel("photos-inbox")
        .on("postgres_changes", { event: "*", schema: "public", table: "photos" }, () => cb())
        // Realtime does not replay events missed while disconnected (sleep, network drop), so every (re)join
        // reloads once; supabase-js rejoins the channel on its own.
        .subscribe((status) => { if (status === "SUBSCRIBED") cb(); });
    },
  };
}

function chunks<T>(items: T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
