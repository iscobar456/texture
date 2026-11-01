import { showKey } from "./completions";
import { getActive } from "./snippets";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Key names are CodeMirror's ("Mod" = Ctrl, or ⌘ on a Mac). Several alternatives are joined with " / ". */
type Row = [keys: string, what: string];
type Section = { title: string; note?: string; rows: Row[] };

/**
 * Written by hand: CodeMirror's bindings carry no descriptions, and their command names are mangled in a
 * production build, so they can't be listed from the live keymap. If you add or change a binding in
 * main.ts / completions.ts, update this list. Only the snippet shortcuts below are read from live data.
 */
function sections(vimOn: boolean): Section[] {
  const mine = getActive().keys;
  return [
    {
      title: "App",
      rows: [
        ["Mod-Enter", "Compile and refresh the preview"],
        ["Mod-p", "Search all documents and open one (or create it)"],
        ["Mod-,", "Open Settings"],
        ["ArrowDown / ArrowUp", "Move through an open menu or the document search results"],
        ["Escape", "Close the menu or a dialog"],
        ["Enter", "Confirm a dialog; open the focused card in the document or template picker"],
      ],
    },
    {
      title: "Editing",
      rows: [
        ["Mod-z", "Undo"],
        ["Mod-y / Mod-Shift-z", "Redo"],
        ["Mod-u", "Undo the last selection change"],
        ["Mod-a", "Select all"],
        ["Mod-l", "Select the current line"],
        ["Mod-/", "Toggle comment on the line or selection"],
        ["Tab / Shift-Tab", "Indent / dedent"],
        ["Mod-[ / Mod-]", "Dedent / indent the line or selection"],
        ["Mod-Alt-\\", "Re-indent the selection"],
        ["Alt-ArrowUp / Alt-ArrowDown", "Move the line up / down"],
        ["Shift-Alt-ArrowUp / Shift-Alt-ArrowDown", "Copy the line up / down"],
        ["Shift-Mod-k", "Delete the line"],
        ["Mod-Backspace / Mod-Delete", "Delete the previous / next word"],
        ["Backspace", "Delete both brackets when between an empty pair"],
      ],
    },
    {
      title: "Moving around",
      rows: [
        ["Home / End", "Start / end of the line"],
        ["Mod-Home / Mod-End", "Start / end of the document"],
        ["Mod-ArrowLeft / Mod-ArrowRight", "Move by word"],
        ["Shift-Mod-\\", "Jump to the matching bracket"],
        ["PageUp / PageDown", "Scroll a page"],
        ["Mod-Alt-g", "Go to a line number"],
      ],
    },
    {
      title: "Find and replace",
      rows: [
        ["Mod-f", "Find (the panel also does replace)"],
        ["F3 / Mod-g", "Next match"],
        ["Shift-F3 / Shift-Mod-g", "Previous match"],
        ["Shift-Mod-l", "Select every match"],
        ["Escape", "Close the find panel"],
      ],
    },
    {
      title: "Folding",
      rows: [
        ["Ctrl-Shift-[ / Ctrl-Shift-]", "Fold / unfold at the cursor"],
        ["Ctrl-Alt-[ / Ctrl-Alt-]", "Fold all / unfold all"],
      ],
    },
    {
      title: "Autocomplete and snippets",
      rows: [
        ["Ctrl-Space", "Open suggestions"],
        ["ArrowDown / ArrowUp", "Move through suggestions"],
        ["Enter", "Accept the highlighted suggestion"],
        ["Escape", "Dismiss suggestions"],
        ["Tab / Shift-Tab", "Next / previous blank in an inserted template"],
      ],
    },
    {
      title: "My snippet shortcuts",
      note: mine.length
        ? "Work while typing, not in Vim normal mode. Defined in your snippets file (Menu → Snippets → Edit snippets file)."
        : "None yet. Add a key = 'Mod-Alt-m' line to a snippet in your snippets file (Menu → Snippets).",
      rows: mine.map((s): Row => [s.key, s.label]),
    },
    {
      title: "Vim mode",
      note: vimOn
        ? "Vim is on. Common commands are listed; most standard Vim commands work."
        : "Vim is off (Settings → Default editing mode). These apply once you turn it on.",
      rows: [
        ["Escape", "Back to normal mode"],
        ["i / a / I / A", "Insert before / after the cursor / at line start / at line end"],
        ["o / O", "New line below / above and insert"],
        ["v / V / Ctrl-v", "Visual: characters / lines / block"],
        ["h j k l", "Left, down, up, right"],
        ["w b e", "Next word / previous word / end of word"],
        ["0 ^ $", "Start of line / first non-blank / end of line"],
        ["gg / G", "Top / bottom of the document"],
        ["{ } %", "Previous / next paragraph, matching bracket"],
        ["f<char> t<char>", "Jump to / just before a character on the line"],
        ["x dd D", "Delete character / line / to end of line"],
        ["yy p P", "Copy line, paste after / before"],
        ["cw ciw", "Change word / change the whole word under the cursor"],
        [">> <<", "Indent / dedent the line"],
        ["u / Ctrl-r", "Undo / redo"],
        [".", "Repeat the last change"],
        ["/text  n  N", "Search, next match, previous match"],
        [":w", "Compile and refresh the preview (the app's meaning of save)"],
        [":%s/old/new/g", "Replace in the whole document"],
      ],
    },
  ];
}

