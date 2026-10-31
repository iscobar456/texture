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
    onNewPhoto(cb: (p: Photo) => void) {
      return sb
        .channel("photos-inbox")
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "photos" }, (m) => cb(m.new as Photo))
        .subscribe();
    },
  };
}
