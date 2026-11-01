import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type Assignment = { id: string; user_id: string; title: string; created_at: string };
export type Photo = {
  id: string;
  user_id: string;
  assignment_id: string | null;
  storage_path: string;
  status: "pending" | "imported";
  ocr_latex: string | null;
  created_at: string;
};

export const PHOTO_BUCKET = "photos";
export const FILES_BUCKET = "project-files";

/** Documents and folders share the `documents` table, told apart by its `kind` column. */
export type DocKind = "document" | "folder" | "template" | "config";
/** `path` is a folder path like "Physics/Week 3/HW 1"; for templates it is a plain name. */
export type RemoteDoc = { path: string; updated_at: string; deleted_at: string | null; preview_at?: string | null };
const table = (k: DocKind) => (k === "template" ? "templates" : k === "config" ? "user_files" : "documents");
/** Documents and folders share a table and carry preview/kind columns; the others are plain path + source. */
const isDocTable = (k: DocKind) => k === "document" || k === "folder";

export function createApi(url: string, anonKey: string) {
  const sb: SupabaseClient = createClient(url, anonKey);
  return {
    sb,
    async listPending(): Promise<Photo[]> {
      const { data, error } = await sb.from("photos").select("*").eq("status", "pending").order("created_at");
      if (error) throw error;
      return data as Photo[];
    },
    async downloadPhoto(p: Photo): Promise<Blob> {
      const { data, error } = await sb.storage.from(PHOTO_BUCKET).download(p.storage_path);
      if (error) throw error;
      return data;
    },
    async markImported(id: string) {
      const { error } = await sb.from("photos").update({ status: "imported" }).eq("id", id);
      if (error) throw error;
    },
    // ---- synced documents and templates ----
    /** Includes soft-deleted rows: a tombstone is how this device learns of a deletion. */
    async listDocs(kind: DocKind): Promise<RemoteDoc[]> {
      const cols = isDocTable(kind) ? "path, updated_at, deleted_at, preview_at" : "path, updated_at, deleted_at";
      let q = sb.from(table(kind)).select(cols);
      if (isDocTable(kind)) q = q.eq("kind", kind);
      const { data, error } = await q;
      if (error) throw error;
      return data as unknown as RemoteDoc[];
    },
    async getDoc(kind: DocKind, path: string): Promise<RemoteDoc & { source: string }> {
      const { data, error } = await sb.from(table(kind)).select("path, source, updated_at, deleted_at").eq("path", path).single();
      if (error) throw error;
      return data as RemoteDoc & { source: string };
    },
    /** Insert a new doc. Returns the server updated_at, or null if the path is already taken. */
    async insertDoc(kind: DocKind, path: string, source: string): Promise<string | null> {
      const row: Record<string, string> = isDocTable(kind) ? { path, source, kind } : { path, source };
      const { data, error } = await sb.from(table(kind)).insert(row).select("updated_at").single();
      if (error) {
        if (error.code === "23505") return null; // unique violation: someone else created it first
        throw error;
      }
      return data.updated_at as string;
    },
    /**
     * Update only if the server copy is still at baseAt. Returns the new updated_at, or null on conflict.
     * `undelete` also clears a deletion marker (an edit made elsewhere wins over a delete).
     */
    async updateDoc(kind: DocKind, path: string, source: string, baseAt: string, undelete = false): Promise<string | null> {
      const { data, error } = await sb
        .from(table(kind))
        .update(undelete ? { source, deleted_at: null } : { source })
        .eq("path", path)
        .eq("updated_at", baseAt)
        .select("updated_at");
      if (error) throw error;
      return data.length ? (data[0].updated_at as string) : null;
    },
    /** Soft-delete, only if the server copy is still the version that was deleted locally. */
    async deleteDoc(kind: DocKind, path: string, baseAt: string): Promise<boolean> {
      const { data, error } = await sb
        .from(table(kind))
        .update({ deleted_at: new Date().toISOString() })
        .eq("path", path)
        .eq("updated_at", baseAt)
        .is("deleted_at", null)
        .select("path");
      if (error) throw error;
      return data.length > 0;
    },
    async setPreviewAt(path: string, marker: string): Promise<boolean> {
      const { data, error } = await sb.from("documents").update({ preview_at: marker }).eq("path", path).is("deleted_at", null).select("path");
      if (error) throw error;
      return data.length > 0;
    },
    async uploadPreview(docPath: string, bytes: Uint8Array) {
      const uid = (await sb.auth.getSession()).data.session?.user.id;
      const { error } = await sb.storage.from(FILES_BUCKET).upload(`${uid}/${docPath}/preview.png`, bytes, { upsert: true, contentType: "image/png" });
      if (error) throw error;
    },
    async downloadPreview(docPath: string): Promise<Uint8Array | null> {
      const uid = (await sb.auth.getSession()).data.session?.user.id;
      const { data, error } = await sb.storage.from(FILES_BUCKET).download(`${uid}/${docPath}/preview.png`);
      if (error) return null; // not uploaded (yet)
      return new Uint8Array(await data.arrayBuffer());
    },
    /** Best-effort cleanup of a deleted document's images and preview. */
    async removeDocFiles(docPath: string) {
      const uid = (await sb.auth.getSession()).data.session?.user.id;
      const images = await sb.storage.from(FILES_BUCKET).list(`${uid}/${docPath}/images`);
      const names = (images.data ?? []).map((f) => `${uid}/${docPath}/images/${f.name}`);
      await sb.storage.from(FILES_BUCKET).remove([...names, `${uid}/${docPath}/preview.png`]);
    },
    async listDocImages(docPath: string): Promise<string[]> {
      const uid = (await sb.auth.getSession()).data.session?.user.id;
      const { data, error } = await sb.storage.from(FILES_BUCKET).list(`${uid}/${docPath}/images`);
      if (error) throw error;
      return data.map((f) => f.name);
    },
    async uploadDocImage(docPath: string, name: string, bytes: Uint8Array) {
      const uid = (await sb.auth.getSession()).data.session?.user.id;
      const { error } = await sb.storage.from(FILES_BUCKET).upload(`${uid}/${docPath}/images/${name}`, bytes, { upsert: true });
      if (error) throw error;
    },
    async downloadDocImage(docPath: string, name: string): Promise<Uint8Array> {
      const uid = (await sb.auth.getSession()).data.session?.user.id;
      const { data, error } = await sb.storage.from(FILES_BUCKET).download(`${uid}/${docPath}/images/${name}`);
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
        .subscribe();
    },
  };
}
