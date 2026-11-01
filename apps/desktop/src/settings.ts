/** Editor color schemes. "soft" follows the app theme; the rest are fixed palettes (see styles.css). */
export const EDITOR_THEMES = [
  ["soft", "Soft (follows app theme)"],
  ["github-light", "GitHub Light"],
  ["solarized-light", "Solarized Light"],
  ["gruvbox-light", "Gruvbox Light"],
  ["solarized-dark", "Solarized Dark"],
  ["gruvbox-dark", "Gruvbox Dark"],
  ["nord", "Nord"],
  ["one-dark", "One Dark"],
] as const;
export type EditorTheme = (typeof EDITOR_THEMES)[number][0];

/**
 * Models offered for handwriting OCR, with $ per million tokens (input, output) from Anthropic's price list.
 * The Rust side keeps its own allowlist (OCR_MODELS in lib.rs); keep the two in step.
 */
export const OCR_MODELS = [
  ["claude-haiku-5-5", "Haiku 5.5 - cheapest (about $0.001 per photo)", 0.1, 0.5],
  ["claude-sonnet-5-5", "Sonnet 5.5 - balanced (about 1¢ per photo)", 2, 10],
  ["claude-opus-5-5", "Opus 5.5 - most accurate (about 3¢ per photo)", 4, 20],
] as const;
export type OcrModel = (typeof OCR_MODELS)[number][0];

export type Settings = {
  theme: "system" | "light" | "dark";
  editorTheme: EditorTheme;
  editing: "normal" | "vim";
  fontSize: number;
  wrap: boolean;
  lineNumbers: boolean;
  /** Recompile a moment after typing stops. */
  autoCompile: boolean;
  /** Pre-selected template in the New document dialog. */
  defaultTemplate: string;
  ocrModel: OcrModel;
};

export const DEFAULTS: Settings = {
  theme: "system",
  editorTheme: "soft",
  editing: "vim",
  fontSize: 14,
  wrap: true,
  lineNumbers: true,
  autoCompile: false,
  defaultTemplate: "Homework",
  ocrModel: "claude-sonnet-5-5",
};

// Per-device on purpose: font size and theme depend on the screen in front of you.
const KEY = "hwscan:settings";

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

export function loadSettings(): Settings {
  let raw: Partial<Settings> = {};
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    // Carry over the old header Vim toggle on first run.
    if (!localStorage.getItem(KEY) && localStorage.getItem("vim") === "off") raw.editing = "normal";
  } catch {}
  const size = Number(raw.fontSize);
  return {
    theme: pick(raw.theme, ["system", "light", "dark"], DEFAULTS.theme),
    editorTheme: pick(raw.editorTheme, EDITOR_THEMES.map(([v]) => v), DEFAULTS.editorTheme),
    editing: pick(raw.editing, ["normal", "vim"], DEFAULTS.editing),
    fontSize: Number.isFinite(size) ? Math.min(28, Math.max(10, Math.round(size))) : DEFAULTS.fontSize,
    wrap: typeof raw.wrap === "boolean" ? raw.wrap : DEFAULTS.wrap,
    lineNumbers: typeof raw.lineNumbers === "boolean" ? raw.lineNumbers : DEFAULTS.lineNumbers,
    autoCompile: typeof raw.autoCompile === "boolean" ? raw.autoCompile : DEFAULTS.autoCompile,
    ocrModel: pick(raw.ocrModel, OCR_MODELS.map(([v]) => v), DEFAULTS.ocrModel),
    defaultTemplate: typeof raw.defaultTemplate === "string" ? raw.defaultTemplate : DEFAULTS.defaultTemplate,
  };
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}

/** The parts of settings that are plain CSS; the editor-specific ones are applied in main.ts. */
export function applyAppearance(s: Settings) {
  const root = document.documentElement;
  if (s.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = s.theme;
  if (s.editorTheme === "soft") delete root.dataset.editorTheme;
  else root.dataset.editorTheme = s.editorTheme;
  root.style.setProperty("--editor-font-size", `${s.fontSize}px`);
  document.getElementById("editor")?.classList.toggle("no-gutters", !s.lineNumbers);
}
