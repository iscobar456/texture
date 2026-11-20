import { parse, stringify } from "smol-toml";

/**
 * Color themes. Each has a light and a dark palette (styles.css, `data-palette` × `data-theme`) that colors both the
 * editor and the window; Settings → Mode picks which one.
 */
export const THEMES = [
  ["soft", "Soft"],
  ["rose-pine", "Rosé Pine"],
  ["everforest", "Everforest"],
  ["tokyo-night", "Tokyo Night"],
  ["kanagawa", "Kanagawa"],
  ["gruvbox", "Gruvbox"],
  ["solarized", "Solarized"],
  ["github", "GitHub"],
] as const;
export type Palette = (typeof THEMES)[number][0];
type Mode = "system" | "light" | "dark";

/** The old per-editor color schemes (before themes had both modes), as theme + the mode the editor showed. */
const LEGACY_EDITOR_THEMES: Record<string, [Palette, "light" | "dark"]> = {
  "github-light": ["github", "light"],
  "solarized-light": ["solarized", "light"],
  "gruvbox-light": ["gruvbox", "light"],
  "solarized-dark": ["solarized", "dark"],
  "gruvbox-dark": ["gruvbox", "dark"],
  nord: ["tokyo-night", "dark"],
  "one-dark": ["tokyo-night", "dark"],
};

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

export const OCR_PROMPT_MAX = 4000;

/** Headers for the `ocr_image` command. The prompt travels base64-encoded: header values can't hold newlines. */
export function ocrHeaders(user: string, s: Settings): Record<string, string> {
  const h: Record<string, string> = { "x-user": user, "x-model": s.ocrModel };
  if (s.ocrPrompt.trim()) h["x-prompt"] = btoa(String.fromCharCode(...new TextEncoder().encode(s.ocrPrompt)));
  return h;
}

export type Settings = {
  /** Light or dark version of the theme; "system" follows the OS. */
  theme: Mode;
  palette: Palette;
  editing: "normal" | "vim";
  fontSize: number;
  wrap: boolean;
  lineNumbers: boolean;
  /** Recompile a moment after typing stops. */
  autoCompile: boolean;
  /** Pre-selected template in the New document dialog. */
  defaultTemplate: string;
  ocrModel: OcrModel;
  /** Custom OCR instructions; empty means the built-in default (kept in Rust). */
  ocrPrompt: string;
  /** Format document (tex-fmt): break long lines, where, and how deep to indent. */
  formatWrap: boolean;
  formatWrapLen: number;
  formatIndent: "2" | "4" | "tab";
};

export const DEFAULTS: Settings = {
  theme: "system",
  palette: "soft",
  editing: "normal",
  fontSize: 14,
  wrap: true,
  lineNumbers: true,
  autoCompile: true,
  defaultTemplate: "Blank",
  ocrModel: "claude-sonnet-5-5",
  ocrPrompt: "",
  formatWrap: true,
  formatWrapLen: 80,
  formatIndent: "2",
};

// Per-device on purpose: font size and theme depend on the screen in front of you. Two settings are work the
// user would not want to redo on a new device, so they also follow the account (see SETTINGS_CONFIG below).
const KEY = "texture:settings";

/**
 * The settings that follow the account: the custom OCR instructions and the default template. They are kept in a
 * small TOML file that syncs like the snippets file (`<user_dir>/.config/settings.toml`, sync kind `config`);
 * `localStorage` still holds a copy so they are there before sign-in and offline.
 */
export const SETTINGS_CONFIG = "settings";

export function syncedSettingsToml(s: Settings): string {
  return stringify({ default_template: s.defaultTemplate, ocr_prompt: s.ocrPrompt });
}

/** `s` with the synced values from the file's text. Anything missing or malformed keeps the current value. */
export function applySyncedSettings(s: Settings, text: string): Settings {
  let raw: Record<string, unknown>;
  try {
    raw = parse(text);
  } catch {
    return s;
  }
  return {
    ...s,
    defaultTemplate: typeof raw.default_template === "string" && raw.default_template ? raw.default_template : s.defaultTemplate,
    ocrPrompt: typeof raw.ocr_prompt === "string" ? raw.ocr_prompt.slice(0, OCR_PROMPT_MAX) : s.ocrPrompt,
  };
}

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

export function loadSettings(): Settings {
  let raw: Partial<Settings> & { editorTheme?: string } = {};
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    // Carry over the old header Vim toggle on first run.
    if (!localStorage.getItem(KEY) && localStorage.getItem("vim") === "off") raw.editing = "normal";
  } catch {}
  const size = Number(raw.fontSize);
  let theme = pick(raw.theme, ["system", "light", "dark"] as const, DEFAULTS.theme);
  let palette = pick(raw.palette, THEMES.map(([v]) => v), DEFAULTS.palette);
  // Settings saved before themes: a fixed editor scheme becomes its theme, in the mode the editor was showing.
  const legacy = raw.palette === undefined && raw.editorTheme ? LEGACY_EDITOR_THEMES[raw.editorTheme] : undefined;
  if (legacy) [palette, theme] = legacy;
  return {
    theme,
    palette,
    editing: pick(raw.editing, ["normal", "vim"], DEFAULTS.editing),
    fontSize: Number.isFinite(size) ? Math.min(28, Math.max(10, Math.round(size))) : DEFAULTS.fontSize,
    wrap: typeof raw.wrap === "boolean" ? raw.wrap : DEFAULTS.wrap,
    lineNumbers: typeof raw.lineNumbers === "boolean" ? raw.lineNumbers : DEFAULTS.lineNumbers,
    autoCompile: typeof raw.autoCompile === "boolean" ? raw.autoCompile : DEFAULTS.autoCompile,
    ocrModel: pick(raw.ocrModel, OCR_MODELS.map(([v]) => v), DEFAULTS.ocrModel),
    ocrPrompt: typeof raw.ocrPrompt === "string" ? raw.ocrPrompt.slice(0, OCR_PROMPT_MAX) : "",
    formatWrap: typeof raw.formatWrap === "boolean" ? raw.formatWrap : DEFAULTS.formatWrap,
    formatWrapLen: Number.isFinite(Number(raw.formatWrapLen)) ? Math.min(300, Math.max(20, Math.round(Number(raw.formatWrapLen)))) : DEFAULTS.formatWrapLen,
    formatIndent: pick(raw.formatIndent, ["2", "4", "tab"] as const, DEFAULTS.formatIndent),
    defaultTemplate: typeof raw.defaultTemplate === "string" ? raw.defaultTemplate : DEFAULTS.defaultTemplate,
  };
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}

let mode: Mode = "system";
let darkQuery: MediaQueryList | null = null;
/** Sets data-theme to the light or dark palette; "Match system" follows the OS as it changes, not just at launch. */
function applyMode() {
  if (!darkQuery) {
    darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
    darkQuery.addEventListener("change", () => { if (mode === "system") applyMode(); });
  }
  document.documentElement.dataset.theme = mode === "system" ? (darkQuery.matches ? "dark" : "light") : mode;
}

/** The parts of settings that are plain CSS; the editor-specific ones are applied in main.ts. */
export function applyAppearance(s: Settings) {
  const root = document.documentElement;
  mode = s.theme;
  applyMode();
  root.dataset.palette = s.palette;
  root.style.setProperty("--editor-font-size", `${s.fontSize}px`);
  document.getElementById("editor")?.classList.toggle("no-gutters", !s.lineNumbers);
}
