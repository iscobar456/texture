import { parse } from "smol-toml";
import { snippetCompletion, type Completion } from "@codemirror/autocomplete";
import defaultToml from "./default-snippets.toml?raw";

/** The file shipped with the app. Users own their copy; this is only what a fresh account starts from. */
export const DEFAULT_SNIPPETS_TOML: string = defaultToml;

/** Name of the synced config file that holds the snippets (stored as snippets.toml on disk). */
export const SNIPPETS_CONFIG = "snippets";

export type SnippetDef = { trigger: string; body: string; description: string; key: string; group: string };
export type WordGroup = { name: string; prefix: string; detail: string; words: string[] };
export type Config = { snippets: SnippetDef[]; words: WordGroup[]; environments: string[]; packages: string[] };

/** What the editor runs on: the config turned into completion options and key bindings. */
export type Compiled = {
  config: Config;
  /** Suggested whenever a word is being typed. */
  plain: Completion[];
  /** Labels that start with a backslash: only suggested once a backslash has been typed. */
  backslash: Completion[];
  keys: { key: string; body: string; label: string }[];
};

/** Triggers are typed, so they must be something the completion source can match as one token. */
export const TRIGGER_RE = /^\\?[A-Za-z][A-Za-z0-9_*]*$/;
const WORD_RE = /^[A-Za-z][A-Za-z0-9]*$/;
/** Reserved for the app; a snippet may not take these. */
export const RESERVED_KEYS = ["Mod-Enter"];

const MODIFIERS = ["Mod", "Ctrl", "Alt", "Shift", "Meta"];

/** CodeMirror key names: zero or more modifiers, then one key. Plain letters would hijack typing. */
function keyProblem(key: string): string | null {
  const parts = key.split("-");
  const name = key.endsWith("--") ? "-" : parts[parts.length - 1];
  const mods = key.endsWith("--") ? parts.slice(0, -2) : parts.slice(0, -1);
  if (!name) return "has no key after the last '-'";
  const bad = mods.find((m) => !MODIFIERS.includes(m));
  if (bad) return `unknown modifier '${bad}' (use Mod, Ctrl, Alt, Shift or Meta)`;
  if (!mods.some((m) => m !== "Shift") && !/^F\d+$/.test(name)) return "needs Ctrl, Alt or Mod (a bare key would take over typing)";
  return null;
}

const empty = (): Config => ({ snippets: [], words: [], environments: [], packages: [] });

const isTable = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Accepts 'a b c' or ['a', 'b', 'c']. */
function names(v: unknown, where: string, errors: string[], re: RegExp): string[] {
  const raw = typeof v === "string" ? v.split(/\s+/).filter(Boolean) : Array.isArray(v) ? v : null;
  if (!raw) {
    errors.push(`${where}: expected words separated by spaces, or a list of strings`);
    return [];
  }
  const out: string[] = [];
  for (const w of raw) {
    if (typeof w !== "string" || !re.test(w)) errors.push(`${where}: '${String(w)}' is not a valid name`);
    else out.push(w);
  }
  return out;
}

export type ParseResult = { config: Config | null; errors: string[] };

