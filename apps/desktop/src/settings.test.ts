import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS, OCR_PROMPT_MAX, applySyncedSettings, syncedSettingsToml } from "./settings";

describe("synced settings file", () => {
  it("round-trips the OCR prompt and default template, leaving device settings alone", () => {
    const here = { ...DEFAULTS, fontSize: 18, ocrPrompt: 'Line one\nUse \\textbf{} and "quotes"\n', defaultTemplate: "Homework (v2)" };
    const there = applySyncedSettings({ ...DEFAULTS, fontSize: 12 }, syncedSettingsToml(here));
    expect(there.ocrPrompt).toBe(here.ocrPrompt);
    expect(there.defaultTemplate).toBe("Homework (v2)");
    expect(there.fontSize).toBe(12);
  });

  it("keeps the current values when the file is malformed or incomplete", () => {
    const s = { ...DEFAULTS, ocrPrompt: "mine", defaultTemplate: "T" };
    expect(applySyncedSettings(s, "not = [valid")).toEqual(s);
    expect(applySyncedSettings(s, "default_template = 3\n")).toEqual(s);
    expect(applySyncedSettings(s, 'ocr_prompt = ""\n')).toEqual({ ...s, ocrPrompt: "" });
  });

  it("caps an oversized prompt", () => {
    const text = syncedSettingsToml({ ...DEFAULTS, ocrPrompt: "x".repeat(OCR_PROMPT_MAX + 50) });
    expect(applySyncedSettings(DEFAULTS, text).ocrPrompt.length).toBe(OCR_PROMPT_MAX);
  });
});

describe("themes", () => {
  const load = async (stored: object) => {
    const store = new Map([["texture:settings", JSON.stringify(stored)]]);
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: () => {} });
    return (await import("./settings")).loadSettings();
  };
  afterEach(() => vi.unstubAllGlobals());

  it("turns an old fixed editor scheme into its theme, in the mode the editor showed", async () => {
    expect(await load({ theme: "light", editorTheme: "solarized-dark" })).toMatchObject({ palette: "solarized", theme: "dark" });
    expect(await load({ theme: "system", editorTheme: "nord" })).toMatchObject({ palette: "tokyo-night", theme: "dark" });
    expect(await load({ theme: "dark", editorTheme: "github-light" })).toMatchObject({ palette: "github", theme: "light" });
  });

  it("keeps the mode for the old Soft scheme, and ignores the old key once a theme is saved", async () => {
    expect(await load({ theme: "dark", editorTheme: "soft" })).toMatchObject({ palette: "soft", theme: "dark" });
    expect(await load({ theme: "system", palette: "kanagawa", editorTheme: "nord" })).toMatchObject({ palette: "kanagawa", theme: "system" });
    expect(await load({ palette: "no-such-theme" })).toMatchObject({ palette: "soft" });
  });
});
