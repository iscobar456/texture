import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// Colors are CSS variables set by the active theme and mode (palettes in styles.css), so the editor follows them live.
export const softTheme = EditorView.theme({
  "&": { color: "var(--cm-fg)", backgroundColor: "var(--cm-bg)" },
  ".cm-content": { caretColor: "var(--cm-fg)" },
  ".cm-cursor": { borderLeftColor: "var(--cm-fg)" },
  ".cm-gutters": { backgroundColor: "var(--cm-bg)", color: "var(--cm-muted)", border: "none" },
  ".cm-activeLine": { backgroundColor: "var(--cm-line)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--cm-line)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--cm-select) !important",
  },
});

export const softHighlight = HighlightStyle.define([
  // In LaTeX (stex mode): tagName = commands, keyword = math delimiters ($, \[ \]), atom = arguments of \begin,
  // \label, \ref, \cite… (and digits in text), number = digits in math. --cm-math and --cm-arg are optional per
  // theme; a theme that leaves them out keeps one color for commands and delimiters, and one for atoms and numbers.
  { tag: t.tagName, color: "var(--cm-keyword)" },
  { tag: t.keyword, color: "var(--cm-math, var(--cm-keyword))" },
  { tag: t.atom, color: "var(--cm-arg, var(--cm-number))" },
  { tag: [t.number, t.bool], color: "var(--cm-number)" },
  { tag: [t.string, t.special(t.string)], color: "var(--cm-string)" },
  { tag: [t.bracket, t.punctuation, t.operator], color: "var(--cm-muted)" },
  { tag: t.comment, color: "var(--cm-comment)", fontStyle: "italic" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "var(--cm-var)" },
]);
