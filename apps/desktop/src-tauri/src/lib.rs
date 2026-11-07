mod latex;

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::Manager;

const TEMPLATE_BLANK: &str = r"\documentclass{article}
\begin{document}

\end{document}
";

/// Built-ins are embedded, never written to disk and never synced.
const BUILTIN_TEMPLATES: [(&str, &str); 1] = [("Blank", TEMPLATE_BLANK)];

/// Per-document sync state, stored beside the document.
/// `remote_at` is the server `updated_at` this copy was last in step with.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
struct Meta {
    dirty: bool,
    remote_at: Option<String>,
    /// Stable server identity. Unlike the path it survives renames; missing on items from before ids existed.
    id: Option<String>,
    /// The path the server had when this copy last matched it. A different current path means a local rename
    /// that is still to be pushed.
    remote_path: Option<String>,
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
    /// Absent on deletions recorded before ids existed; those are found on the server by path.
    #[serde(default)]
    id: Option<String>,
    remote_at: String,
}

#[derive(Serialize)]
struct DocInfo {
    path: String,
    dirty: bool,
    remote_at: Option<String>,
    id: Option<String>,
    remote_path: Option<String>,
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
    id: Option<String>,
    remote_path: Option<String>,
}

#[derive(Serialize)]
struct TemplateInfo {
    path: String,
    dirty: bool,
    remote_at: Option<String>,
    id: Option<String>,
    remote_path: Option<String>,
    builtin: bool,
    /// A rendered thumbnail of the template's first page exists on this device.
    has_preview: bool,
    /// Marker of the synced thumbnail this one matches, and whether a freshly rendered one awaits upload.
    preview_at: Option<String>,
    preview_dirty: bool,
}

/// Names become folder/file names, so only allow a plain, visible name.
fn valid_name(name: &str) -> Result<&str, String> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name == name.trim()
        && !name.starts_with('.')
        && !name.ends_with('.')
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '(' | ')' | '.'));
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
                id: meta.id,
                remote_path: meta.remote_path,
                preview_at: meta.preview_at,
                preview_dirty: meta.preview_dirty,
            });
        } else {
            let meta = read_meta(&p.join(".sync.json"));
            folders.push(FolderInfo {
                path: path.clone(),
                dirty: meta.dirty,
                remote_at: meta.remote_at,
                id: meta.id,
                remote_path: meta.remote_path,
            });
            walk(&p, &path, docs, folders);
        }
    }
}

// ---- synced config files (currently just the snippets file) ----

/// Only these can be read or written, so a name from the frontend never becomes an arbitrary path.
const CONFIG_NAMES: [&str; 1] = ["snippets"];

/// `<user_dir>/.config/<name>.toml` plus its sync state beside it.
fn config_paths(app: &tauri::AppHandle, user: &str, name: &str) -> Result<(PathBuf, PathBuf), String> {
    if !CONFIG_NAMES.contains(&name) {
        return Err(format!("unknown config {name:?}"));
    }
    let dir = user_dir(app, user)?.join(".config");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok((dir.join(format!("{name}.toml")), dir.join(format!("{name}.sync.json"))))
}

#[derive(Serialize)]
struct ConfigInfo {
    path: String,
    dirty: bool,
    remote_at: Option<String>,
}

#[tauri::command]
fn list_configs(app: tauri::AppHandle, user: String) -> Result<Vec<ConfigInfo>, String> {
    let mut out = vec![];
    for name in CONFIG_NAMES {
        let (file, meta_path) = config_paths(&app, &user, name)?;
        if file.is_file() {
            let meta = read_meta(&meta_path);
            out.push(ConfigInfo { path: name.into(), dirty: meta.dirty, remote_at: meta.remote_at });
        }
    }
    Ok(out)
}

