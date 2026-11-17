import { describe, expect, it } from "vitest";
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
