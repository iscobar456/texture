# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

hwscan: a monorepo for writing homework as LaTeX on desktop and pulling in photos of paper/whiteboard work taken on a phone, with the final output being a PDF. Priority platforms: Linux + Android first, macOS + iOS second, Windows if it stays cheap.

## Layout

- `apps/desktop` — Tauri 2 app (Rust shell, vanilla-ts + Vite frontend). CodeMirror 6 editor (stex mode, optional Vim) + PDF.js preview + photo inbox (`src/main.ts`); local-first sync in `src/sync.ts`. Rust commands in `src-tauri/src/lib.rs` own all file access. `compile` shells out to `tectonic`, falling back to `pdflatex`; bundling tectonic as a sidecar is still TODO. Needs `apps/desktop/.env` (see `.env.example`).
- `apps/mobile` — Flutter app (`supabase_flutter`, `image_picker`). Currently: email/password sign-in, take/pick photo, upload to the `photos` bucket and insert a pending row. `receive_sharing_intent` and `image_cropper` are added as dependencies but not wired up yet (cropper needs Android manifest setup). Needs `--dart-define=SUPABASE_URL=... --dart-define=SUPABASE_ANON_KEY=...`.
- `packages/api` — `@hwscan/api`, the TypeScript client/contract for the desktop app (types for `photos`/`assignments`, inbox listing, download, realtime subscription, OCR invoke). The Flutter app cannot import it, so the Supabase schema is the real shared contract; keep both clients in step with `supabase/migrations`.
- `supabase/` — migrations (tables, RLS, private `photos` bucket) and the `ocr` edge function.

## Commands

- Install: `npm install` at the repo root (npm workspaces: `apps/desktop`, `packages/*`).
- Desktop dev: `npm run tauri dev` from `apps/desktop`. Frontend only: `npm run dev`.
- Desktop build: `npm run tauri build` from `apps/desktop`.
- Mobile (Flutter is at `~/flutter/bin`, check it is on PATH): from `apps/mobile`, `flutter run --dart-define=SUPABASE_URL=... --dart-define=SUPABASE_ANON_KEY=...`; `flutter analyze` to lint.

## Architecture notes

- Desktop is unusable until signed in (no local-only mode). Documents (identified by a folder path like `Physics/Week 3/HW 1`) and templates are per-account and local-first: files live in `~/Documents/hwscan/<user_id>/<folder>/.../<document>/{main.tex,images/,preview.png,.sync.json}` and `.templates/<name>.tex`, and work offline. Built-in templates are embedded in Rust and never synced.
- Sync (`src/sync.ts`; tables `documents`/`templates` + bucket `project-files` from migrations 0002-0004). `documents` holds both documents and folders (`kind` column); folders have empty source. Each local item stores the server `updated_at` it last matched (`remote_at`) plus a `dirty` flag in `.sync.json`. Clean + server newer → pull; dirty + server unchanged → conditional push; dirty + server newer → conflict, server version kept as a local `"<path> (conflict)"` document and the local version pushed. The server clock (trigger `touch_document`, which ignores `preview_at`-only updates) is the version, never client clocks.
- Delete/rename/move: a directory is a document iff it holds `main.tex`, otherwise a folder; documents cannot contain other items. Deleting records a tombstone in `<user_dir>/.deleted.json` (for anything with a `remote_at`) and sync soft-deletes the server row (`deleted_at`), conditional on the deleted version. A server tombstone removes clean local copies, but an edited or never-synced local copy wins and restores the row. Rename and move are the same op (`move_item`): old paths are tombstoned, new paths start dirty with no `remote_at`, so the server sees delete + create (images and previews are re-uploaded under the new path).
- Previews: `preview.png` (page 1 of the last compile) syncs via storage at `<uid>/<path>/preview.png`; `documents.preview_at` is an opaque marker compared for equality only. Images sync for the open document and for documents pulled or newly pushed in a pass. Templates sync and delete the same way (tombstone kind `template`); built-ins can be overridden by saving a template with the same name, and deleting the override reveals the built-in again. A template is edited in the main editor (`templateName` set, saves via `save_template`, compiles in `.scratch`).

- Phone → desktop flow: the phone uploads to the private `photos` bucket at `<user_id>/<file>` and inserts a `photos` row with `status = 'pending'`. The desktop subscribes to realtime inserts (`onNewPhoto`), downloads the image, and marks the row `imported`. Storage RLS depends on that `<user_id>/` path prefix.
- OCR-to-LaTeX runs only in the `ocr` edge function (vision model call). The API key is a Supabase secret (`ANTHROPIC_API_KEY`) and must never ship in either app. Results are stored in `photos.ocr_latex`; the desktop UI should show it for review rather than inserting it blindly.
- Realtime only works while an app is foregrounded. Background push on mobile would need FCM/APNs.
- Keep all backend access behind `packages/api` (desktop) so the backend can be swapped (e.g. PocketBase) later.
