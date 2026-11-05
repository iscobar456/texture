import { invoke } from "@tauri-apps/api/core";
import type { Text } from "@codemirror/state";

// LaTeX formatting is done by the `tex-fmt` crate on the Rust side (`format_tex` in lib.rs). This file asks for
// the formatted text and turns the difference into small edits, so the cursor stays on its text and the whole
// thing is one undo step.

export type FormatOptions = { wrap: boolean; wrapLen: number; indent: "2" | "4" | "tab" };

export type Edit = { from: number; to: number; insert: string };
export type DocFormat = { ok: true; edits: Edit[]; changedLines: number } | { ok: false; error: string };

/** Longest middle section (old lines x new lines) that gets an exact line diff; beyond it one replacement is used. */
const MAX_CELLS = 4_000_000;

/** Line ranges that differ: old lines [a, b) become new lines [c, d). */
type Hunk = { a: number; b: number; c: number; d: number };

function diffLines(oldLines: string[], newLines: string[]): Hunk[] {
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) { endOld--; endNew--; }
  if (start === endOld && start === endNew) return [];

  const n = endOld - start;
  const m = endNew - start;
  if (n * m > MAX_CELLS) return [{ a: start, b: endOld, c: start, d: endNew }];

  // Longest common subsequence of the middle, so unchanged lines in between are left alone.
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = oldLines[start + i] === newLines[start + j]
        ? lcs[(i + 1) * w + j + 1] + 1
        : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let open: Hunk | null = null;
  const close = () => { if (open) { hunks.push(open); open = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && oldLines[start + i] === newLines[start + j]) {
      close();
      i++; j++;
    } else {
      open ??= { a: start + i, b: start + i, c: start + j, d: start + j };
      if (j < m && (i === n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) { j++; open.d = start + j; }
      else { i++; open.b = start + i; }
    }
  }
  close();
  return hunks;
}

/**
 * Formats a CodeMirror document and returns the edits to apply (none if it is already formatted).
 * Fails with tex-fmt's message when the text does not balance.
 */
export async function formatDoc(doc: Text, opts: FormatOptions): Promise<DocFormat> {
  const before = doc.toString();
  let after: string;
  try {
    after = await invoke<string>("format_tex", { text: before, wrap: opts.wrap, wraplen: opts.wrapLen, indent: opts.indent });
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  if (after === before) return { ok: true, edits: [], changedLines: 0 };

  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  const edits: Edit[] = [];
  let changed = 0;
  for (const h of diffLines(oldLines, newLines)) {
    const fresh = newLines.slice(h.c, h.d);
    changed += Math.max(h.b - h.a, h.d - h.c);
    if (h.b > h.a) {
      const first = doc.line(h.a + 1);
      const last = doc.line(h.b);
      if (fresh.length) {
        edits.push({ from: first.from, to: last.to, insert: fresh.join("\n") });
      } else if (h.b < doc.lines) {
        edits.push({ from: first.from, to: last.to + 1, insert: "" }); // takes its newline with it
      } else {
        edits.push({ from: Math.max(0, first.from - 1), to: last.to, insert: "" });
      }
    } else if (h.a < doc.lines) {
      const at = doc.line(h.a + 1).from;
      edits.push({ from: at, to: at, insert: fresh.join("\n") + "\n" });
    } else {
      edits.push({ from: doc.length, to: doc.length, insert: "\n" + fresh.join("\n") });
    }
  }
  return { ok: true, edits, changedLines: changed };
}
