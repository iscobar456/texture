# Texture

Write homework as LaTeX on your desktop, and pull in photos of paper or whiteboard work taken on your phone. The final output is a PDF.

- **Desktop** (Tauri 2): CodeMirror editor (optional Vim mode), live PDF preview, templates, user-defined snippets, and a photo inbox. Photos can be inserted as figures or transcribed to LaTeX with your own Anthropic API key.
- **Mobile** (Flutter): sign in, take or pick a photo, rotate and crop it, and upload it to your inbox.
- **Backend** (Supabase): auth, Postgres with row-level security, and private storage. Documents are local-first and sync when online.

Priority platforms are Linux and Android, then macOS and iOS, then Windows.

## Layout

| Path | What it is |
| --- | --- |
| `apps/desktop` | Tauri desktop app (Rust shell, TypeScript + Vite frontend) |
| `apps/mobile` | Flutter phone app |
| `packages/api` | `@texture/api`, the TypeScript client for the Supabase schema |
| `supabase/migrations` | Tables, RLS policies, and storage buckets |

## Setup

You need Node.js, a Rust toolchain, the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS, and a Supabase project. For the phone app you also need Flutter.

1. **Backend.** Create a Supabase project and apply the SQL files in `supabase/migrations` in order. Keep email confirmation on, and add `dev.texture.mobile://login-callback/` to the project's Redirect URLs.
2. **Install.** Run `npm install` at the repo root.
3. **Configure.** Copy `.env.example` to `.env` in `apps/desktop` and in `apps/mobile`, then fill in your project URL and anon (publishable) key.

### Desktop

```sh
cd apps/desktop
npm run tauri dev     # run the app
npm run tauri build   # produce a release bundle
```

Compiling uses a bundled [Tectonic](https://tectonic-typesetting.github.io/) sidecar. `tauri dev` and `tauri build` download it automatically. For a bare `cargo build`, run `node scripts/fetch-tectonic.mjs` once first. The first compile on a machine needs internet access and takes about a minute while Tectonic fetches and caches TeX support files.

To use photo transcription, add your own Anthropic API key in Settings → Photo OCR. The key stays on your device.

### Mobile

```sh
cd apps/mobile
./run.sh              # wraps `flutter run --dart-define-from-file=.env`
flutter analyze
```

## How photos reach the editor

The phone uploads to the private `photos` bucket and inserts a `pending` row. The desktop app listens for changes, shows the photo in its inbox, and lets you insert it into a document or transcribe it to LaTeX. Delivery is live only while the desktop app is open.

## Contributing

Developer notes and architecture details are in [`CLAUDE.md`](CLAUDE.md).

## License

[MIT](LICENSE)