/** Parses and validates the snippets file. On any error `config` is null and every problem is listed. */
export function parseSnippets(text: string): ParseResult {
  let doc: Record<string, unknown>;
  try {
    doc = parse(text);
  } catch (e) {
    const err = e as { message?: string; line?: number; column?: number };
    const where = err.line ? ` (line ${err.line}${err.column ? `, column ${err.column}` : ""})` : "";
    return { config: null, errors: [`TOML syntax error${where}: ${(err.message ?? String(e)).split("\n")[0]}`] };
  }

  const errors: string[] = [];
  const cfg = empty();
  const known = ["snippet", "words", "environments", "packages"];
  for (const k of Object.keys(doc)) if (!known.includes(k)) errors.push(`Unknown section '${k}' (expected ${known.join(", ")})`);

  const triggers = new Set<string>();
  const keys = new Set<string>();

  const snippets = doc.snippet ?? [];
  if (!Array.isArray(snippets)) errors.push("'snippet' must be written as [[snippet]] blocks");
  else
    snippets.forEach((s, i) => {
      const where = `[[snippet]] #${i + 1}${isTable(s) && typeof s.trigger === "string" ? ` (${s.trigger})` : ""}`;
      if (!isTable(s)) return errors.push(`${where}: expected a table`);
      for (const k of Object.keys(s))
        if (!["trigger", "body", "description", "key", "group"].includes(k)) errors.push(`${where}: unknown field '${k}'`);
      const str = (f: string) => (s[f] === undefined ? "" : typeof s[f] === "string" ? (s[f] as string) : (errors.push(`${where}: '${f}' must be a string`), ""));
      const def: SnippetDef = { trigger: str("trigger"), body: str("body"), description: str("description"), key: str("key"), group: str("group") };
      if (!def.body) errors.push(`${where}: needs a non-empty 'body'`);
      if (!def.trigger && !def.key) errors.push(`${where}: needs a 'trigger', a 'key', or both`);
      if (def.trigger) {
        if (!TRIGGER_RE.test(def.trigger)) errors.push(`${where}: trigger must be letters/digits (optionally _ or *), optionally starting with a backslash`);
        else if (triggers.has(def.trigger)) errors.push(`${where}: trigger '${def.trigger}' is already used by another snippet`);
        triggers.add(def.trigger);
      }
      if (def.key) {
        const problem = keyProblem(def.key);
        if (problem) errors.push(`${where}: key '${def.key}' ${problem}`);
        else if (RESERVED_KEYS.includes(def.key)) errors.push(`${where}: key '${def.key}' is used by the app (Compile)`);
        else if (keys.has(def.key)) errors.push(`${where}: key '${def.key}' is already used by another snippet`);
        keys.add(def.key);
      }
      cfg.snippets.push(def);
    });

  const words = doc.words ?? [];
  if (!Array.isArray(words)) errors.push("'words' must be written as [[words]] blocks");
  else
    words.forEach((w, i) => {
      const where = `[[words]] #${i + 1}${isTable(w) && typeof w.name === "string" ? ` (${w.name})` : ""}`;
      if (!isTable(w)) return errors.push(`${where}: expected a table`);
      for (const k of Object.keys(w)) if (!["name", "list", "prefix", "detail"].includes(k)) errors.push(`${where}: unknown field '${k}'`);
      cfg.words.push({
        name: typeof w.name === "string" && w.name ? w.name : "Commands",
        prefix: typeof w.prefix === "string" ? w.prefix : "\\",
        detail: typeof w.detail === "string" ? w.detail : "",
        words: names(w.list, `${where} list`, errors, WORD_RE),
      });
    });

  for (const [section, target] of [["environments", "environments"], ["packages", "packages"]] as const) {
    const v = doc[section];
    if (v === undefined) continue;
    if (!isTable(v)) errors.push(`[${section}] must be a table with a 'names' field`);
    else cfg[target] = names(v.names, `[${section}] names`, errors, /^[A-Za-z][A-Za-z0-9*-]*$/);
  }

  return errors.length ? { config: null, errors } : { config: cfg, errors: [] };
}

/** Turns a config into completion options and key bindings. */
export function compile(config: Config): Compiled {
  const plain: Completion[] = [];
  const backslash: Completion[] = [];
  const keys: Compiled["keys"] = [];
  const add = (label: string, c: Completion) => (label.startsWith("\\") ? backslash : plain).push(c);

  for (const s of config.snippets) {
    if (s.trigger) {
      add(s.trigger, snippetCompletion(s.body, { label: s.trigger, type: "text", detail: s.description || undefined, boost: s.trigger.startsWith("\\") ? 0 : 2 }));
    }
    if (s.key) keys.push({ key: s.key, body: s.body, label: s.description || s.trigger || "Inserts a snippet" });
  }
  for (const g of config.words) {
    for (const w of g.words) {
      const label = g.prefix + w;
      add(label, { label, type: "keyword", detail: g.detail || undefined });
    }
  }
  return { config, plain, backslash, keys };
}

