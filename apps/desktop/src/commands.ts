/**
 * The Rust commands (src-tauri/src) that take plain arguments, with their argument and result types in one place.
 * `call` is `invoke` with those types checked, so a renamed argument or a changed result shape is a compile error
 * here instead of a failure at run time. Commands that take a raw body with headers (images, previews, OCR) or
 * whose name is chosen at run time still go through `invoke` directly.
 *
 * Keep in step with the `#[tauri::command]` signatures; argument names are camelCase here, snake_case in Rust.
 */
import { invoke } from "@tauri-apps/api/core";
import type { DocKind } from "@texture/api";

/** Sync state every local item carries (`Meta` in lib.rs). */
export type SyncState = {
  path: string;
  dirty: boolean;
  remote_at: string | null;
  id?: string | null;
  remote_path?: string | null;
};
export type DocInfo = SyncState & {
  snippet: string;
  has_preview: boolean;
  preview_at: string | null;
  preview_dirty: boolean;
  images_synced: boolean;
  has_images: boolean;
};
export type FolderInfo = SyncState;
export type TemplateInfo = SyncState & { builtin: boolean; has_preview: boolean; preview_at: string | null; preview_dirty: boolean };
export type ConfigInfo = { path: string; dirty: boolean; remote_at: string | null };
export type Tombstone = { kind: DocKind; path: string; id?: string | null; remote_at: string };

type U = { user: string };
type Doc = U & { path: string };
type Tpl = U & { name: string };

/** command name -> [arguments, result] */
export type Commands = {
  list_configs: [U, ConfigInfo[]];
  load_config: [Tpl, string | null];
  save_config: [Tpl & { source: string }, void];
  list_documents: [U, DocInfo[]];
  list_folders: [U, FolderInfo[]];
  list_templates: [U, TemplateInfo[]];
  create_folder: [Doc, void];
  create_document: [Doc & { template: string }, string];
  duplicate_document: [Doc, string];
  duplicate_template: [Tpl, string];
  load_source: [Doc, string];
  save_source: [Doc & { source: string }, void];
  read_template: [Tpl, string];
  save_template: [Tpl & { source: string; overwrite: boolean }, void];
  read_template_preview: [Tpl, ArrayBuffer];
  compile_template_preview: [Tpl, ArrayBuffer];
  read_preview: [Doc, ArrayBuffer];
  delete_item: [Doc, void];
  delete_template: [Tpl, void];
  move_item: [U & { from: string; to: string }, void];
  rename_template: [U & { from: string; to: string }, void];
  // sync
  apply_remote: [Doc & { kind: DocKind; source: string; remoteAt: string | null; dirty: boolean; id: string | null; remotePath: string | null }, void];
  mark_synced: [Doc & { kind: DocKind; pushed: string; remoteAt: string; id: string }, boolean];
  set_item_id: [Doc & { kind: DocKind; id: string }, void];
  rename_local: [U & { kind: DocKind; from: string; to: string }, void];
  remove_local: [Doc & { kind: DocKind }, void];
  list_deletions: [U, Tombstone[]];
  clear_deletion: [Doc & { kind: DocKind; id: string | null }, void];
  list_images: [Doc, string[]];
  read_image: [Doc & { name: string }, ArrayBuffer];
  mark_images_synced: [Doc & { names: string[] }, void];
  // compile, export, format
  compile: [Doc & { source: string; scratch: boolean }, ArrayBuffer];
  export_pdf: [Doc & { source: string; scratch: boolean; dest: string }, void];
  format_tex: [{ text: string; wrap: boolean; wraplen: number; indent: string }, string];
  // inbox thumbnails, OCR key
  thumb_get: [U & { id: string }, ArrayBuffer];
  thumb_prune: [U & { keep: string[] }, void];
  set_api_key: [U & { key: string }, void];
  has_api_key: [U, boolean];
  test_api_key: [U, void];
};

export function call<K extends keyof Commands>(name: K, args: Commands[K][0]): Promise<Commands[K][1]> {
  return invoke(name, args as Record<string, unknown>);
}
