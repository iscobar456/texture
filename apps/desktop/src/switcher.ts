const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type Entry = { path: string };

/** A match of `query` against `path`: which characters matched, and a score (higher is better). */
type Match = { score: number; hits: Set<number> };

/**
 * Subsequence match, case-insensitive. Rewards matching inside the file name (the last path segment),
 * the start of a word, and runs of consecutive characters; a match that must reach into the folder
 * part scores lower than one that fits in the name.
 */
export function fuzzy(query: string, path: string): Match | null {
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  const nameStart = path.lastIndexOf("/") + 1;

  const run = (from: number): Match | null => {
    const hits = new Set<number>();
    let score = 0;
    let pos = from;
    let prev = -2;
    for (const ch of q) {
      if (ch === " ") continue;
      const i = p.indexOf(ch, pos);
      if (i < 0) return null;
      const boundary = i === 0 || /[\s/_\-.]/.test(path[i - 1]);
      score += 1 + (i === prev + 1 ? 5 : 0) + (boundary ? 6 : 0);
      hits.add(i);
      prev = i;
      pos = i + 1;
    }
    return { score, hits };
  };

  const inName = run(nameStart);
  if (inName) return { score: inName.score + 40 + (p.startsWith(q, nameStart) ? 30 : 0) - (path.length - nameStart) * 0.05, hits: inName.hits };
  const anywhere = run(0);
  return anywhere ? { score: anywhere.score - path.length * 0.05, hits: anywhere.hits } : null;
}

type Row =
  | { kind: "doc"; path: string; hits: Set<number>; tag: string }
  | { kind: "create"; path: string };

/** Splits a path into a folder part ("A / B / ") and a name, as the document button does. */
export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i).split("/").join(" / ") + " / ", name: path.slice(i + 1) };
}

/**
 * Ctrl+P: type a few letters of a document's name and press Enter. With nothing typed, recent documents come
 * first. If nothing matches exactly, the last row offers to create it.
 */
export function initSwitcher(deps: {
  docs: () => Promise<Entry[]>;
  /** Most recent first. */
  recents: () => string[];
  current: () => string;
  open: (path: string) => Promise<void>;
  create: (path: string) => Promise<void>;
}) {
  const dialog = $<HTMLDialogElement>("switcher");
  const input = $<HTMLInputElement>("switcher-input");
  const list = $("switcher-list");
  const errorEl = $("switcher-error");
  let all: string[] = [];
  let rows: Row[] = [];
  let selected = 0;

  function compute() {
    const q = input.value.trim();
    const recents = deps.recents();
    const rank = (p: string) => {
      const i = recents.indexOf(p);
      return i < 0 ? 1e6 : i;
    };
    rows = [];
    if (!q) {
      const sorted = [...all].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, undefined, { sensitivity: "base" }));
      for (const p of sorted) rows.push({ kind: "doc", path: p, hits: new Set(), tag: p === deps.current() ? "open now" : rank(p) < 1e6 ? "recent" : "" });
    } else {
      const scored: { path: string; m: Match }[] = [];
      for (const p of all) {
        const m = fuzzy(q, p);
        if (m) scored.push({ path: p, m });
      }
      // Recency breaks near-ties, so the document you were just in wins over an equal match.
      scored.sort((a, b) => b.m.score - a.m.score || rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
      for (const s of scored) rows.push({ kind: "doc", path: s.path, hits: s.m.hits, tag: s.path === deps.current() ? "open now" : "" });
      if (!all.some((p) => p.toLowerCase() === q.toLowerCase())) rows.push({ kind: "create", path: q });
    }
    selected = Math.min(selected, Math.max(0, rows.length - 1));
  }

  function render() {
    errorEl.textContent = "";
    const els = rows.map((r, i) => {
      const el = document.createElement("div");
      el.setAttribute("role", "option");
      el.setAttribute("aria-selected", String(i === selected));
      el.id = `sw-${i}`;
      if (r.kind === "create") {
        const label = document.createElement("span");
        label.className = "sw-name";
        label.textContent = `New document “${r.path}”`;
        const tag = document.createElement("span");
        tag.className = "sw-tag";
        tag.textContent = "create";
        el.append(label, tag);
      } else {
        const { name } = splitPath(r.path);
        const offset = r.path.length - name.length; // hit indices are over the full path
        const nameEl = document.createElement("span");
        nameEl.className = "sw-name";
        const dirEl = document.createElement("span");
        dirEl.className = "sw-dir";
        // Appends `text` one character at a time, wrapping matched characters (by index into the full path) in <mark>.
        const paint = (parent: HTMLElement, text: string, start: number) => {
          for (let k = 0; k < text.length; k++) {
            if (!r.hits.has(start + k)) {
              parent.append(text[k]);
              continue;
            }
            const m = document.createElement("mark");
            m.textContent = text[k];
            parent.append(m);
          }
        };
        paint(nameEl, name, offset);
        // The folder part is shown as "A / B": walk the raw path so highlights stay aligned with the "/" separators.
        const rawDir = r.path.slice(0, Math.max(0, offset - 1));
        for (let k = 0; k < rawDir.length; k++) {
          if (rawDir[k] === "/") dirEl.append(" / ");
          else paint(dirEl, rawDir[k], k);
        }
        if (!rawDir) dirEl.hidden = true;
        el.append(nameEl, dirEl);
        if (r.tag) {
          const tag = document.createElement("span");
          tag.className = "sw-tag";
          tag.textContent = r.tag;
          el.append(tag);
        }
      }
      el.addEventListener("mousemove", () => select(i, false));
      el.addEventListener("click", () => void choose(i));
      return el;
    });
    list.replaceChildren(...els);
    if (!els.length) {
      const empty = document.createElement("div");
      empty.className = "sw-empty";
      empty.textContent = "No documents yet. Type a name to create one.";
      list.append(empty);
    }
    input.setAttribute("aria-activedescendant", els[selected]?.id ?? "");
    els[selected]?.scrollIntoView({ block: "nearest" });
  }

  function select(i: number, scroll = true) {
    if (i === selected || !rows.length) return;
    selected = i;
    list.querySelectorAll('[role="option"]').forEach((el, k) => el.setAttribute("aria-selected", String(k === i)));
    input.setAttribute("aria-activedescendant", `sw-${i}`);
    if (scroll) document.getElementById(`sw-${i}`)?.scrollIntoView({ block: "nearest" });
  }

  async function choose(i: number) {
    const r = rows[i];
    if (!r) return;
    try {
      if (r.kind === "create") await deps.create(r.path);
      else await deps.open(r.path);
      dialog.close();
    } catch (e) {
      errorEl.textContent = String((e as Error)?.message ?? e);
    }
  }

  input.addEventListener("input", () => {
    selected = 0;
    compute();
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); select(Math.min(rows.length - 1, selected + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); select(Math.max(0, selected - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); void choose(selected); }
  });

  return {
    async open() {
      all = (await deps.docs()).map((d) => d.path);
      input.value = "";
      selected = 0;
      compute();
      render();
      dialog.showModal();
      input.focus();
    },
  };
}
