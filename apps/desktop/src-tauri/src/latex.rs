//! The LaTeX engine and its first-run setup.
//!
//! Tectonic fetches fonts and packages from the network the first time it needs them and caches them, so the
//! very first compile on a machine takes about a minute. To keep that out of the first compile, the app runs a
//! throwaway document through tectonic once the user has signed in (`start_latex_setup`), reports progress to the window as
//! `latex-setup` events, and makes real compiles wait for it (`wait_for_setup`). A marker file in the app data
//! directory records that it finished, so later launches skip it.

use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Condvar, Mutex, MutexGuard};

use serde::Serialize;
use tauri::{Emitter, Manager};

/// What the window shows. `state` is one of idle, running, done, error, skipped (skipped: no tectonic here, so
/// pdflatex is used and there is nothing to download).
#[derive(Clone, Serialize)]
pub struct Setup {
    state: &'static str,
    /// Files downloaded so far (the total is unknown, so there is no percentage).
    files: u32,
    /// The file being fetched while running; the engine's last output lines on error.
    detail: String,
}

static SETUP: Mutex<Setup> = Mutex::new(Setup { state: "idle", files: 0, detail: String::new() });
static CHANGED: Condvar = Condvar::new();

const WARMUP_TEX: &str = r"\documentclass{article}
\usepackage{amsmath, amssymb, amsthm, graphicx, hyperref, xcolor, enumitem, booktabs}
\usepackage[margin=1in]{geometry}
\begin{document}
\section*{Setup}
Plain, \textbf{bold}, \textit{italic}, \texttt{mono}. $\int_0^1 x^2\,dx = \frac13$
\[ \sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6} \]
\begin{enumerate}[label=(\alph*)] \item one \item two \end{enumerate}
\end{document}
";

fn lock() -> MutexGuard<'static, Setup> {
    SETUP.lock().unwrap_or_else(|e| e.into_inner())
}

fn update(app: &tauri::AppHandle, f: impl FnOnce(&mut Setup)) {
    let snapshot = {
        let mut s = lock();
        f(&mut s);
        s.clone()
    };
    CHANGED.notify_all();
    let _ = app.emit("latex-setup", snapshot);
}

/// The tectonic that ships with the app (Tauri's `externalBin` puts it next to the main executable, and
/// copies it beside the dev binary too). None when it is missing, e.g. when running a bare `cargo run`.
pub fn bundled_tectonic() -> Option<PathBuf> {
    let name = if cfg!(windows) { "tectonic.exe" } else { "tectonic" };
    let path = std::env::current_exe().ok()?.parent()?.join(name);
    path.is_file().then_some(path)
}

/// Blocks while the first-run download is in progress, so a compile started meanwhile just waits for it.
pub fn wait_for_setup() {
    let mut s = lock();
    while s.state == "running" {
        s = CHANGED.wait(s).unwrap_or_else(|e| e.into_inner());
    }
}

fn marker_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(".latex-ready"))
}

/// Starts the download unless it already finished for this app version. Returns at once; the work is on a thread.
pub fn start(app: tauri::AppHandle) {
    let Ok(marker) = marker_path(&app) else { return };
    let version = env!("CARGO_PKG_VERSION");
    if fs::read_to_string(&marker).is_ok_and(|v| v.trim() == version) {
        update(&app, |s| s.state = "done");
        return;
    }
    update(&app, |s| {
        s.state = "running";
        s.files = 0;
        s.detail.clear();
    });
    std::thread::spawn(move || {
        let outcome = run_warmup(&app);
        update(&app, |s| match outcome {
            Ok(true) => {
                let _ = fs::write(&marker, version);
                s.state = "done";
            }
            Ok(false) => s.state = "skipped",
            Err(e) => {
                s.state = "error";
                s.detail = e;
            }
        });
    });
}

/// Ok(true): finished; Ok(false): no tectonic to set up; Err: what went wrong (offline, etc.).
fn run_warmup(app: &tauri::AppHandle) -> Result<bool, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join(".latex-setup");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("main.tex"), WARMUP_TEX).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(dir.join("main.pdf"));

    let mut candidates: Vec<PathBuf> = bundled_tectonic().into_iter().collect();
    candidates.push("tectonic".into());
    let mut child = None;
    for bin in candidates {
        let mut cmd = Command::new(&bin);
        cmd.args(["-X", "compile", "--keep-logs", "main.tex"])
            .current_dir(&dir)
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000); // no console window
        match cmd.spawn() {
            Ok(c) => {
                child = Some(c);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("{}: {e}", bin.display())),
        }
    }
    let Some(mut child) = child else { return Ok(false) };

    let mut tail: VecDeque<String> = VecDeque::new();
    if let Some(stderr) = child.stderr.take() {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Some(file) = line.split_once("downloading ").map(|(_, f)| f.trim().to_string()) {
                update(app, |s| {
                    s.files += 1;
                    s.detail = file;
                });
            }
            tail.push_back(line);
            if tail.len() > 8 {
                tail.pop_front();
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() && dir.join("main.pdf").is_file() {
        Ok(true)
    } else {
        Err(tail.into_iter().collect::<Vec<_>>().join("\n"))
    }
}

/// Called by the window right after sign-in. Does nothing if a run has already started this session.
#[tauri::command]
pub fn start_latex_setup(app: tauri::AppHandle) {
    if lock().state == "idle" {
        start(app);
    }
}

#[tauri::command]
pub fn latex_setup_status() -> Setup {
    lock().clone()
}

/// "Try again" after a failed download (typically: no internet).
#[tauri::command]
pub fn retry_latex_setup(app: tauri::AppHandle) {
    if lock().state == "error" {
        start(app);
    }
}
