import { describe, expect, it } from "vitest";
import { fetchAll, withSuffix, withTimeout } from "@texture/api";

/** A stand-in for a server that returns at most `cap` rows per request, like PostgREST does. */
function paged(total: number, cap: number) {
  const calls: [number, number][] = [];
  const rows = Array.from({ length: total }, (_, i) => i);
  const page = async (from: number, to: number) => {
    calls.push([from, to]);
    return { data: rows.slice(from, Math.min(to + 1, from + cap)), error: null };
  };
  return { page, calls };
}

describe("fetchAll", () => {
  it("keeps asking until a short page, so a listing longer than one page is complete", async () => {
    const { page, calls } = paged(2500, 1000);
    expect(await fetchAll(page)).toHaveLength(2500);
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("asks once more when the listing is exactly one page long", async () => {
    const { page, calls } = paged(100, 100);
    expect(await fetchAll(page, 100)).toHaveLength(100);
    expect(calls).toHaveLength(2);
  });

  it("makes one request for a short listing and throws on an error", async () => {
    const { page, calls } = paged(3, 1000);
    expect(await fetchAll(page)).toEqual([0, 1, 2]);
    expect(calls).toHaveLength(1);
    await expect(fetchAll(async () => ({ data: null, error: new Error("boom") }))).rejects.toThrow("boom");
  });
});

describe("withSuffix", () => {
  it("adds the suffix to the last name of a path", () => {
    expect(withSuffix("Physics/HW 1", " (restored)")).toBe("Physics/HW 1 (restored)");
    expect(withSuffix("HW", " (restored 2)")).toBe("HW (restored 2)");
  });
  it("shortens a long name so the result still fits in 64 bytes", () => {
    const out = withSuffix(`Course/${"x".repeat(64)}`, " (restored)");
    const name = out.split("/")[1];
    expect(name.endsWith(" (restored)")).toBe(true);
    expect(new TextEncoder().encode(name).length).toBe(64);
  });
});

/** A fetch that never answers on its own, and rejects the way WebKitGTK does when aborted (losing the reason). */
const hanging: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Fetch is aborted", "AbortError")));
  });

describe("withTimeout", () => {
  it("reports a request it cut off as a TimeoutError, even when the transport says only AbortError", async () => {
    await expect(withTimeout(hanging, 20)("https://x.test/")).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("passes a caller's own abort through unchanged", async () => {
    const ctl = new AbortController();
    const p = withTimeout(hanging, 10_000)("https://x.test/", { signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("passes other failures through and returns answers that arrive in time", async () => {
    const boom: typeof fetch = async () => { throw new TypeError("Load failed"); };
    await expect(withTimeout(boom, 1000)("https://x.test/")).rejects.toBeInstanceOf(TypeError);
    const ok: typeof fetch = async () => new Response("hi");
    expect(await (await withTimeout(ok, 1000)("https://x.test/")).text()).toBe("hi");
  });
});
