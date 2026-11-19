//! Running the LaTeX engine: the editor's compile, PDF export and template thumbnails.
//!
//! Every run has a time limit, the editor's compile can be cancelled, and two runs never share a folder at the
//! same moment (an export started while a compile is going waits for it instead of trampling its files).

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::ipc::Response;

use crate::{ensure_doc_dir, latex, read_template, user_dir, write_atomic};

/// Longest a single engine run may take. A document that loops forever would otherwise hold the compile for good;
/// the limit is generous because tectonic may fetch a package it has not used before.
const ENGINE_TIMEOUT: Duration = Duration::from_secs(180);

/// What a cancelled compile returns; the window matches on this text.
const CANCELLED: &str = "Compile cancelled";

/// Set by `cancel_compile`, consumed by the editor's compile.
static CANCEL: AtomicBool = AtomicBool::new(false);

/// Folders an engine run is using right now.
static BUSY_DIRS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
static DIR_FREED: Condvar = Condvar::new();

struct DirLock(PathBuf);

/// Waits until no other run is using `dir`, then claims it until the returned value is dropped.
fn lock_dir(dir: &Path) -> DirLock {
    let mut busy = BUSY_DIRS.lock().unwrap_or_else(|e| e.into_inner());
    while busy.iter().any(|d| d == dir) {
        busy = DIR_FREED.wait(busy).unwrap_or_else(|e| e.into_inner());
    }
    busy.push(dir.to_path_buf());
    DirLock(dir.to_path_buf())
}

impl Drop for DirLock {
    fn drop(&mut self) {
        BUSY_DIRS.lock().unwrap_or_else(|e| e.into_inner()).retain(|d| d != &self.0);
        DIR_FREED.notify_all();
    }
}

/// Runs `cmd` to the end, collecting its output. The inner error is a run that was stopped (time limit, or the
/// user cancelled); the outer one is a failure to start it at all.
fn run_child(mut cmd: Command, cancellable: bool, limit: Duration) -> std::io::Result<Result<Output, String>> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    // Drained on threads: a full pipe would otherwise stall the engine.
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            buf
        })
    };
    let out = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let err = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));

    let deadline = Instant::now() + limit;
    let ended = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => {}
            Err(e) => break Err(e.to_string()),
        }
        if cancellable && CANCEL.swap(false, Ordering::SeqCst) {
            break Err(CANCELLED.to_string());
        }
        if Instant::now() >= deadline {
            break Err(format!(
                "The compile was stopped after {} seconds without finishing. Something in the document may be looping forever.",
                limit.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(40));
    };
    if ended.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let (stdout, stderr) = (out.join().unwrap_or_default(), err.join().unwrap_or_default());
    Ok(ended.map(|status| Output { status, stdout, stderr }))
}

/// Runs the LaTeX engine in `dir`: the bundled tectonic, else one on PATH, else pdflatex.
fn run_engine(dir: &Path, cancellable: bool) -> Result<Output, String> {
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
        match run_child(cmd, cancellable, ENGINE_TIMEOUT) {
            Ok(Ok(out)) => return Ok(out),
            Ok(Err(stopped)) => return Err(stopped),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("{}: {e}", bin.display())),
        }
    }
    Err("No LaTeX engine found. Texture normally bundles tectonic; otherwise install tectonic or a TeX Live with pdflatex.".into())
}

/// Compile `source` and return the PDF bytes. Prefers tectonic, falls back to pdflatex.
fn build_pdf(
    app: &tauri::AppHandle,
    user: &str,
    path: &str,
    source: &str,
    scratch: Option<&str>,
    cancellable: bool,
) -> Result<Vec<u8>, String> {
    // Templates have no folder of their own, so they compile in a throwaway directory.
    let dir = if let Some(name) = scratch {
        let d = user_dir(app, user)?.join(name);
        fs::create_dir_all(&d).map_err(|e| e.to_string())?;
        d
    } else {
        ensure_doc_dir(app, user, path)?
    };
    let _in_use = lock_dir(&dir);
    write_atomic(dir.join("main.tex"), source)?;

    let out = run_engine(&dir, cancellable)?;
    if !out.status.success() {
        let log = String::from_utf8_lossy(&out.stdout).to_string()
            + &String::from_utf8_lossy(&out.stderr);
        return Err(log);
    }
    fs::read(dir.join("main.pdf")).map_err(|e| e.to_string())
}

/// The editor's compile. Only this one can be cancelled (`cancel_compile`).
#[tauri::command(async)]
pub fn compile(
    app: tauri::AppHandle,
    user: String,
    path: String,
    source: String,
    scratch: bool,
) -> Result<Response, String> {
    CANCEL.store(false, Ordering::SeqCst); // a Cancel pressed when nothing was running must not stop this one
    build_pdf(&app, &user, &path, &source, scratch.then_some(".scratch"), true).map(Response::new)
}

/// Stops the editor's compile, if one is running; it then fails with "Compile cancelled".
#[tauri::command]
pub fn cancel_compile() {
    CANCEL.store(true, Ordering::SeqCst);
}

/// Compiles a stored template in its own scratch folder (so it never collides with the editor's) and returns the PDF.
#[tauri::command(async)]
pub fn compile_template_preview(app: tauri::AppHandle, user: String, name: String) -> Result<Response, String> {
    let source = read_template(app.clone(), user.clone(), name)?;
    build_pdf(&app, &user, "", &source, Some(".scratch-thumbs"), false).map(Response::new)
}

/// Compiles and writes the PDF to `dest`, a location the user picked. This is the only way a PDF leaves the app.
#[tauri::command(async)]
pub fn export_pdf(
    app: tauri::AppHandle,
    user: String,
    path: String,
    source: String,
    scratch: bool,
    dest: String,
) -> Result<(), String> {
    let pdf = build_pdf(&app, &user, &path, &source, scratch.then_some(".scratch"), false)?;
    write_atomic(dest, pdf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn a_run_that_never_ends_is_stopped_at_the_time_limit() {
        let mut cmd = Command::new("sleep");
        cmd.arg("30");
        let started = Instant::now();
        let r = run_child(cmd, false, Duration::from_millis(200)).unwrap();
        assert!(r.unwrap_err().contains("stopped after"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[test]
    fn output_is_collected_and_a_missing_program_is_reported_as_not_found() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "echo out; echo err >&2; exit 3"]);
        let out = run_child(cmd, false, Duration::from_secs(10)).unwrap().unwrap();
        assert_eq!(out.status.code(), Some(3));
        assert_eq!(String::from_utf8_lossy(&out.stdout), "out\n");
        assert_eq!(String::from_utf8_lossy(&out.stderr), "err\n");
        let missing = run_child(Command::new("texture-no-such-engine"), false, Duration::from_secs(1));
        assert_eq!(missing.unwrap_err().kind(), std::io::ErrorKind::NotFound);
    }

    #[test]
    fn a_folder_is_used_by_one_run_at_a_time() {
        let dir = PathBuf::from("/tmp/texture-lock-test");
        let first = lock_dir(&dir);
        let (tx, rx) = std::sync::mpsc::channel();
        let d = dir.clone();
        let t = std::thread::spawn(move || {
            let _second = lock_dir(&d);
            tx.send(()).unwrap();
        });
        assert!(rx.recv_timeout(Duration::from_millis(150)).is_err()); // still waiting
        drop(first);
        assert!(rx.recv_timeout(Duration::from_secs(5)).is_ok());
        t.join().unwrap();
    }
}
