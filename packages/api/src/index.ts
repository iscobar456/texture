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

export type DocKind = "document" | "template";
/** `path` is a folder path like "Physics/Week 3/HW 1" for documents, a plain name for templates. */
export type RemoteDoc = { path: string; updated_at: string };
const table = (k: DocKind) => (k === "document" ? "documents" : "templates");

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
    async ocr(photoId: string): Promise<string> {
      const { data, error } = await sb.functions.invoke("ocr", { body: { photo_id: photoId } });
      if (error) throw error;
      return data.latex as string;
    },
    // ---- synced documents and templates ----
    async listDocs(kind: DocKind): Promise<RemoteDoc[]> {
      const { data, error } = await sb.from(table(kind)).select("path, updated_at");
      if (error) throw error;
      return data as RemoteDoc[];
    },
    async getDoc(kind: DocKind, path: string): Promise<RemoteDoc & { source: string }> {
      const { data, error } = await sb.from(table(kind)).select("path, source, updated_at").eq("path", path).single();
      if (error) throw error;
      return data as RemoteDoc & { source: string };
    },
    /** Insert a new doc. Returns the server updated_at, or null if the name is already taken. */
    async insertDoc(kind: DocKind, path: string, source: string): Promise<string | null> {
      const { data, error } = await sb.from(table(kind)).insert({ path, source }).select("updated_at").single();
      if (error) {
        if (error.code === "23505") return null; // unique violation: someone else created it first
        throw error;
      }
      return data.updated_at as string;
    },
    /** Update only if the server copy is still at baseAt. Returns the new updated_at, or null on conflict. */
    async updateDoc(kind: DocKind, path: string, source: string, baseAt: string): Promise<string | null> {
      const { data, error } = await sb
        .from(table(kind))
        .update({ source })
        .eq("path", path)
        .eq("updated_at", baseAt)
        .select("updated_at");
      if (error) throw error;
      return data.length ? (data[0].updated_at as string) : null;
    },
    async listFolders(): Promise<string[]> {
      const { data, error } = await sb.from("folders").select("path");
      if (error) throw error;
      return data.map((f) => f.path as string);
    },
    async insertFolder(path: string) {
      const { error } = await sb.from("folders").insert({ path });
      if (error && error.code !== "23505") throw error; // already there is fine
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
    onNewPhoto(cb: (p: Photo) => void) {
      return sb
        .channel("photos-inbox")
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "photos" }, (m) => cb(m.new as Photo))
        .subscribe();
    },
  };
}
