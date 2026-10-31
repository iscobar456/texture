import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// Colors are CSS variables (defined in styles.css) so light/dark follows the OS.
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
  { tag: [t.keyword, t.tagName], color: "var(--cm-keyword)" },
  { tag: [t.atom, t.number, t.bool], color: "var(--cm-number)" },
  { tag: [t.string, t.special(t.string)], color: "var(--cm-string)" },
  { tag: [t.bracket, t.punctuation, t.operator], color: "var(--cm-muted)" },
  { tag: t.comment, color: "var(--cm-comment)", fontStyle: "italic" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "var(--cm-var)" },
]);
