import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "./toast";

/** Mirrors `Setup` in src-tauri/src/latex.rs. */
type Setup = { state: "idle" | "running" | "done" | "error" | "skipped"; files: number; detail: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * The first-run LaTeX download (see latex.rs): main.ts starts it right after sign-in (`startLatexSetup`), and this
 * shows its progress in a dialog. Hiding the dialog is fine; compiles wait for the
 * download, and a failure (typically no internet) brings the dialog back with a Try again button.
 */
let running = false;

/** True while the first-run download is going; compiles started meanwhile wait for it. */
export const latexSetupRunning = () => running;

/** Begins the download (a no-op when it already ran); the dialog opens from the progress events. */
export const startLatexSetup = () => invoke("start_latex_setup");

export function initLatexSetup(onChange: () => void) {
  const dlg = $<HTMLDialogElement>("latex-dialog");
  const msg = $("latex-msg");
  const progress = $("latex-progress");
  const detail = $("latex-detail");
  const error = $("latex-error");
  const retry = $<HTMLButtonElement>("latex-retry");
  let wasShown = false;
  let last: Setup["state"] = "idle";

  function open() {
    if (!dlg.open) dlg.showModal();
    wasShown = true;
  }

  function render(s: Setup) {
    const before = last;
    last = s.state;
    running = s.state === "running";
    onChange();
    progress.hidden = s.state !== "running";
    retry.hidden = s.state !== "error";
    error.hidden = s.state !== "error" || !s.detail;
    detail.hidden = s.state !== "running";

    if (s.state === "running") {
      msg.textContent = "Texture is downloading the LaTeX fonts and packages it needs. This happens once, takes about a minute, " +
        "and needs an internet connection. You can hide this window; documents compile as soon as it finishes.";
      detail.textContent = s.files ? `Downloaded ${s.files} files · ${s.detail}` : "Starting…";
      if (before !== "running" && !wasShown) open();
    } else if (s.state === "error") {
      msg.textContent = "Couldn't finish downloading the LaTeX files. Check your internet connection and try again. " +
        "Until it finishes, documents can't compile.";
      error.textContent = s.detail;
      open();
    } else if (s.state === "done" && before === "running") {
      if (dlg.open) dlg.close();
      toast("LaTeX is ready");
    }
  }

  retry.addEventListener("click", () => {
    render({ state: "running", files: 0, detail: "" });
    void invoke("retry_latex_setup");
  });
  void listen<Setup>("latex-setup", (e) => render(e.payload));
  void invoke<Setup>("latex_setup_status").then(render);
}