/** "Mod-Shift-z" -> <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>z</kbd>, with arrows shown as symbols. */
function keysEl(spec: string): HTMLElement {
  const wrap = document.createElement("span");
  const arrows: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };
  const alternatives = spec.split(" / ");
  alternatives.forEach((alt, i) => {
    if (i) wrap.append(" / ");
    // Vim-style rows ("dd", "/text n N") are typed sequences, not chords; show them as one block.
    const chord = /^(Mod|Ctrl|Alt|Shift|F\d+|Arrow|Page|Home|End|Enter|Escape|Tab|Backspace|Delete|Space)/.test(alt) || /[A-Za-z]-/.test(alt);
    const parts = chord ? showKey(alt).split("-") : [alt];
    parts.forEach((part, j) => {
      if (j) wrap.append("+");
      const k = document.createElement("kbd");
      k.textContent = arrows[part] ?? part;
      wrap.append(k);
    });
  });
  return wrap;
}

export function initShortcutsUi(isVimOn: () => boolean) {
  const dialog = $<HTMLDialogElement>("shortcuts-dialog");
  const body = $("shortcuts-body");
  const search = $<HTMLInputElement>("shortcuts-search");

  function render() {
    const q = search.value.trim().toLowerCase();
    const out: HTMLElement[] = [];
    for (const s of sections(isVimOn())) {
      const rows = s.rows.filter(([k, what]) => !q || k.toLowerCase().includes(q) || what.toLowerCase().includes(q) || s.title.toLowerCase().includes(q));
      if (!rows.length && !(q === "" && s.note)) continue;
      const sec = document.createElement("section");
      const h = document.createElement("h4");
      h.textContent = s.title;
      sec.append(h);
      if (s.note) {
        const n = document.createElement("p");
        n.className = "muted";
        n.textContent = s.note;
        sec.append(n);
      }
      if (rows.length) {
        const table = document.createElement("div");
        table.className = "sc-rows";
        for (const [k, what] of rows) {
          const keys = document.createElement("div");
          keys.className = "sc-keys";
          keys.append(keysEl(k));
          const desc = document.createElement("div");
          desc.textContent = what;
          table.append(keys, desc);
        }
        sec.append(table);
      }
      out.push(sec);
    }
    body.replaceChildren(...out);
    if (!out.length) body.textContent = "No shortcuts match.";
  }

  search.addEventListener("input", render);
  $("open-shortcuts").addEventListener("click", () => {
    search.value = "";
    render();
    dialog.showModal();
    search.focus();
  });
}
