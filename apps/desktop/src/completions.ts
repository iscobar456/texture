import {
  snippet,
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { Prec, type Extension } from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";
import { getCM } from "@replit/codemirror-vim";

// ---- user snippets ----

/**
 * A user-defined autocomplete and/or keyboard shortcut.
 * `body` uses CodeMirror snippet syntax: `#{}` (or `${}`) is a tab stop, `#{text}` a tab stop with
 * placeholder text, and `#{1}` repeated mirrors one value into several places.
 */
export type UserSnippet = {
  id: string;
  /** Typed to trigger the completion, e.g. "vv" or "\vv". Optional if there is a shortcut. */
  trigger: string;
  description: string;
  /** CodeMirror key name, e.g. "Mod-Alt-m". Optional if there is a trigger. */
  shortcut: string;
  body: string;
};

// Per-device, like the other settings.
const KEY = "hwscan:snippets";
let user: UserSnippet[] = [];

export function loadSnippets(): UserSnippet[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (Array.isArray(parsed)) {
      user = parsed.filter((s) => s && typeof s.id === "string" && typeof s.body === "string");
    }
  } catch {}
  return user;
}

export function saveSnippets(list: UserSnippet[]) {
  user = list;
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {}
}

export const userSnippets = () => user;

/** Triggers must be matchable by the completion source: an optional backslash, then letters/digits. */
export const TRIGGER_RE = /^\\?[A-Za-z][A-Za-z0-9]*$/;

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

