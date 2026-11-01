import type { Text } from "@codemirror/state";

// A conservative LaTeX formatter. It only ever changes whitespace: indentation, trailing spaces and runs of
// blank lines. It never joins, splits or wraps lines, and it refuses to touch a document whose braces or
// environments do not balance (indenting those would just spread the confusion).

const INDENT = 2;
/** Environments whose contents are not indented (nearly everything lives inside `document`). */
const FLAT_ENVS = new Set(["document"]);
/** Environments whose contents are left exactly as written. */
const VERBATIM_ENVS = new Set(["verbatim", "verbatim*", "Verbatim", "lstlisting", "minted", "comment", "alltt", "filecontents", "filecontents*"]);

type Env = { name: string; counted: boolean; line: number };

export type FormatResult = { ok: true; lines: (string | null)[] } | { ok: false; error: string };

/** What one line does to the nesting. `min` is how far below its starting depth the line dips (so a line that
 *  starts with `\end{…}` or `}` dedents itself). */
type Scan = { delta: number; min: number; verbatim: string | null; error?: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Walks one line, ignoring comments, escaped characters (\{ \% ...) and \verb|...|, and applies
 * \begin/\end and braces to `stack` / the running brace count.
 */
function scan(line: string, lineNo: number, stack: Env[]): Scan {
  let running = 0;
  let min = 0;
  let verbatim: string | null = null;
  const step = (d: number) => {
    running += d;
    if (running < min) min = running;
  };

  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "%") break;
    if (c === "{") {
      step(1);
      i++;
    } else if (c === "}") {
      step(-1);
      i++;
    } else if (c !== "\\") {
      i++;
    } else {
      const word = /^\\([A-Za-z@]+)\*?/.exec(line.slice(i));
      if (!word) {
        i += 2; // a control symbol such as \{ \} \% \\ \[ \]
        continue;
      }
      i += word[0].length;
      const name = word[1];
      if (name === "verb") {
        const delim = line[i];
        if (delim) {
          const end = line.indexOf(delim, i + 1);
          i = end < 0 ? line.length : end + 1;
        }
      } else if (name === "begin" || name === "end") {
        const arg = /^\s*\{([^}]*)\}/.exec(line.slice(i));
        if (!arg) continue; // \begin with the name on another line: leave it alone
        i += arg[0].length;
        const env = arg[1];
        if (name === "begin") {
          const counted = !FLAT_ENVS.has(env);
          stack.push({ name: env, counted, line: lineNo });
          if (counted) step(1);
          if (VERBATIM_ENVS.has(env)) {
            verbatim = env;
            break; // the rest of this line, and the lines after it, are literal
          }
        } else {
          const top = stack.pop();
          if (!top) return { delta: running, min, verbatim, error: `line ${lineNo}: \\end{${env}} has no matching \\begin` };
          if (top.name !== env) {
            return { delta: running, min, verbatim, error: `line ${lineNo}: \\end{${env}} closes \\begin{${top.name}} from line ${top.line}` };
          }
          if (top.counted) step(-1);
        }
      }
    }
  }
  return { delta: running, min, verbatim };
}

/**
 * Formats the lines of a document (without the final newline). Each result is the new text of that line, or
 * null if the line is to be removed (an extra blank line).
 */
export function formatLines(lines: string[]): FormatResult {
  const out: (string | null)[] = [];
  const stack: Env[] = [];
  let depth = 0; // open braces plus indenting environments, before the current line
  let verbatim: { name: string; line: number } | null = null;
  let keptAny = false;
  let prevBlank = false;

  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    const lineNo = n + 1;

    if (verbatim) {
      out.push(raw); // untouched, trailing whitespace included
      keptAny = true;
      prevBlank = false;
      if (new RegExp(`\\\\end\\s*\\{${escapeRe(verbatim.name)}\\}`).test(raw)) {
        const top = stack.pop();
        if (top?.counted) depth = Math.max(0, depth - 1);
        verbatim = null;
      }
      continue;
    }

    if (raw.trim() === "") {
      // Blank lines: none at the very start, never two in a row.
      if (!keptAny || prevBlank) out.push(null);
      else out.push("");
      prevBlank = keptAny;
      continue;
    }

    const s = scan(raw, lineNo, stack);
    if (s.error) return { ok: false, error: s.error };
    const level = Math.max(0, depth + s.min);
    if (depth + s.delta < 0) return { ok: false, error: `line ${lineNo}: a closing brace } has no matching {` };

    const content = raw.trim();
    if (s.verbatim) {
      const begin = new RegExp(`\\\\begin\\s*\\{${escapeRe(s.verbatim)}\\}\\s*$`);
      // Text after \begin{verbatim} on the same line is literal, so such a line is left exactly as written.
      out.push(begin.test(content) ? " ".repeat(INDENT * level) + content : raw);
      verbatim = { name: s.verbatim, line: lineNo };
    } else {
      out.push(" ".repeat(INDENT * level) + content);
    }
    depth += s.delta;
    keptAny = true;
    prevBlank = false;
  }

  if (verbatim) return { ok: false, error: `\\begin{${verbatim.name}} on line ${verbatim.line} is never closed` };
  if (stack.length) {
    const open = stack[stack.length - 1];
    return { ok: false, error: `\\begin{${open.name}} on line ${open.line} is never closed` };
  }
  if (depth !== 0) return { ok: false, error: `${depth} opening brace${depth === 1 ? "" : "s"} { never closed` };

  // Blank lines at the end of the document go too.
  for (let i = out.length - 1; i >= 0 && (out[i] === "" || out[i] === null); i--) out[i] = null;
  return { ok: true, lines: out };
}

