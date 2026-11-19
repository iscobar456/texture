/** A problem found in the engine's output. `line` is a 1-based line of main.tex, when the engine named one. */
export type CompileError = { line: number | null; message: string };

/**
 * Picks the errors out of a compile log so they can be shown as a short, clickable list above the raw text.
 * Understands tectonic ("error: main.tex:12: Undefined control sequence") and pdflatex ("! Undefined control
 * sequence." followed, a few lines later, by "l.12 ..."). Anything else is simply not listed; the full log is
 * always shown as well.
 */
export function parseCompileErrors(log: string): CompileError[] {
  const out: CompileError[] = [];
  const seen = new Set<string>();
  const add = (line: number | null, message: string) => {
    const m = message.trim().replace(/\.$/, "");
    const key = `${line}:${m}`;
    if (!m || seen.has(key)) return;
    seen.add(key);
    out.push({ line, message: m });
  };
  const lines = log.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const tectonic = /^error: (?:\.\/)?main\.tex:(\d+): (.*)$/.exec(lines[i]);
    if (tectonic) {
      add(Number(tectonic[1]), tectonic[2]);
      continue;
    }
    const tex = /^! (.+)$/.exec(lines[i]);
    if (tex) {
      // The line number follows within the next few lines of context, if at all.
      let line: number | null = null;
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        if (lines[j].startsWith("! ")) break;
        const at = /^l\.(\d+)\b/.exec(lines[j]);
        if (at) {
          line = Number(at[1]);
          break;
        }
      }
      add(line, tex[1]);
    }
  }
  return out;
}