/// None if the file has never been created on this device.
#[tauri::command]
fn load_config(app: tauri::AppHandle, user: String, name: String) -> Result<Option<String>, String> {
    let (file, _) = config_paths(&app, &user, &name)?;
    match fs::read_to_string(file) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn save_config(app: tauri::AppHandle, user: String, name: String, source: String) -> Result<(), String> {
    let (file, meta_path) = config_paths(&app, &user, &name)?;
    write_atomic(file, source)?;
    update_meta(&meta_path, |m| m.dirty = true)
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

/// Thumbnails are derived from the template text, so they are local only and never synced.
fn template_preview_path(app: &tauri::AppHandle, user: &str, name: &str) -> Result<PathBuf, String> {
    Ok(templates_dir(app, user)?.join(format!("{}.preview.png", valid_name(name)?)))
}

/// The template changed (or went away): its old thumbnail is wrong.
/// The marker is kept on purpose: it says "the server's image is the one I already have (and now know is stale)",
/// so sync does not download it again; a freshly rendered thumbnail then replaces it.
fn drop_template_preview(app: &tauri::AppHandle, user: &str, name: &str) {
    if let Ok(p) = template_preview_path(app, user, name) {
        let _ = fs::remove_file(p);
    }
    if let Ok((_, meta_path)) = template_paths(app, user, name) {
        if meta_path.exists() {
            let _ = update_meta(&meta_path, |m| m.preview_dirty = false);
        }
    }
}

/// Raw body is a PNG of the template's first page; headers x-user and x-name (percent-encoded).
#[tauri::command]
fn save_template_preview(app: tauri::AppHandle, request: Request<'_>) -> Result<(), String> {
    let (user, name) = (header(&request, "x-user")?, decode(&header(&request, "x-name")?));
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw body".into());
    };
    let (file, _) = template_paths(&app, &user, &name)?;
    if !file.is_file() && builtin(&name).is_none() {
        return Err(format!("no template {name:?}"));
    }
    let preview = template_preview_path(&app, &user, &name)?;
    if fs::read(&preview).map(|old| old == *bytes).unwrap_or(false) {
        return Ok(());
    }
    write_atomic(preview, bytes)?;
    // Only a template the user owns has a server row to attach the thumbnail to; built-ins stay local.
    if file.is_file() {
        let (_, meta_path) = template_paths(&app, &user, &name)?;
        update_meta(&meta_path, |m| m.preview_dirty = true)?;
    }
    Ok(())
}

/// A thumbnail downloaded from the server (header x-preview-at is its marker).
#[tauri::command]
fn apply_template_preview(app: tauri::AppHandle, request: Request<'_>) -> Result<(), String> {
    let (user, name, at) = (
        header(&request, "x-user")?,
        decode(&header(&request, "x-name")?),
        header(&request, "x-preview-at")?,
    );
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw body".into());
    };
    let (file, meta_path) = template_paths(&app, &user, &name)?;
    if !file.is_file() {
        return Err(format!("no template {name:?}"));
    }
    write_atomic(template_preview_path(&app, &user, &name)?, bytes)?;
    update_meta(&meta_path, |m| {
        m.preview_at = Some(at);
        m.preview_dirty = false;
    })
}

/// Records that the local thumbnail was uploaded under marker `preview_at`.
#[tauri::command]
fn mark_template_preview(app: tauri::AppHandle, user: String, name: String, preview_at: String) -> Result<(), String> {
    let (_, meta_path) = template_paths(&app, &user, &name)?;
    update_meta(&meta_path, |m| {
        m.preview_at = Some(preview_at);
        m.preview_dirty = false;
    })
}