// The configuration the editor is currently running on. Starts empty until the file is loaded.
let active: Compiled = compile(empty());
export const getActive = () => active;
export const setActive = (c: Compiled) => (active = c);

/** The shipped file, parsed. Used as the fallback if the user's own file has errors at startup. */
export function defaultCompiled(): Compiled {
  const r = parseSnippets(DEFAULT_SNIPPETS_TOML);
  return compile(r.config ?? empty());
}

// ---- the list shown in the Snippets dialog ----

export type BrowseGroup = {
  title: string;
  how: string;
  items: { label: string; insert?: string; detail?: string; key?: string }[];
};

/** Tab stops are written #{} / #{text}; show them as boxes. */
export const showStops = (tpl: string) => tpl.replace(/#\{([^}]*)\}/g, (_, d: string) => (d ? `□(${d})` : "□"));

export function browseGroups(cfg: Config): BrowseGroup[] {
  const groups = new Map<string, BrowseGroup>();
  const group = (title: string, how: string) => {
    if (!groups.has(title)) groups.set(title, { title, how, items: [] });
    return groups.get(title)!;
  };
  for (const s of cfg.snippets) {
    const g = group(s.group || "Snippets", "Type the trigger and pick it from the suggestions. Tab moves between the blanks (□).");
    g.items.push({ label: s.trigger || "(shortcut only)", insert: showStops(s.body), detail: s.description || undefined, key: s.key || undefined });
  }
  for (const w of cfg.words) {
    const g = group(w.name, `Suggested as ${w.prefix}name when you start typing it.`);
    for (const word of w.words) g.items.push({ label: w.prefix + word });
  }
  if (cfg.environments.length) {
    const g = group("Environments", "After \\begin{ the list appears; choosing one inserts the whole \\begin … \\end block. \\end{ completes the name.");
    for (const e of cfg.environments) g.items.push({ label: e });
  }
  if (cfg.packages.length) {
    const g = group("Packages", "After \\usepackage{ the list appears. Separate several with commas.");
    for (const p of cfg.packages) g.items.push({ label: p });
  }
  group("References", "After \\ref{ or \\eqref{ the list shows every \\label{…} defined in the document (built in, not editable).");
  return [...groups.values()];
}

// ---- one-time migration of the old per-device snippets ----

type LegacySnippet = { trigger?: string; description?: string; shortcut?: string; body?: string };
const LEGACY_KEY = "hwscan:snippets";

const tomlString = (s: string) =>
  !s.includes("'") && !s.includes("\n") ? `'${s}'` : !s.includes("'''") ? `'''\n${s}'''` : JSON.stringify(s);

/** Snippets made with the old form editor, as TOML to append to the default file. Empty if there are none. */
export function legacySnippetsToml(): string {
  let list: LegacySnippet[] = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? "[]");
    if (Array.isArray(parsed)) list = parsed;
  } catch {}
  const blocks = list
    .filter((s) => s && typeof s.body === "string" && s.body && (s.trigger || s.shortcut))
    .map((s) => {
      let b = "\n[[snippet]]\n";
      if (s.trigger) b += `trigger = ${tomlString(s.trigger)}\n`;
      b += `body = ${tomlString(s.body!)}\n`;
      if (s.description) b += `description = ${tomlString(s.description)}\n`;
      if (s.shortcut) b += `key = ${tomlString(s.shortcut)}\n`;
      return b + "group = 'My snippets'\n";
    });
  return blocks.length ? `\n# ---- Imported from your earlier snippets ----\n${blocks.join("")}` : "";
}

export function clearLegacySnippets() {
  try { localStorage.removeItem(LEGACY_KEY); } catch {}
}
