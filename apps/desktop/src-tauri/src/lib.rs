use std::fs;
use std::path::PathBuf;
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::Manager;

const TEMPLATE_HOMEWORK: &str = r"\documentclass{article}
\usepackage{amsmath, amssymb, graphicx}
\usepackage[margin=1in]{geometry}
\title{Homework}
\author{}
\begin{document}
\maketitle

\section*{Problem 1}

\end{document}
";

const TEMPLATE_BLANK: &str = r"\documentclass{article}
\begin{document}

\end{document}
";

/// Built-ins are embedded, never written to disk and never synced.
const BUILTIN_TEMPLATES: [(&str, &str); 2] =
    [("Homework", TEMPLATE_HOMEWORK), ("Blank", TEMPLATE_BLANK)];

/// Per-document sync state, stored beside the document.
/// `remote_at` is the server `updated_at` this copy was last in step with.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
struct Meta {
    dirty: bool,
    remote_at: Option<String>,
    /// Marker of the server preview this local preview.png matches.
    preview_at: Option<String>,
    /// preview.png was rendered here and not uploaded yet.
    preview_dirty: bool,
}

/// A deletion not yet applied on the server. `remote_at` is the version that was deleted.
#[derive(Serialize, Deserialize, Clone)]
struct Tombstone {
    kind: String,
    path: String,
    remote_at: String,
}

#[derive(Serialize)]
struct DocInfo {
    path: String,
    dirty: bool,
    remote_at: Option<String>,
    /// Start of the document body, shown when there is no rendered preview.
    snippet: String,
    has_preview: bool,
    preview_at: Option<String>,
    preview_dirty: bool,
}

#[derive(Serialize)]
struct FolderInfo {
    path: String,
    dirty: bool,
    remote_at: Option<String>,
}

#[derive(Serialize)]
struct TemplateInfo {
    path: String,
    dirty: bool,
    remote_at: Option<String>,
    builtin: bool,
    snippet: String,
}

/// Names become folder/file names, so only allow a plain, visible name.
fn valid_name(name: &str) -> Result<&str, String> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name == name.trim()
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '(' | ')'));
    if ok { Ok(name) } else { Err(format!("invalid name: {name:?}")) }
}

/// A document/folder path is 1..=8 valid names joined by '/'.
fn segments(path: &str) -> Result<Vec<&str>, String> {
    let segs: Vec<&str> = path.split('/').collect();
    if segs.len() > 8 || path.len() > 200 {
        return Err("path too long".into());
    }
    segs.iter().try_for_each(|s| valid_name(s).map(|_| ()))?;
    Ok(segs)
}

fn valid_user(user: &str) -> Result<&str, String> {
    let ok = !user.is_empty()
        && user.len() <= 64
        && user.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if ok { Ok(user) } else { Err("invalid user id".into()) }
}