/** Keymap for the user's shortcuts. Highest precedence so it beats the Vim extension. */
export function snippetKeymap(list: UserSnippet[]): Extension {
  return Prec.highest(
    keymap.of(
      list
        .filter((s) => s.shortcut)
        .map((s) => ({
          key: s.shortcut,
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
}

/** Reserved for the app; a snippet may not take these. */
export const RESERVED_KEYS = ["Mod-Enter"];

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
  // A bare letter would hijack typing, so require Ctrl/Alt (or an F-key).
  if (!mods.some((m) => m !== "Shift") && !/^F\d+$/.test(k)) return null;
  return [...mods, k].join("-");
}

export const showKey = (key: string) => key.replace("Mod", navigator.platform.includes("Mac") ? "⌘" : "Ctrl");

// ---- built-in LaTeX completions ----

const words = (list: string, type: string, detail?: string): Completion[] =>
  list.trim().split(/\s+/).map((w) => ({ label: `\\${w}`, type, detail }));

// Commands that are inserted as-is.
const PLAIN: Completion[] = [
  ...words(
    "alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega",
    "constant",
    "Greek letter",
  ),
  ...words(
    "infty partial nabla forall exists nexists emptyset in notin ni subset subseteq supset supseteq cup cap setminus times cdot pm mp leq geq neq approx equiv sim simeq cong propto ll gg to rightarrow Rightarrow leftarrow Leftarrow leftrightarrow Leftrightarrow mapsto implies impliedby iff ldots cdots vdots ddots angle perp parallel circ bullet oplus otimes wedge vee neg land lor therefore because hbar ell Re Im aleph prime",
    "keyword",
    "symbol",
  ),
  ...words(
    "sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh log ln exp lim limsup liminf max min sup inf det dim ker gcd deg arg Pr",
    "function",
    "operator",
  ),
  ...words("sum int iint iiint oint prod coprod bigcup bigcap bigoplus", "keyword", "big operator"),
  ...words("quad qquad hspace vspace newline newpage noindent centering maketitle tableofcontents item hline", "keyword"),
  { label: "\\\\", type: "keyword", detail: "line break" },
];

// Commands that insert a template with tab stops (#{} jumps with Tab).
const TEMPLATED: [label: string, template: string, detail?: string][] = [
  ["\\frac", "\\frac{#{}}{#{}}", "fraction"],
  ["\\dfrac", "\\dfrac{#{}}{#{}}", "display fraction"],
  ["\\sqrt", "\\sqrt{#{}}", "square root"],
  ["\\binom", "\\binom{#{}}{#{}}", "binomial"],
  ["\\text", "\\text{#{}}", "text in math"],
  ["\\mathbb", "\\mathbb{#{}}"],
  ["\\mathcal", "\\mathcal{#{}}"],
  ["\\mathbf", "\\mathbf{#{}}"],
  ["\\mathrm", "\\mathrm{#{}}"],
  ["\\vec", "\\vec{#{}}"],
  ["\\hat", "\\hat{#{}}"],
  ["\\bar", "\\bar{#{}}"],
  ["\\tilde", "\\tilde{#{}}"],
  ["\\dot", "\\dot{#{}}"],
  ["\\ddot", "\\ddot{#{}}"],
  ["\\overline", "\\overline{#{}}"],
  ["\\underline", "\\underline{#{}}"],
  ["\\textbf", "\\textbf{#{}}"],
  ["\\textit", "\\textit{#{}}"],
  ["\\emph", "\\emph{#{}}"],
  ["\\section", "\\section{#{}}"],
  ["\\subsection", "\\subsection{#{}}"],
  ["\\subsubsection", "\\subsubsection{#{}}"],
  ["\\label", "\\label{#{}}"],
  ["\\ref", "\\ref{#{}}"],
  ["\\eqref", "\\eqref{#{}}"],
  ["\\cite", "\\cite{#{}}"],
  ["\\usepackage", "\\usepackage{#{}}"],
  ["\\includegraphics", "\\includegraphics[width=#{0.8}\\linewidth]{#{}}", "image"],
  ["\\left", "\\left#{(} #{} \\right#{)}", "auto-sizing delimiters"],
  ["\\begin", "\\begin{#{}}\n\t#{}\n\\end{#{}}", "environment"],
  ["\\sum_", "\\sum_{#{i=1}}^{#{n}} #{}", "sum with limits"],
  ["\\int_", "\\int_{#{a}}^{#{b}} #{} \\, d#{x}", "definite integral"],
  ["\\lim_", "\\lim_{#{x \\to \\infty}} #{}", "limit"],
  ["\\prod_", "\\prod_{#{i=1}}^{#{n}} #{}", "product with limits"],
  ["\\partial_", "\\frac{\\partial #{f}}{\\partial #{x}}", "partial derivative"],
];

const ENVIRONMENTS =
  "document equation equation* align align* aligned gather gather* multline split cases matrix pmatrix bmatrix vmatrix Vmatrix array itemize enumerate description center figure table tabular theorem lemma proof definition remark example verbatim minipage abstract".split(
    " ",
  );

const PACKAGES =
  "amsmath amssymb amsthm graphicx geometry hyperref tikz pgfplots siunitx physics mathtools enumitem xcolor booktabs fancyhdr listings cancel bm float caption subcaption setspace array multirow url cleveref microtype fontenc inputenc lmodern".split(
    " ",
  );

// Plain-word snippets (no backslash), for things you type constantly.
const WORD_SNIPPETS: [label: string, template: string, detail: string][] = [
  ["prob", "\\section*{Problem #{1}}\n#{}", "problem heading"],
  ["sol", "\\begin{proof}[Solution]\n\t#{}\n\\end{proof}", "solution block"],
  ["ali", "\\begin{align*}\n\t#{} &= #{} \\\\\n\t&= #{}\n\\end{align*}", "aligned equations"],
  ["fig", "\\begin{figure}[h]\n\t\\centering\n\t\\includegraphics[width=#{0.8}\\linewidth]{#{}}\n\t\\caption{#{}}\n\\end{figure}", "figure"],
  ["mat", "\\begin{pmatrix}\n\t#{} & #{} \\\\\n\t#{} & #{}\n\\end{pmatrix}", "2×2 matrix"],
  ["cas", "\\begin{cases}\n\t#{} & \\text{if } #{} \\\\\n\t#{} & \\text{otherwise}\n\\end{cases}", "cases"],
];

const templated = TEMPLATED.map(([label, tpl, detail]) =>
  snippetCompletion(tpl, { label, type: "function", detail }),
);
const wordSnips = WORD_SNIPPETS.map(([label, tpl, detail]) =>
  snippetCompletion(tpl, { label, type: "text", detail, boost: 2 }),
);

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

function userCompletions(): Completion[] {
  return user
    .filter((s) => s.trigger)
    .map((s) =>
      snippetCompletion(s.body, {
        label: s.trigger,
        type: "text",
        detail: s.description || "my snippet",
        boost: 3, // yours come first
      }),
    );
}

/** The one completion source for LaTeX; registered through EditorState.languageData. */
export function latexSource(ctx: CompletionContext): CompletionResult | null {
  // \begin{...  /  \end{...
  const env = ctx.matchBefore(/\\(begin|end)\{[A-Za-z*]*/);
  if (env) {
    const isBegin = env.text.startsWith("\\begin");
    return {
      from: env.from + env.text.indexOf("{") + 1,
      options: isBegin ? ENVIRONMENTS.map(beginEnvironment) : plainNames(ENVIRONMENTS, "class"),
      validFor: /^[A-Za-z*]*$/,
    };
  }

  // \ref{...  and friends
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
      options: plainNames(PACKAGES, "namespace"),
      validFor: /^[A-Za-z0-9-]*$/,
    };
  }

  // A command (\fr...), or a word that might be a snippet trigger (prob, vv, ...).
  const token = ctx.matchBefore(/\\?[A-Za-z][A-Za-z0-9]*|\\/);
  if (!token || (token.from === token.to && !ctx.explicit)) return null;
  const options = [...userCompletions(), ...wordSnips];
  if (token.text.startsWith("\\")) options.push(...templated, ...PLAIN);
  return { from: token.from, options, validFor: /^\\?[A-Za-z0-9]*$/ };
}
