# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

hwscan: a monorepo for writing homework as LaTeX on desktop and pulling in photos of paper/whiteboard work taken on a phone, with the final output being a PDF. Priority platforms: Linux + Android first, macOS + iOS second, Windows if it stays cheap.

## Layout

- `apps/desktop` — Tauri 2 app (Rust shell, vanilla-ts + Vite frontend). Planned: CodeMirror 6 editor, PDF.js preview, `tectonic` bundled as a sidecar (`externalBin`) for compiling.
- `apps/mobile` — Flutter app (`supabase_flutter`, `image_picker`). Currently: email/password sign-in, take/pick photo, upload to the `photos` bucket and insert a pending row. `receive_sharing_intent` and `image_cropper` are added as dependencies but not wired up yet (cropper needs Android manifest setup). Needs `--dart-define=SUPABASE_URL=... --dart-define=SUPABASE_ANON_KEY=...`.
- `packages/api` — `@hwscan/api`, the TypeScript client/contract for the desktop app (types for `photos`/`assignments`, inbox listing, download, realtime subscription, OCR invoke). The Flutter app cannot import it, so the Supabase schema is the real shared contract; keep both clients in step with `supabase/migrations`.
- `supabase/` — migrations (tables, RLS, private `photos` bucket) and the `ocr` edge function.

## Commands

- Install: `npm install` at the repo root (npm workspaces: `apps/desktop`, `packages/*`).
- Desktop dev: `npm run tauri dev` from `apps/desktop`. Frontend only: `npm run dev`.
- Desktop build: `npm run tauri build` from `apps/desktop`.
- Mobile (Flutter is at `~/flutter/bin`, check it is on PATH): from `apps/mobile`, `flutter run --dart-define=SUPABASE_URL=... --dart-define=SUPABASE_ANON_KEY=...`; `flutter analyze` to lint.

## Architecture notes

- Phone → desktop flow: the phone uploads to the private `photos` bucket at `<user_id>/<file>` and inserts a `photos` row with `status = 'pending'`. The desktop subscribes to realtime inserts (`onNewPhoto`), downloads the image, and marks the row `imported`. Storage RLS depends on that `<user_id>/` path prefix.
- OCR-to-LaTeX runs only in the `ocr` edge function (vision model call). The API key is a Supabase secret (`ANTHROPIC_API_KEY`) and must never ship in either app. Results are stored in `photos.ocr_latex`; the desktop UI should show it for review rather than inserting it blindly.
- Realtime only works while an app is foregrounded. Background push on mobile would need FCM/APNs.
- Keep all backend access behind `packages/api` (desktop) so the backend can be swapped (e.g. PocketBase) later.