export type Edit = { from: number; to: number; insert: string };
export type DocFormat = { ok: true; edits: Edit[]; changedLines: number } | { ok: false; error: string };

/**
 * Formats a CodeMirror document and returns the edits to apply, so the cursor and the undo history behave
 * (one undo step, cursor kept in place). The document always ends with exactly one newline afterwards.
 */
export function formatDoc(doc: Text): DocFormat {
  const text = doc.toString();
  const terminated = text.endsWith("\n"); // the last document line is then an empty terminator
  const count = terminated ? doc.lines - 1 : doc.lines;
  if (count <= 0) return { ok: true, edits: [], changedLines: 0 };

  const content: string[] = [];
  for (let i = 1; i <= count; i++) content.push(doc.line(i).text);
  const res = formatLines(content);
  if (!res.ok) return res;

  // Safety net: formatting may only change whitespace.
  const formatted = res.lines.filter((l): l is string => l !== null).join("\n");
  if (formatted.replace(/\s+/g, "") !== content.join("\n").replace(/\s+/g, "")) {
    return { ok: false, error: "internal check failed (the text would have changed); nothing was modified" };
  }

  // Nothing but blank lines: the result is an empty document, not a lone newline.
  if (!res.lines.some((l) => l !== null && l !== "")) {
    return { ok: true, edits: doc.length ? [{ from: 0, to: doc.length, insert: "" }] : [], changedLines: doc.length ? count : 0 };
  }

  const edits: Edit[] = [];
  let changed = 0;
  let i = 0;
  while (i < count) {
    const r = res.lines[i];
    const line = doc.line(i + 1);
    if (r === null) {
      // A run of removed lines becomes one deletion that takes their newlines with it.
      let j = i;
      while (j + 1 < count && res.lines[j + 1] === null) j++;
      const first = doc.line(i + 1);
      const last = doc.line(j + 1);
      const toEnd = j + 1 >= doc.lines; // no newline follows the run: take the one before it instead
      edits.push(
        toEnd
          ? { from: Math.max(0, first.from - 1), to: last.to, insert: terminated ? "" : "\n" }
          : { from: first.from, to: last.to + 1, insert: "" },
      );
      changed += j - i + 1;
      i = j + 1;
      continue;
    }
    if (r !== line.text) {
      const trimmed = line.text.trim();
      if (trimmed && r.endsWith(trimmed) && r.trimStart() === trimmed) {
        // Only the margins change, so edit only the margins: a cursor inside the text then stays on its text.
        const lead = line.text.length - line.text.trimStart().length;
        const trail = line.text.length - line.text.trimEnd().length;
        const indent = r.length - trimmed.length;
        if (indent !== lead || line.text.slice(0, lead) !== " ".repeat(indent)) {
          edits.push({ from: line.from, to: line.from + lead, insert: " ".repeat(indent) });
        }
        if (trail) edits.push({ from: line.to - trail, to: line.to, insert: "" });
      } else {
        edits.push({ from: line.from, to: line.to, insert: r });
      }
      changed++;
    }
    i++;
  }
  // A document that did not end with a newline gets one (unless a deletion above already supplied it).
  if (!terminated && !edits.some((e) => e.to === doc.length && e.insert.endsWith("\n"))) {
    edits.push({ from: doc.length, to: doc.length, insert: "\n" });
    changed++;
  }
  return { ok: true, edits, changedLines: changed };
}
