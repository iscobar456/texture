import {
  RESERVED_KEYS,
  TRIGGER_RE,
  keyFromEvent,
  saveSnippets,
  showKey,
  userSnippets,
  type UserSnippet,
} from "./completions";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * The "Snippets & shortcuts" dialog. Edits are saved as you press Save; `onChange` lets the editor
 * pick up the new shortcuts.
 */
export function initSnippetsUi(onChange: () => void) {
  const dialog = $<HTMLDialogElement>("snippets-dialog");
  const list = $("snip-list");
  const trigger = $<HTMLInputElement>("snip-trigger");
  const desc = $<HTMLInputElement>("snip-desc");
  const key = $<HTMLInputElement>("snip-key");
  const body = $<HTMLTextAreaElement>("snip-body");
  const error = $("snip-error");
  const del = $<HTMLButtonElement>("snip-delete");

  let selected: string | null = null; // null = a new, unsaved snippet
  let shortcut = ""; // CodeMirror key name for the snippet being edited

  const setShortcut = (k: string) => {
    shortcut = k;
    key.value = k ? showKey(k) : "";
  };

  function fill(s: UserSnippet | null) {
    selected = s?.id ?? null;
    trigger.value = s?.trigger ?? "";
    desc.value = s?.description ?? "";
    body.value = s?.body ?? "";
    setShortcut(s?.shortcut ?? "");
    error.textContent = "";
    del.disabled = !s;
    renderList();
  }

  function renderList() {
    const items = userSnippets().map((s) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "snip-row" + (s.id === selected ? " current" : "");
      const name = document.createElement("span");
      name.textContent = s.trigger || "(shortcut only)";
      const hint = document.createElement("span");
      hint.className = "muted";
      hint.textContent = s.shortcut ? showKey(s.shortcut) : "";
      row.append(name, hint);
      row.onclick = () => fill(s);
      return row;
    });
    list.replaceChildren(...items);
    if (!items.length) list.textContent = "No snippets yet.";
  }

  // Press the keys you want; Backspace/Delete clears.
  key.addEventListener("keydown", (e) => {
    e.preventDefault();
    if (e.key === "Backspace" || e.key === "Delete") return setShortcut("");
    if (e.key === "Tab") return key.blur();
    const k = keyFromEvent(e);
    if (k) setShortcut(k);
  });

  $("snip-new").addEventListener("click", () => fill(null));

  del.addEventListener("click", () => {
    if (!selected) return;
    saveSnippets(userSnippets().filter((s) => s.id !== selected));
    onChange();
    fill(null);
  });

  $("snip-save").addEventListener("click", () => {
    const t = trigger.value.trim();
    const others = userSnippets().filter((s) => s.id !== selected);
    const problem =
      !body.value ? "The snippet needs some text to insert."
      : !t && !shortcut ? "Give it a trigger word, a shortcut, or both."
      : t && !TRIGGER_RE.test(t) ? "A trigger is letters and digits, optionally starting with a backslash (e.g. vv or \\vv)."
      : t && others.some((s) => s.trigger === t) ? `Another snippet already uses the trigger "${t}".`
      : shortcut && others.some((s) => s.shortcut === shortcut) ? "Another snippet already uses that shortcut."
      : RESERVED_KEYS.includes(shortcut) ? `${showKey(shortcut)} is used by the app (Compile).`
      : "";
    if (problem) {
      error.textContent = problem;
      return;
    }
    const next: UserSnippet = {
      id: selected ?? crypto.randomUUID(),
      trigger: t,
      description: desc.value.trim(),
      shortcut,
      body: body.value,
    };
    saveSnippets([...others, next].sort((a, b) => (a.trigger || "~").localeCompare(b.trigger || "~")));
    onChange();
    fill(next);
  });

  $("open-snippets").addEventListener("click", () => {
    fill(userSnippets()[0] ?? null);
    dialog.showModal();
  });
}