/// Writes via a temp file and rename, so a crash never leaves a half-written file behind.
/// The temp name starts with '.', which every directory listing here already ignores.
fn write_atomic(path: impl AsRef<std::path::Path>, data: impl AsRef<[u8]>) -> Result<(), String> {
    use std::io::Write;
    let path = path.as_ref();
    let name = path.file_name().ok_or("bad path")?.to_string_lossy();
    let tmp = path.with_file_name(format!(".{name}.tmp"));
    let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(data.as_ref()).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// <app data dir>/<user_id>: private to the app (not in Documents), one folder per account so
/// signed-in users never share files. PDFs leave the app only through Export.
fn user_dir(app: &tauri::AppHandle, user: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(valid_user(user)?);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn templates_dir(app: &tauri::AppHandle, user: &str) -> Result<PathBuf, String> {
    let dir = user_dir(app, user)?.join(".templates");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// A directory is a document iff it holds main.tex; anything else under the user dir is a folder.
fn is_document(dir: &std::path::Path) -> bool {
    dir.join("main.tex").is_file()
}

/// Location of a document or folder. Never creates anything.
/// Fails if an ancestor is a document, since documents cannot contain other items.
fn item_path(app: &tauri::AppHandle, user: &str, path: &str) -> Result<PathBuf, String> {
    let segs = segments(path)?;
    let mut dir = user_dir(app, user)?;
    for (i, seg) in segs.iter().enumerate() {
        if i > 0 && is_document(&dir) {
            return Err(format!("{:?} is a document, not a folder", segs[..i].join("/")));
        }
        dir.push(seg);
    }
    Ok(dir)
}

/// Same as `item_path`, but creates the document directory and its `images/` folder.
fn ensure_doc_dir(app: &tauri::AppHandle, user: &str, path: &str) -> Result<PathBuf, String> {
    let dir = item_path(app, user, path)?;
    fs::create_dir_all(dir.join("images")).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn read_meta(path: &PathBuf) -> Meta {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_meta(path: &PathBuf, meta: &Meta) -> Result<(), String> {
    write_atomic(path, serde_json::to_string(meta).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

fn update_meta(path: &PathBuf, f: impl FnOnce(&mut Meta)) -> Result<(), String> {
    let mut meta = read_meta(path);
    f(&mut meta);
    write_meta(path, &meta)
}

fn tombstone_file(app: &tauri::AppHandle, user: &str) -> Result<PathBuf, String> {
    Ok(user_dir(app, user)?.join(".deleted.json"))
}

fn read_tombstones(app: &tauri::AppHandle, user: &str) -> Result<Vec<Tombstone>, String> {
    Ok(fs::read_to_string(tombstone_file(app, user)?)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default())
}

fn write_tombstones(app: &tauri::AppHandle, user: &str, t: &[Tombstone]) -> Result<(), String> {
    write_atomic(tombstone_file(app, user)?, serde_json::to_string(t).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// Every item at or under `dir`: (kind, path, meta). Documents are leaves.
fn collect_items(dir: &std::path::Path, path: &str) -> Vec<(&'static str, String, Meta)> {
    let meta = read_meta(&dir.join(".sync.json"));
    if is_document(dir) {
        return vec![("document", path.to_string(), meta)];
    }
    let mut out = vec![("folder", path.to_string(), meta)];
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with('.') && e.path().is_dir() {
                out.extend(collect_items(&e.path(), &format!("{path}/{name}")));
            }
        }
    }
    out
}

fn template_paths(
    app: &tauri::AppHandle,
    user: &str,
    name: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let dir = templates_dir(app, user)?;
    let name = valid_name(name)?;
    Ok((dir.join(format!("{name}.tex")), dir.join(format!("{name}.sync.json"))))
}

fn builtin(name: &str) -> Option<&'static str> {
    BUILTIN_TEMPLATES.iter().find(|(n, _)| *n == name).map(|(_, b)| *b)
}

fn snippet(source: &str) -> String {
    let body = source.split_once("\\begin{document}").map_or(source, |(_, b)| b);
    body.trim().chars().take(240).collect()
}

/// Walks the account folder. Documents are not descended into.
fn walk(dir: &std::path::Path, prefix: &str, docs: &mut Vec<DocInfo>, folders: &mut Vec<FolderInfo>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let p = entry.path();
        if name.starts_with('.') || !p.is_dir() {
            continue;
        }
        let path = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        if is_document(&p) {
            let meta = read_meta(&p.join(".sync.json"));
            docs.push(DocInfo {
                snippet: snippet(&fs::read_to_string(p.join("main.tex")).unwrap_or_default()),
                has_preview: p.join("preview.png").is_file(),
                path,
                dirty: meta.dirty,
                remote_at: meta.remote_at,
                preview_at: meta.preview_at,
                preview_dirty: meta.preview_dirty,
            });
        } else {
            let meta = read_meta(&p.join(".sync.json"));
            folders.push(FolderInfo { path: path.clone(), dirty: meta.dirty, remote_at: meta.remote_at });
            walk(&p, &path, docs, folders);
        }
    }
}

#[tauri::command]
fn list_documents(app: tauri::AppHandle, user: String) -> Result<Vec<DocInfo>, String> {
    let (mut docs, mut folders) = (vec![], vec![]);
    walk(&user_dir(&app, &user)?, "", &mut docs, &mut folders);
    docs.sort_by_key(|d| d.path.to_lowercase());
    Ok(docs)
}

#[tauri::command]
fn list_folders(app: tauri::AppHandle, user: String) -> Result<Vec<FolderInfo>, String> {
    let (mut docs, mut folders) = (vec![], vec![]);
    walk(&user_dir(&app, &user)?, "", &mut docs, &mut folders);
    folders.sort_by_key(|f| f.path.to_lowercase());
    Ok(folders)
}

/// Creates a folder (and any missing parents). Existing folders are fine; a document in the way is not.
#[tauri::command]
fn create_folder(app: tauri::AppHandle, user: String, path: String) -> Result<(), String> {
    let dir = item_path(&app, &user, &path)?;
    if is_document(&dir) {
        return Err(format!("{path:?} is a document"));
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())
}

/// Built-ins first, then user templates. A user template with a built-in's name replaces it.
#[tauri::command]
fn list_templates(app: tauri::AppHandle, user: String) -> Result<Vec<TemplateInfo>, String> {
    let mut out: Vec<TemplateInfo> = fs::read_dir(templates_dir(&app, &user)?)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let file = e.file_name().to_string_lossy().to_string();
            let path = file.strip_suffix(".tex")?.to_string();
            let meta = read_meta(&e.path().with_extension("sync.json"));
            let snippet = snippet(&fs::read_to_string(e.path()).unwrap_or_default());
            Some(TemplateInfo { path, dirty: meta.dirty, remote_at: meta.remote_at, builtin: false, snippet })
        })
        .collect();
    for (name, body) in BUILTIN_TEMPLATES {
        if !out.iter().any(|d| d.path == name) {
            out.push(TemplateInfo {
                path: name.into(),
                dirty: false,
                remote_at: None,
                builtin: true,
                snippet: snippet(body),
            });
        }
    }
    out.sort_by_key(|d| (!d.builtin, d.path.to_lowercase()));
    Ok(out)
}

#[tauri::command]
fn read_template(app: tauri::AppHandle, user: String, name: String) -> Result<String, String> {
    let (path, _) = template_paths(&app, &user, &name)?;
    match fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(_) => builtin(&name).map(str::to_string).ok_or_else(|| format!("no template {name:?}")),
    }
}

/// Creates a document from a template. Fails if anything already exists at that path.
/// The new document starts dirty so the next sync pushes it.
#[tauri::command]
fn create_document(
    app: tauri::AppHandle,
    user: String,
    path: String,
    template: String,
) -> Result<String, String> {
    if item_path(&app, &user, &path)?.exists() {
        return Err(format!("{path:?} already exists"));
    }
    let body = read_template(app.clone(), user.clone(), template)?;
    let dir = ensure_doc_dir(&app, &user, &path)?;
    write_atomic(dir.join("main.tex"), &body).map_err(|e| e.to_string())?;
    write_meta(&dir.join(".sync.json"), &Meta { dirty: true, ..Default::default() })?;
    Ok(body)
}

#[tauri::command]
fn save_template(
    app: tauri::AppHandle,
    user: String,
    name: String,
    source: String,
    overwrite: bool,
) -> Result<(), String> {
    let (path, meta_path) = template_paths(&app, &user, &name)?;
    if (path.exists() || builtin(&name).is_some()) && !overwrite {
        return Err("exists".into());
    }
    write_atomic(path, source).map_err(|e| e.to_string())?;
    update_meta(&meta_path, |m| m.dirty = true)
}

#[tauri::command]
fn load_source(app: tauri::AppHandle, user: String, path: String) -> Result<String, String> {
    fs::read_to_string(item_path(&app, &user, &path)?.join("main.tex")).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_source(
    app: tauri::AppHandle,
    user: String,
    path: String,
    source: String,
) -> Result<(), String> {
    let dir = ensure_doc_dir(&app, &user, &path)?;
    write_atomic(dir.join("main.tex"), source).map_err(|e| e.to_string())?;
    update_meta(&dir.join(".sync.json"), |m| m.dirty = true)
}

/// Writes a document received from the server. `dirty` is true only for conflict copies,
/// which exist solely locally and must be pushed.
#[tauri::command]
fn apply_remote(
    app: tauri::AppHandle,
    user: String,
    kind: String,
    path: String,
    source: String,
    remote_at: Option<String>,
    dirty: bool,
) -> Result<(), String> {
    let set = move |m: &mut Meta| {
        m.dirty = dirty;
        m.remote_at = remote_at;
    };
    match kind.as_str() {
        "document" => {
            let dir = ensure_doc_dir(&app, &user, &path)?;
            write_atomic(dir.join("main.tex"), source).map_err(|e| e.to_string())?;
            update_meta(&dir.join(".sync.json"), set)
        }
        "folder" => {
            let dir = item_path(&app, &user, &path)?;
            if is_document(&dir) {
                return Err(format!("{path:?} is a document"));
            }
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            update_meta(&dir.join(".sync.json"), set)
        }
        "template" => {
            let (file, meta_path) = template_paths(&app, &user, &path)?;
            write_atomic(file, source).map_err(|e| e.to_string())?;
            update_meta(&meta_path, set)
        }
        _ => Err(format!("unknown kind {kind:?}")),
    }
}

/// Records a successful push of `pushed`. The doc stays dirty if it changed while the push ran.
#[tauri::command]
fn mark_synced(
    app: tauri::AppHandle,
    user: String,
    kind: String,
    path: String,
    pushed: String,
    remote_at: String,
) -> Result<(), String> {
    let (file, meta_path) = match kind.as_str() {
        "document" => {
            let dir = ensure_doc_dir(&app, &user, &path)?;
            (dir.join("main.tex"), dir.join(".sync.json"))
        }
        "folder" => {
            let dir = item_path(&app, &user, &path)?;
            return update_meta(&dir.join(".sync.json"), |m| {
                m.dirty = false;
                m.remote_at = Some(remote_at);
            });
        }
        "template" => template_paths(&app, &user, &path)?,
        _ => return Err(format!("unknown kind {kind:?}")),
    };
    let unchanged = fs::read_to_string(file).map(|cur| cur == pushed).unwrap_or(false);
    update_meta(&meta_path, |m| {
        m.dirty = !unchanged;
        m.remote_at = Some(remote_at);
    })
}

#[tauri::command]
fn list_images(app: tauri::AppHandle, user: String, path: String) -> Result<Vec<String>, String> {
    let dir = item_path(&app, &user, &path)?.join("images");
    let Ok(entries) = fs::read_dir(dir) else { return Ok(vec![]) };
    Ok(entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| !n.starts_with('.'))
        .collect())
}

#[tauri::command]
fn read_image(
    app: tauri::AppHandle,
    user: String,
    path: String,
    name: String,
) -> Result<Response, String> {
    plain_file_name(&name)?;
    let bytes = fs::read(item_path(&app, &user, &path)?.join("images").join(name))
        .map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

fn plain_file_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
        return Err("invalid image name".into());
    }
    Ok(())
}

fn header(request: &Request<'_>, key: &str) -> Result<String, String> {
    request
        .headers()
        .get(key)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .ok_or_else(|| format!("missing {key} header"))
}

/// Raw request body is the image bytes; headers x-user, x-path, x-name say where it goes.
/// x-path is percent-encoded because document paths contain '/' and spaces.
/// Returns the path relative to the document, for use in \includegraphics.
#[tauri::command]
fn save_image(app: tauri::AppHandle, request: Request<'_>) -> Result<String, String> {
    let (user, path, name) =
        (header(&request, "x-user")?, header(&request, "x-path")?, header(&request, "x-name")?);
    plain_file_name(&name)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw body".into());
    };
    write_atomic(ensure_doc_dir(&app, &user, &decode(&path))?.join("images").join(&name), bytes)
        .map_err(|e| e.to_string())?;
    Ok(format!("images/{name}"))
}