#[tauri::command]
fn read_template_preview(app: tauri::AppHandle, user: String, name: String) -> Result<Response, String> {
    let bytes = fs::read(template_preview_path(&app, &user, &name)?).map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

/// Compiles a stored template in its own scratch folder (so it never collides with the editor's) and returns the PDF.
#[tauri::command(async)]
fn compile_template_preview(app: tauri::AppHandle, user: String, name: String) -> Result<Response, String> {
    let source = read_template(app.clone(), user.clone(), name)?;
    build_pdf(&app, &user, "", &source, Some(".scratch-thumbs")).map(Response::new)
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
            let has_preview = e.path().with_file_name(format!("{path}.preview.png")).is_file();
            Some(TemplateInfo {
                path,
                dirty: meta.dirty,
                remote_at: meta.remote_at,
                id: meta.id,
                remote_path: meta.remote_path,
                builtin: false,
                has_preview,
                preview_at: meta.preview_at,
                preview_dirty: meta.preview_dirty,
            })
        })
        .collect();
    let dir = templates_dir(&app, &user)?;
    for (name, _) in BUILTIN_TEMPLATES {
        if !out.iter().any(|d| d.path == name) {
            out.push(TemplateInfo {
                path: name.into(),
                dirty: false,
                remote_at: None,
                id: None,
                remote_path: None,
                builtin: true,
                has_preview: dir.join(format!("{name}.preview.png")).is_file(),
                preview_at: None,
                preview_dirty: false,
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

/// "<base> copy", "<base> copy 2", ... : the first one `taken` does not claim, kept within the name length limit.
fn copy_name(base: &str, taken: impl Fn(&str) -> bool) -> String {
    for n in 1.. {
        let suffix = if n == 1 { " copy".to_string() } else { format!(" copy {n}") };
        let keep: String = base.chars().take(64usize.saturating_sub(suffix.chars().count())).collect();
        let name = format!("{}{}", keep.trim_end(), suffix);
        if !taken(&name) {
            return name;
        }
    }
    unreachable!()
}

/// Duplicates a document (text and images) next to the original. The copy is a new, unsynced document.
/// Returns its path.
#[tauri::command]
fn duplicate_document(app: tauri::AppHandle, user: String, path: String) -> Result<String, String> {
    let from = item_path(&app, &user, &path)?;
    if !is_document(&from) {
        return Err(format!("{path:?} is not a document"));
    }
    let parent = parent_path(&path);
    let join = |name: &str| if parent.is_empty() { name.to_string() } else { format!("{parent}/{name}") };
    let name = copy_name(path.rsplit('/').next().unwrap_or(&path), |n| {
        item_path(&app, &user, &join(n)).map(|p| p.exists()).unwrap_or(true)
    });
    let new_path = join(&name);
    let to = ensure_doc_dir(&app, &user, &new_path)?;
    fs::copy(from.join("main.tex"), to.join("main.tex")).map_err(|e| e.to_string())?;
    if let Ok(images) = fs::read_dir(from.join("images")) {
        for e in images.flatten() {
            if e.path().is_file() && !e.file_name().to_string_lossy().starts_with('.') {
                fs::copy(e.path(), to.join("images").join(e.file_name())).map_err(|e| e.to_string())?;
            }
        }
    }
    write_meta(&to.join(".sync.json"), &Meta { dirty: true, ..Default::default() })?;
    Ok(new_path)
}

fn parent_path(path: &str) -> &str {
    path.rsplit_once('/').map(|(p, _)| p).unwrap_or("")
}

/// Duplicates a template, built-in or not, as a new unsynced template. Returns its name.
#[tauri::command]
fn duplicate_template(app: tauri::AppHandle, user: String, name: String) -> Result<String, String> {
    let source = read_template(app.clone(), user.clone(), name.clone())?;
    let new = copy_name(&name, |n| {
        template_paths(&app, &user, n).map(|(f, _)| f.exists() || builtin(n).is_some()).unwrap_or(true)
    });
    let (file, meta) = template_paths(&app, &user, &new)?;
    write_atomic(file, source).map_err(|e| e.to_string())?;
    write_meta(&meta, &Meta { dirty: true, ..Default::default() })?;
    Ok(new)
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
    drop_template_preview(&app, &user, &name);
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
    id: Option<String>,
    remote_path: Option<String>,
) -> Result<(), String> {
    let set = move |m: &mut Meta| {
        m.dirty = dirty;
        m.remote_at = remote_at;
        m.id = id;
        m.remote_path = remote_path;
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
            drop_template_preview(&app, &user, &path);
            update_meta(&meta_path, set)
        }
        "config" => {
            let (file, meta_path) = config_paths(&app, &user, &path)?;
            write_atomic(file, source)?;
            update_meta(&meta_path, set)
        }
        _ => Err(format!("unknown kind {kind:?}")),
    }
}

/// Records a successful push of `pushed`. The doc stays dirty if it changed while the push ran.
/// Returns false if the item was deleted while the push was in flight (nothing is recreated for it).
#[tauri::command]
fn mark_synced(
    app: tauri::AppHandle,
    user: String,
    kind: String,
    path: String,
    pushed: String,
    remote_at: String,
    id: String,
) -> Result<bool, String> {
    let (file, meta_path) = match kind.as_str() {
        "document" => {
            let dir = item_path(&app, &user, &path)?;
            if !is_document(&dir) {
                return Ok(false);
            }
            (dir.join("main.tex"), dir.join(".sync.json"))
        }
        "folder" => {
            let dir = item_path(&app, &user, &path)?;
            if !dir.is_dir() {
                return Ok(false);
            }
            update_meta(&dir.join(".sync.json"), |m| {
                m.dirty = false;
                m.remote_at = Some(remote_at);
                m.id = Some(id);
                m.remote_path = Some(path);
            })?;
            return Ok(true);
        }
        "template" => {
            let paths = template_paths(&app, &user, &path)?;
            if !paths.0.is_file() {
                return Ok(false);
            }
            paths
        }
        "config" => config_paths(&app, &user, &path)?,
        _ => return Err(format!("unknown kind {kind:?}")),
    };
    let unchanged = fs::read_to_string(file).map(|cur| cur == pushed).unwrap_or(false);
    update_meta(&meta_path, |m| {
        m.dirty = !unchanged;
        m.remote_at = Some(remote_at);
        m.id = Some(id);
        m.remote_path = Some(path);
    })?;
    Ok(true)
}

/// Remembers an item's server identity before it is first pushed, so a push that is interrupted
/// halfway is recognised (not duplicated) on the next pass.
#[tauri::command]
fn set_item_id(app: tauri::AppHandle, user: String, kind: String, path: String, id: String) -> Result<(), String> {
    let meta_path = match kind.as_str() {
        "document" => item_path(&app, &user, &path)?.join(".sync.json"),
        "folder" => item_path(&app, &user, &path)?.join(".sync.json"),
        "template" => template_paths(&app, &user, &path)?.1,
        _ => return Err(format!("{kind:?} has no ids")),
    };
    update_meta(&meta_path, |m| m.id = Some(id))
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
    let file = dir.join("preview.png");
    // Compiling on open re-renders unchanged documents; an identical image needs no write and no upload.
    if fs::read(&file).map(|old| old == *bytes).unwrap_or(false) {
        return Ok(());
    }
    write_atomic(file, bytes).map_err(|e| e.to_string())?;
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
fn clear_deletion(
    app: tauri::AppHandle,
    user: String,
    kind: String,
    path: String,
    id: Option<String>,
) -> Result<(), String> {
    let mut t = read_tombstones(&app, &user)?;
    t.retain(|x| !same_item(x, &kind, &path, id.as_deref()));
    write_tombstones(&app, &user, &t)
}

/// Same thing on the server: by id when both sides have one, otherwise by path.
fn same_item(t: &Tombstone, kind: &str, path: &str, id: Option<&str>) -> bool {
    t.kind == kind
        && match (t.id.as_deref(), id) {
            (Some(a), Some(b)) => a == b,
            _ => t.path == path,
        }
}

fn add_tombstones(app: &tauri::AppHandle, user: &str, new: Vec<Tombstone>) -> Result<(), String> {
    let mut t = read_tombstones(app, user)?;
    t.retain(|x| !new.iter().any(|n| same_item(x, &n.kind, &n.path, n.id.as_deref())));
    t.extend(new);
    write_tombstones(app, user, &t)
}

fn tombstones_for(items: &[(&'static str, String, Meta)]) -> Vec<Tombstone> {
    items
        .iter()
        .filter_map(|(k, p, m)| {
            m.remote_at.clone().map(|r| Tombstone { kind: (*k).into(), path: p.clone(), id: m.id.clone(), remote_at: r })
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

/// Before an item's path changes, remember the path the server knows it by, so the next sync can tell a local
/// rename from a remote one. Items the server has not seen need nothing.
fn stamp_remote_paths(items: &[(&'static str, String, Meta)], app: &tauri::AppHandle, user: &str) -> Result<(), String> {
    for (_, path, meta) in items {
        if meta.remote_at.is_some() && meta.remote_path.is_none() {
            let dir = item_path(app, user, path)?;
            update_meta(&dir.join(".sync.json"), |m| m.remote_path = Some(path.clone()))?;
        }
    }
    Ok(())
}

/// Renames or moves a document or folder (they are the same operation: change the path). Identity, sync state,
/// images and preview travel with the directory; the next sync pushes the new path (and the new paths of
/// everything inside a folder) as renames, not as delete + create.
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
    stamp_remote_paths(&collect_items(&from_dir, &from), &app, &user)?;
    if let Some(parent) = to_dir.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&from_dir, &to_dir).map_err(|e| e.to_string())
}

/// Moves `from` to `to`, merging into `to` when it already exists as a plain folder. Used when another device's
/// rename is applied here: a folder's children may already have been created under the new name.
fn merge_move(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    if !to.exists() {
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        return fs::rename(from, to).map_err(|e| e.to_string());
    }
    if !from.is_dir() || !to.is_dir() || is_document(from) || is_document(to) {
        return Err(format!("{:?} already exists", to.file_name().unwrap_or_default()));
    }
    for entry in fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        merge_move(&entry.path(), &to.join(entry.file_name()))?;
    }
    fs::remove_dir(from).map_err(|e| e.to_string())
}

/// Applies a rename made on another device. Unlike `move_item` it tolerates the target folder existing already.
#[tauri::command]
fn rename_local(app: tauri::AppHandle, user: String, kind: String, from: String, to: String) -> Result<(), String> {
    if kind == "template" {
        return rename_template_files(&app, &user, &from, &to);
    }
    if to == from || to.starts_with(&format!("{from}/")) {
        return Err("cannot move something into itself".into());
    }
    let from_dir = item_path(&app, &user, &from)?;
    let to_dir = item_path(&app, &user, &to)?;
    if !from_dir.exists() && to_dir.exists() {
        return Ok(()); // already moved along with a parent folder
    }
    if !from_dir.is_dir() {
        return Err(format!("{from:?} not found"));
    }
    merge_move(&from_dir, &to_dir)
}

/// Moves a template's text, sync state and thumbnail to a new name.
fn rename_template_files(app: &tauri::AppHandle, user: &str, from: &str, to: &str) -> Result<(), String> {
    let (from_file, from_meta) = template_paths(app, user, from)?;
    let (to_file, to_meta) = template_paths(app, user, to)?;
    if !from_file.is_file() {
        return Err(format!("{from:?} is a built-in template and cannot be renamed"));
    }
    if to_file.exists() || builtin(to).is_some() {
        return Err(format!("A template named {to:?} already exists"));
    }
    let mut meta = read_meta(&from_meta);
    if meta.remote_at.is_some() && meta.remote_path.is_none() {
        meta.remote_path = Some(from.to_string());
    }
    let (from_png, to_png) = (template_preview_path(app, user, from)?, template_preview_path(app, user, to)?);
    write_meta(&to_meta, &meta)?;
    fs::rename(&from_file, &to_file).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(from_meta);
    if from_png.is_file() {
        let _ = fs::rename(from_png, to_png);
    }
    Ok(())
}

#[tauri::command]
fn rename_template(app: tauri::AppHandle, user: String, from: String, to: String) -> Result<(), String> {
    rename_template_files(&app, &user, &from, &to)
}

/// Deletes a user template (a built-in of the same name, if any, shows through again).
#[tauri::command]
fn delete_template(app: tauri::AppHandle, user: String, name: String) -> Result<(), String> {
    let (file, meta_path) = template_paths(&app, &user, &name)?;
    if !file.is_file() {
        return Err(format!("{name:?} is a built-in template and cannot be deleted"));
    }
    if let Some(remote_at) = read_meta(&meta_path).remote_at {
        let id = read_meta(&meta_path).id;
        add_tombstones(&app, &user, vec![Tombstone { kind: "template".into(), path: name.clone(), id, remote_at }])?;
    }
    fs::remove_file(file).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(meta_path);
    drop_template_preview(&app, &user, &name);
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

// ---- OCR (handwriting photo -> LaTeX) via the user's own Anthropic API key ----

/// Models offered in Settings. Anything else is rejected, so the key can't be pointed at an arbitrary model.
const OCR_MODELS: [&str; 3] = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];

const OCR_PROMPT: &str = "Transcribe this handwritten work into LaTeX. Output only the LaTeX body (no preamble, no code fences), \
using align* for multi-line math. Mark illegible parts with a %UNSURE comment.";

/// Per-account, device-local. Never synced and never sent anywhere except api.anthropic.com.
fn key_file(app: &tauri::AppHandle, user: &str) -> Result<PathBuf, String> {
    Ok(user_dir(app, user)?.join(".api_key"))
}

/// Like `write_atomic`, but the file is owner-only from the moment it exists.
fn write_secret(path: &std::path::Path, data: &str) -> Result<(), String> {
    use std::io::Write;
    let tmp = path.with_file_name(".api_key.tmp");
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp).map_err(|e| e.to_string())?;
    f.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn read_key(app: &tauri::AppHandle, user: &str) -> Result<String, String> {
    fs::read_to_string(key_file(app, user)?)
        .map(|k| k.trim().to_string())
        .ok()
        .filter(|k| !k.is_empty())
        .ok_or_else(|| "No API key set. Add one in Settings → OCR.".to_string())
}

/// Saves the key, or removes it when `key` is empty. The key is never returned to the frontend.
#[tauri::command]
fn set_api_key(app: tauri::AppHandle, user: String, key: String) -> Result<(), String> {
    let path = key_file(&app, &user)?;
    let key = key.trim();
    if key.is_empty() {
        let _ = fs::remove_file(path);
        return Ok(());
    }
    if key.len() > 300 || !key.is_ascii() || key.contains(char::is_whitespace) {
        return Err("That doesn't look like an API key.".into());
    }
    write_secret(&path, key)
}

#[tauri::command]
fn has_api_key(app: tauri::AppHandle, user: String) -> Result<bool, String> {
    Ok(key_file(&app, &user)?.is_file())
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())
}

/// Pulls Anthropic's error message out of a failed response.
async fn api_error(resp: reqwest::Response) -> String {
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    let msg = body["error"]["message"].as_str().unwrap_or("request failed");
    match status.as_u16() {
        401 => "The API key was rejected (401). Check it in Settings → OCR.".into(),
        429 => format!("Rate limited or out of credit (429): {msg}"),
        _ => format!("Anthropic API error ({status}): {msg}"),
    }
}

/// Checks the key with a free call (list models), so no tokens are spent.
#[tauri::command]
async fn test_api_key(app: tauri::AppHandle, user: String) -> Result<(), String> {
    let key = read_key(&app, &user)?;
    let resp = http()?
        .get("https://api.anthropic.com/v1/models?limit=1")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|e| format!("Could not reach Anthropic: {e}"))?;
    if resp.status().is_success() { Ok(()) } else { Err(api_error(resp).await) }
}

#[derive(Serialize)]
struct OcrResult {
    latex: String,
    input_tokens: u64,
    output_tokens: u64,
    stop_reason: String,
}

/// Raw body is a JPEG; headers x-user and x-model say whose key and which model.
#[tauri::command]
async fn ocr_image(app: tauri::AppHandle, request: Request<'_>) -> Result<OcrResult, String> {
    use base64::Engine;
    // Copy everything out of the request first, so nothing borrowed is held across an await.
    let (user, model) = (header(&request, "x-user")?, header(&request, "x-model")?);
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw body".into());
    };
    let image = base64::engine::general_purpose::STANDARD.encode(bytes);
    if !OCR_MODELS.contains(&model.as_str()) {
        return Err(format!("unknown model {model:?}"));
    }
    let key = read_key(&app, &user)?;

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 8192,
        // Transcription needs little reasoning; thinking tokens are billed as output.
        "output_config": { "effort": "low" },
        "messages": [{
            "role": "user",
            "content": [
                { "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": image } },
                { "type": "text", "text": OCR_PROMPT }
            ]
        }]
    });
    let resp = http()?
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Could not reach Anthropic: {e}"))?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let j: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let stop_reason = j["stop_reason"].as_str().unwrap_or("").to_string();
    if stop_reason == "refusal" {
        return Err("The model declined to transcribe this image.".into());
    }
    let latex = j["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    Ok(OcrResult {
        latex: latex.trim().to_string(),
        input_tokens: j["usage"]["input_tokens"].as_u64().unwrap_or(0),
        output_tokens: j["usage"]["output_tokens"].as_u64().unwrap_or(0),
        stop_reason,
    })
}

// ---- inbox thumbnail cache ----
// Small previews of inbox photos, kept on this device so the inbox does not download every full-size photo
// each session. Purely a cache: safe to delete, never synced.

fn thumb_cache_dir(app: &tauri::AppHandle, user: &str) -> Result<PathBuf, String> {
    let dir = user_dir(app, user)?.join(".cache").join("inbox");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Photo ids are UUIDs; anything else never becomes a file name.
fn valid_photo_id(id: &str) -> Result<&str, String> {
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(id)
    } else {
        Err("invalid photo id".into())
    }
}

#[tauri::command]
fn thumb_get(app: tauri::AppHandle, user: String, id: String) -> Result<Response, String> {
    let bytes = fs::read(thumb_cache_dir(&app, &user)?.join(format!("{}.jpg", valid_photo_id(&id)?))).map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

/// Raw body is a JPEG; headers x-user and x-id.
#[tauri::command]
fn thumb_put(app: tauri::AppHandle, request: Request<'_>) -> Result<(), String> {
    let (user, id) = (header(&request, "x-user")?, header(&request, "x-id")?);
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw body".into());
    };
    write_atomic(thumb_cache_dir(&app, &user)?.join(format!("{}.jpg", valid_photo_id(&id)?)), bytes)
}

/// Drops cached thumbnails of photos that no longer exist, so the cache cannot grow without bound.
#[tauri::command]
fn thumb_prune(app: tauri::AppHandle, user: String, keep: Vec<String>) -> Result<(), String> {
    for entry in fs::read_dir(thumb_cache_dir(&app, &user)?).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(id) = name.strip_suffix(".jpg") else { continue };
        if !keep.iter().any(|k| k == id) {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(())
}

/// Compile `source` and return the PDF bytes. Prefers tectonic, falls back to pdflatex.
fn build_pdf(
    app: &tauri::AppHandle,
    user: &str,
    path: &str,
    source: &str,
    scratch: Option<&str>,
) -> Result<Vec<u8>, String> {
    // Templates have no folder of their own, so they compile in a throwaway directory.
    let dir = if let Some(name) = scratch {
        let d = user_dir(app, user)?.join(name);
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

#[tauri::command(async)]
fn compile(
    app: tauri::AppHandle,
    user: String,
    path: String,
    source: String,
    scratch: bool,
) -> Result<Response, String> {
    build_pdf(&app, &user, &path, &source, scratch.then_some(".scratch")).map(Response::new)
}

/// Stand-ins for characters that must not count as nesting when tex-fmt indents (Unicode private use, one char each).
const FMT_STANDINS: [(char, char); 6] = [
    ('(', '\u{E000}'), (')', '\u{E001}'), ('[', '\u{E002}'), (']', '\u{E003}'), ('{', '\u{E004}'), ('}', '\u{E005}'),
];

/// tex-fmt indents after every `(`, `[` and `{` it sees, so ordinary prose breaks it: the label in `\item[ii)]`,
/// a list marker like `a)`, a half-open interval `[0, 1)`, `\\[2pt]`, or `\left\{ ... \right.`. In LaTeX only braces
/// and environments nest (plus `\[ \]` and `\( \)`), so before formatting this swaps the rest for stand-ins:
/// `(` `)` always, `[` `]` unless escaped (`\[`, `\]`), and escaped braces `\{` `\}` (they never open a group).
/// An odd run of backslashes before a character means it is escaped.
fn protect_delimiters(text: &str, restore: bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut slashes = 0usize;
    for c in text.chars() {
        let escaped = slashes % 2 == 1;
        let mapped = if restore {
            FMT_STANDINS.iter().find(|(_, s)| *s == c).map(|(o, _)| *o)
        } else {
            match c {
                '(' | ')' if !escaped => Some(c),
                '[' | ']' if !escaped => Some(c),
                '{' | '}' if escaped => Some(c),
                _ => None,
            }
            .and_then(|c| FMT_STANDINS.iter().find(|(o, _)| *o == c).map(|(_, s)| *s))
        };
        out.push(mapped.unwrap_or(c));
        slashes = if c == '\\' { slashes + 1 } else { 0 };
    }
    out
}

/// Formats LaTeX with the `tex-fmt` crate. `indent` is "2", "4" or "tab". tex-fmt panics on input it cannot make
/// sense of (unbalanced environments, for one), so that is caught and returned as an error message.
#[tauri::command(async)]
fn format_tex(text: String, wrap: bool, wraplen: u32, indent: String) -> Result<String, String> {
    use tex_fmt::args::{Args, OptionArgs};
    use tex_fmt::config::get_config_args;
    use tex_fmt::format::format_file;
    use merge::Merge;

    if text.chars().any(|c| FMT_STANDINS.iter().any(|(_, s)| *s == c)) {
        return Err("the document contains characters from the Unicode private-use area (U+E000 to U+E005)".into());
    }
    let text = protect_delimiters(&text, false);
    let (tabchar, tabsize) = match indent.as_str() {
        "tab" => ("tab", 1),
        "4" => ("space", 4),
        _ => ("space", 2),
    };
    let config = format!(
        "wrap = {wrap}\nwraplen = {}\ntabsize = {tabsize}\ntabchar = \"{tabchar}\"\n",
        wraplen.clamp(20, 300)
    );
    let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut opts = get_config_args(Some((PathBuf::new(), String::new(), config))).unwrap();
        opts.merge(OptionArgs::default());
        let mut args = Args::from(opts);
        args.stdin = true;
        let mut logs = Vec::new();
        args.resolve(&mut logs);
        let out = format_file(&text, std::path::Path::new("input"), &args, &mut logs);
        // tex-fmt reports a document whose \begin/\end or braces do not balance only as indentation warnings
        // ("Indent is negative", "Indent does not return to zero"). Indenting such a document would just spread
        // the confusion, so treat those like errors and leave the text alone.
        let errors: Vec<String> = logs
            .iter()
            .filter(|l| l.level == log::Level::Error || (l.level == log::Level::Warn && l.message.contains("ndent")))
            .map(|l| match l.linum_old {
                Some(n) => format!("line {n}: {}", l.message.trim_end_matches('.')),
                None => l.message.trim_end_matches('.').to_string(),
            })
            .collect();
        (out, errors)
    }));
    match run {
        Ok((_, errors)) if !errors.is_empty() => Err(errors.join("; ")),
        Ok((out, _)) => Ok(protect_delimiters(&out, true)),
        Err(_) => Err("tex-fmt could not make sense of this document".into()),
    }
}

/// Compiles and writes the PDF to `dest`, a location the user picked. This is the only way a PDF leaves the app.
#[tauri::command(async)]
fn export_pdf(
    app: tauri::AppHandle,
    user: String,
    path: String,
    source: String,
    scratch: bool,
    dest: String,
) -> Result<(), String> {
    let pdf = build_pdf(&app, &user, &path, &source, scratch.then_some(".scratch"))?;
    write_atomic(dest, pdf)
}

/// Runs the LaTeX engine in `dir`: the bundled tectonic, else one on PATH, else pdflatex.
fn run_engine(dir: &PathBuf) -> Result<std::process::Output, String> {
    latex::wait_for_setup(); // the first-run download may still be going
    let tectonic_args: &[&str] = &["-X", "compile", "--keep-logs", "main.tex"];
    let mut attempts: Vec<(PathBuf, &[&str])> = Vec::new();
    if let Some(bundled) = latex::bundled_tectonic() {
        attempts.push((bundled, tectonic_args));
    }
    attempts.push(("tectonic".into(), tectonic_args));
    attempts.push((
        "pdflatex".into(),
        &["-interaction=nonstopmode", "-halt-on-error", "main.tex"],
    ));
    for (bin, args) in attempts {
        let mut cmd = Command::new(&bin);
        cmd.args(args).current_dir(dir);
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000); // no console window
        match cmd.output() {
            Ok(out) => return Ok(out),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("{}: {e}", bin.display())),
        }
    }
    Err("No LaTeX engine found. Texture normally bundles tectonic; otherwise install tectonic or a TeX Live with pdflatex.".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_configs,
            load_config,
            save_config,
            list_documents,
            list_folders,
            create_folder,
            list_templates,
            save_template_preview,
            apply_template_preview,
            mark_template_preview,
            read_template_preview,
            compile_template_preview,
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
            rename_template,
            rename_local,
            duplicate_document,
            duplicate_template,
            set_item_id,
            remove_local,
            compile,
            export_pdf,
            format_tex,
            thumb_get,
            thumb_put,
            thumb_prune,
            set_api_key,
            has_api_key,
            test_api_key,
            ocr_image,
            latex::latex_setup_status,
            latex::start_latex_setup,
            latex::retry_latex_setup
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod format_tests {
    use super::format_tex;

    #[test]
    fn indents_and_keeps_long_lines_when_wrap_is_off() {
        let src = "\\documentclass{article}\n\\begin{document}\n\\begin{itemize}\n\\item one   \n\\item two\n\\end{itemize}\nA very long line of prose that goes on and on well past the eighty column mark for sure yes.\n\\end{document}\n";
        let out = format_tex(src.into(), false, 80, "2".into()).unwrap();
        assert!(out.contains("\n  \\item one\n"), "{out}");
        assert!(out.contains("goes on and on well past the eighty column mark for sure yes.\n"), "{out}");
    }

    #[test]
    fn wraps_when_asked() {
        let src = "\\begin{document}\nA very long line of prose that goes on and on well past the eighty column mark for sure yes.\n\\end{document}\n";
        let out = format_tex(src.into(), true, 40, "4".into()).unwrap();
        assert!(out.lines().all(|l| l.len() <= 40), "{out}");
    }

    #[test]
    fn unbalanced_input_is_refused() {
        let r = format_tex("\\begin{document}\n\\begin{itemize}\n\\end{document}\n".into(), false, 80, "2".into());
        assert!(r.is_err(), "{r:?}");
        let r = format_tex("\\end{foo}\n}\n".into(), false, 80, "2".into());
        assert!(r.is_err(), "{r:?}");
    }

    #[test]
    fn prose_with_stray_delimiters_does_not_break_indentation() {
        let src = "\\begin{document}\n\\begin{enumerate}\n\\item[ii)] Show that\ni) Verify\n[0, 1) is half open\n\\begin{align*}\nx &= 1 \\\\[2pt]\ny &= \\left\\{ 1 \\right.\n\\end{align*}\n\\end{enumerate}\n\\end{document}\n";
        let out = format_tex(src.into(), false, 80, "2".into()).unwrap();
        assert!(out.contains("\n  \\item[ii)] Show that\n"), "{out}");
        assert!(out.contains("\n    \\begin{align*}\n"), "{out}");
        assert!(out.contains("\\left\\{ 1 \\right."), "{out}");
        assert!(out.ends_with("\\end{document}\n"), "{out}");
    }

    #[test]
    fn display_math_brackets_still_nest() {
        let src = "\\begin{document}\n\\[\nx = 1\n\\]\n\\end{document}\n";
        let out = format_tex(src.into(), false, 80, "2".into()).unwrap();
        assert!(out.contains("\\[\n  x = 1\n\\]"), "{out}");
    }

    #[test]
    fn a_line_too_long_to_wrap_is_not_an_error() {
        let long = "x".repeat(100);
        let src = format!("\\begin{{document}}\n{long}\n\\end{{document}}\n");
        assert!(format_tex(src, true, 40, "2".into()).is_ok());
    }
}

#[cfg(test)]
mod sync_tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("texture-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn copy_names_count_up_and_respect_the_length_limit() {
        assert_eq!(copy_name("HW", |_| false), "HW copy");
        assert_eq!(copy_name("HW", |n| n == "HW copy"), "HW copy 2");
        let long = "x".repeat(64);
        let c = copy_name(&long, |_| false);
        assert_eq!(c.chars().count(), 64);
        assert!(c.ends_with(" copy"));
    }

    #[test]
    fn merge_move_renames_when_the_target_is_free() {
        let root = scratch("free");
        fs::create_dir_all(root.join("A/sub")).unwrap();
        fs::write(root.join("A/.sync.json"), "{}").unwrap();
        merge_move(&root.join("A"), &root.join("B")).unwrap();
        assert!(root.join("B/sub").is_dir() && root.join("B/.sync.json").is_file() && !root.join("A").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn merge_move_folds_a_folder_into_an_existing_plain_folder() {
        // A device applying another device's folder rename may already have created the new folder implicitly
        // (because a document inside it was moved first).
        let root = scratch("merge");
        fs::create_dir_all(root.join("Old/Labs")).unwrap();
        fs::write(root.join("Old/.sync.json"), "{\"id\":\"f\"}").unwrap();
        fs::create_dir_all(root.join("New/Labs/Lab 1")).unwrap();
        fs::write(root.join("New/Labs/Lab 1/main.tex"), "x").unwrap();
        merge_move(&root.join("Old"), &root.join("New")).unwrap();
        assert!(!root.join("Old").exists());
        assert!(root.join("New/.sync.json").is_file());
        assert!(root.join("New/Labs/Lab 1/main.tex").is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn merge_move_refuses_to_overwrite_a_document() {
        let root = scratch("doc");
        fs::create_dir_all(root.join("A")).unwrap();
        fs::create_dir_all(root.join("B")).unwrap();
        fs::write(root.join("B/main.tex"), "x").unwrap();
        assert!(merge_move(&root.join("A"), &root.join("B")).is_err());
        assert!(root.join("A").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tombstones_match_by_id_when_both_have_one() {
        let t = |path: &str, id: Option<&str>| Tombstone { kind: "document".into(), path: path.into(), id: id.map(Into::into), remote_at: "v".into() };
        // same path, different documents (the name was reused)
        assert!(!same_item(&t("HW", Some("~a")), "document", "HW", Some("~b")));
        // renamed since: still the same document
        assert!(same_item(&t("Old", Some("~a")), "document", "New", Some("~a")));
        // legacy tombstone without an id falls back to the path
        assert!(same_item(&t("HW", None), "document", "HW", Some("~a")));
        assert!(!same_item(&t("HW", None), "template", "HW", None));
    }
}
