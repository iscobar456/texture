import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.4.0" }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));

import { isNewer } from "./update-check";

describe("isNewer", () => {
  it("compares versions numerically", () => {
    expect(isNewer("v0.5.0", "0.4.0")).toBe(true);
    expect(isNewer("0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("v0.4.0", "0.4.0")).toBe(false);
    expect(isNewer("0.3.9", "0.4.0")).toBe(false);
  });
  it("never calls a tag it cannot read newer", () => {
    expect(isNewer("nightly", "0.4.0")).toBe(false);
    expect(isNewer("v1.0.0-beta", "0.4.0")).toBe(false);
  });
});