/// The document dir for a preview. Previews never create documents.
fn preview_dir(app: &tauri::AppHandle, user: &str, path: &str) -> Result<PathBuf, String> {
    let dir = item_path(app, user, path)?;
    if is_document(&dir) { Ok(dir) } else { Err(format!("no document {path:?}")) }
}

/// Raw body is a PNG of the first page, freshly rendered here; it must be uploaded on the next sync.
#[tauri::command]
fn save_preview(app: tauri::AppHandle, request: Request<'_>) -> Result<(), String> {
    let (user, path) = (header(&request, "x-user")?, header(&request, "x-path")?);
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw body".into());
    };
    let dir = preview_dir(&app, &user, &decode(&path))?;
    write_atomic(dir.join("preview.png"), bytes).map_err(|e| e.to_string())?;
    update_meta(&dir.join(".sync.json"), |m| m.preview_dirty = true)
}

/// Same body as `save_preview`, but for a preview downloaded from the server (x-preview-at is its marker).
#[tauri::command]
fn apply_preview(app: tauri::AppHandle, request: Request<'_>) -> Result<(), String> {
    let (user, path, at) =
        (header(&request, "x-user")?, header(&request, "x-path")?, header(&request, "x-preview-at")?);
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw body".into());
    };
    let dir = preview_dir(&app, &user, &decode(&path))?;
    write_atomic(dir.join("preview.png"), bytes).map_err(|e| e.to_string())?;
    update_meta(&dir.join(".sync.json"), |m| {
        m.preview_at = Some(at);
        m.preview_dirty = false;
    })
}

