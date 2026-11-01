import {
  snippet,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { Prec, type Extension } from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";
import { getCM } from "@replit/codemirror-vim";
import { getActive } from "./snippets";

// What can be suggested lives in the user's snippets file (see snippets.ts and default-snippets.toml).
// This module is only the machinery: when to suggest what, and how shortcuts are bound.

// ---- shortcuts ----

/** Vim's normal/visual modes interpret keys as commands, so snippets only fire when typing. */
function canInsert(view: EditorView): boolean {
  try {
    const vim = getCM(view)?.state?.vim;
    return !vim || vim.insertMode;
  } catch {
    return true;
  }
}

/** Keymap for the user's snippet shortcuts. Highest precedence so it beats the Vim extension. */
export function snippetKeymap(keys: { key: string; body: string }[]): Extension {
  try {
    return Prec.highest(
      keymap.of(
        keys.map((s) => ({
          key: s.key,
          preventDefault: true,
          run: (view: EditorView) => {
            if (!canInsert(view)) return false;
            const { from, to } = view.state.selection.main;
            snippet(s.body)(view, null, from, to);
            view.focus();
            return true;
          },
        })),
      ),
    );
  } catch (e) {
    console.warn("could not bind snippet shortcuts", e);
    return [];
  }
}

/** Turns a keydown into a CodeMirror key name, or null if it isn't a usable shortcut yet. */
export function keyFromEvent(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta", "AltGraph"].includes(e.key)) return null;
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("Mod");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  // Use the physical key for letters/digits: Alt can change the produced character.
  const letter = /^Key([A-Z])$/.exec(e.code);
  const digit = /^Digit(\d)$/.exec(e.code);
  const k = letter ? letter[1].toLowerCase() : digit ? digit[1] : e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (!mods.some((m) => m !== "Shift") && !/^F\d+$/.test(k)) return null;
  return [...mods, k].join("-");
}

export const showKey = (key: string) => key.replace("Mod", navigator.platform.includes("Mac") ? "⌘" : "Ctrl");

/** Replaces the typed name and the auto-closed "}" together, then inserts an environment skeleton. */
function beginEnvironment(name: string): Completion {
  const tpl = `${name}}\n\t#{}\n\\end{${name}}`;
  return {
    label: name,
    type: "class",
    detail: "environment",
    apply: (view, completion, from, to) => {
      // closeBrackets leaves a "}" after the cursor; the template supplies its own.
      const end = view.state.sliceDoc(to, to + 1) === "}" ? to + 1 : to;
      snippet(tpl)(view, completion, from, end);
    },
  };
}

const plainNames = (list: string[], type: string): Completion[] => list.map((label) => ({ label, type }));

/** Labels defined in the document, for \ref{...}. */
function documentLabels(ctx: CompletionContext): Completion[] {
  const out = new Map<string, Completion>();
  for (const m of ctx.state.doc.toString().matchAll(/\\label\{([^}\s]+)\}/g)) {
    out.set(m[1], { label: m[1], type: "variable", detail: "label" });
  }
  return [...out.values()];
}

/** The one completion source for LaTeX; registered through EditorState.languageData. */
export function latexSource(ctx: CompletionContext): CompletionResult | null {
  const cfg = getActive();

  // \begin{...  /  \end{...
  const env = ctx.matchBefore(/\\(begin|end)\{[A-Za-z*]*/);
  if (env) {
    const isBegin = env.text.startsWith("\\begin");
    const names = cfg.config.environments;
    return {
      from: env.from + env.text.indexOf("{") + 1,
      options: isBegin ? names.map(beginEnvironment) : plainNames(names, "class"),
      validFor: /^[A-Za-z*]*$/,
    };
  }

  // \ref{...  and friends (labels come from the document itself)
  const ref = ctx.matchBefore(/\\(?:eq|auto|c|C|page|name)?ref\{[^}\s]*/);
  if (ref) {
    return {
      from: ref.from + ref.text.indexOf("{") + 1,
      options: documentLabels(ctx),
      validFor: /^[^}\s]*$/,
    };
  }

  // \usepackage{...
  const pkg = ctx.matchBefore(/\\usepackage(?:\[[^\]]*\])?\{[A-Za-z0-9,\s-]*/);
  if (pkg) {
    const afterBrace = pkg.text.slice(pkg.text.indexOf("{") + 1);
    const lastComma = afterBrace.lastIndexOf(",");
    return {
      from: pkg.from + pkg.text.indexOf("{") + 1 + lastComma + 1,
      options: plainNames(cfg.config.packages, "namespace"),
      validFor: /^[A-Za-z0-9-]*$/,
    };
  }

  // A command (\fr...), or a word that might be a snippet trigger (prob, vv, ...).
  // Backslash entries only appear once a backslash has been typed, so ordinary words don't pop up LaTeX.
  const token = ctx.matchBefore(/\\?[A-Za-z][A-Za-z0-9_*]*|\\/);
  if (!token || (token.from === token.to && !ctx.explicit)) return null;
  const options = token.text.startsWith("\\") ? [...cfg.plain, ...cfg.backslash] : cfg.plain;
  return { from: token.from, options, validFor: /^\\?[A-Za-z0-9_*]*$/ };
}