/// Records that the local preview was uploaded under marker `preview_at`.
#[tauri::command]
fn mark_preview(app: tauri::AppHandle, user: String, path: String, preview_at: String) -> Result<(), String> {
    let dir = preview_dir(&app, &user, &path)?;
    update_meta(&dir.join(".sync.json"), |m| {
        m.preview_at = Some(preview_at);
        m.preview_dirty = false;
    })
}

#[tauri::command]
fn read_preview(app: tauri::AppHandle, user: String, path: String) -> Result<Response, String> {
    let bytes = fs::read(item_path(&app, &user, &path)?.join("preview.png")).map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

/// Minimal percent-decoder for header values (headers can't carry arbitrary text).
fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
fn list_deletions(app: tauri::AppHandle, user: String) -> Result<Vec<Tombstone>, String> {
    read_tombstones(&app, &user)
}

#[tauri::command]
fn clear_deletion(app: tauri::AppHandle, user: String, kind: String, path: String) -> Result<(), String> {
    let mut t = read_tombstones(&app, &user)?;
    t.retain(|x| !(x.kind == kind && x.path == path));
    write_tombstones(&app, &user, &t)
}

fn add_tombstones(app: &tauri::AppHandle, user: &str, new: Vec<Tombstone>) -> Result<(), String> {
    let mut t = read_tombstones(app, user)?;
    t.retain(|x| !new.iter().any(|n| n.kind == x.kind && n.path == x.path));
    t.extend(new);
    write_tombstones(app, user, &t)
}

fn tombstones_for(items: &[(&'static str, String, Meta)]) -> Vec<Tombstone> {
    items
        .iter()
        .filter_map(|(k, p, m)| {
            m.remote_at.clone().map(|r| Tombstone { kind: (*k).into(), path: p.clone(), remote_at: r })
        })
        .collect()
}

/// Deletes a document, or a folder with everything in it. Anything the server knows about is
/// recorded first, so the deletion survives a crash and reaches other devices on the next sync.
#[tauri::command]
fn delete_item(app: tauri::AppHandle, user: String, path: String) -> Result<(), String> {
    let dir = item_path(&app, &user, &path)?;
    if !dir.is_dir() {
        return Err(format!("{path:?} not found"));
    }
    add_tombstones(&app, &user, tombstones_for(&collect_items(&dir, &path)))?;
    fs::remove_dir_all(dir).map_err(|e| e.to_string())
}

/// Renames or moves a document or folder (they are the same operation: change the path).
/// The server has no rename, so old paths are deleted and the new ones start as unsynced documents.
#[tauri::command]
fn move_item(app: tauri::AppHandle, user: String, from: String, to: String) -> Result<(), String> {
    if to == from || to.starts_with(&format!("{from}/")) {
        return Err("cannot move something into itself".into());
    }
    let from_dir = item_path(&app, &user, &from)?;
    let to_dir = item_path(&app, &user, &to)?;
    if !from_dir.is_dir() {
        return Err(format!("{from:?} not found"));
    }
    if to_dir.exists() {
        return Err(format!("{to:?} already exists"));
    }
    let items = collect_items(&from_dir, &from);
    add_tombstones(&app, &user, tombstones_for(&items))?;
    if let Some(parent) = to_dir.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&from_dir, &to_dir).map_err(|e| e.to_string())?;
    for (kind, old, _) in &items {
        let dir = item_path(&app, &user, &format!("{to}{}", &old[from.len()..]))?;
        let had_preview = *kind == "document" && dir.join("preview.png").is_file();
        write_meta(
            &dir.join(".sync.json"),
            &Meta { dirty: true, preview_dirty: had_preview, ..Default::default() },
        )?;
    }
    Ok(())
}

/// Deletes a user template (a built-in of the same name, if any, shows through again).
#[tauri::command]
fn delete_template(app: tauri::AppHandle, user: String, name: String) -> Result<(), String> {
    let (file, meta_path) = template_paths(&app, &user, &name)?;
    if !file.is_file() {
        return Err(format!("{name:?} is a built-in template and cannot be deleted"));
    }
    if let Some(remote_at) = read_meta(&meta_path).remote_at {
        add_tombstones(&app, &user, vec![Tombstone { kind: "template".into(), path: name, remote_at }])?;
    }
    fs::remove_file(file).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(meta_path);
    Ok(())
}

/// Removes a local copy of something deleted on the server. Folders are only removed when empty.
#[tauri::command]
fn remove_local(app: tauri::AppHandle, user: String, kind: String, path: String) -> Result<(), String> {
    if kind == "template" {
        let (file, meta_path) = template_paths(&app, &user, &path)?;
        let _ = fs::remove_file(file);
        let _ = fs::remove_file(meta_path);
        return Ok(());
    }
    let dir = item_path(&app, &user, &path)?;
    match kind.as_str() {
        "document" if is_document(&dir) => fs::remove_dir_all(dir).map_err(|e| e.to_string()),
        "folder" if dir.is_dir() && !is_document(&dir) => {
            let empty = fs::read_dir(&dir)
                .map_err(|e| e.to_string())?
                .flatten()
                .all(|e| e.file_name() == ".sync.json");
            if empty { fs::remove_dir_all(dir).map_err(|e| e.to_string()) } else { Ok(()) }
        }
        _ => Ok(()),
    }
}

/// Compile `source` and return the PDF bytes. Prefers tectonic, falls back to pdflatex.
fn build_pdf(
    app: &tauri::AppHandle,
    user: &str,
    path: &str,
    source: &str,
    scratch: bool,
) -> Result<Vec<u8>, String> {
    // Templates have no folder of their own, so they compile in a throwaway directory.
    let dir = if scratch {
        let d = user_dir(app, user)?.join(".scratch");
        fs::create_dir_all(&d).map_err(|e| e.to_string())?;
        d
    } else {
        ensure_doc_dir(app, user, path)?
    };
    write_atomic(dir.join("main.tex"), source)?;

    let out = run_engine(&dir)?;
    if !out.status.success() {
        let log = String::from_utf8_lossy(&out.stdout).to_string()
            + &String::from_utf8_lossy(&out.stderr);
        return Err(log);
    }
    fs::read(dir.join("main.pdf")).map_err(|e| e.to_string())
}

#[tauri::command]
fn compile(
    app: tauri::AppHandle,
    user: String,
    path: String,
    source: String,
    scratch: bool,
) -> Result<Response, String> {
    build_pdf(&app, &user, &path, &source, scratch).map(Response::new)
}

/// Compiles and writes the PDF to `dest`, a location the user picked. This is the only way a PDF leaves the app.
#[tauri::command]
fn export_pdf(
    app: tauri::AppHandle,
    user: String,
    path: String,
    source: String,
    scratch: bool,
    dest: String,
) -> Result<(), String> {
    let pdf = build_pdf(&app, &user, &path, &source, scratch)?;
    write_atomic(dest, pdf)
}

fn run_engine(dir: &PathBuf) -> Result<std::process::Output, String> {
    let attempts: [(&str, &[&str]); 2] = [
        ("tectonic", &["-X", "compile", "--keep-logs", "main.tex"]),
        (
            "pdflatex",
            &["-interaction=nonstopmode", "-halt-on-error", "main.tex"],
        ),
    ];
    for (bin, args) in attempts {
        match Command::new(bin).args(args).current_dir(dir).output() {
            Ok(out) => return Ok(out),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("{bin}: {e}")),
        }
    }
    Err("No LaTeX engine found. Install tectonic (preferred) or a TeX Live with pdflatex.".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_documents,
            list_folders,
            create_folder,
            list_templates,
            read_template,
            create_document,
            save_template,
            load_source,
            save_source,
            apply_remote,
            mark_synced,
            list_images,
            read_image,
            save_image,
            save_preview,
            apply_preview,
            mark_preview,
            read_preview,
            list_deletions,
            clear_deletion,
            delete_item,
            delete_template,
            move_item,
            remove_local,
            compile,
            export_pdf
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
