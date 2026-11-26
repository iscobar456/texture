import { createApi } from "@texture/api";
import { afterEach, expect, test, vi } from "vitest";

const URL_ = "https://ref.supabase.co";
const KEY = "sb-ref-auth-token";

function setup(expiresIn: number | null) {
  const store = new Map<string, string>();
  if (expiresIn !== null) {
    store.set(KEY, JSON.stringify({
      access_token: "user-token", refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + expiresIn,
      user: { id: "u1", email: "a@example.com" },
    }));
  }
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  const sent: { path: string; auth: string | null }[] = [];
  const api = createApi(URL_, "anon-key", {
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      sent.push({ path, auth: new Headers(init?.headers).get("authorization") });
      if (path.startsWith("/auth/")) throw new TypeError("offline");
      return new Response("[]", { headers: { "content-type": "application/json" } });
    },
  });
  // supabase-js picks up `localStorage` only in a browser, so hand the auth client the stub directly.
  (api.sb.auth as unknown as { storage: Storage }).storage = localStorage;
  return { api, store, data: () => sent.filter((s) => !s.path.startsWith("/auth/")) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("a valid stored session is used for data requests", async () => {
  const { api, data } = setup(3600);
  expect(api.storedUser()?.id).toBe("u1");
  await api.listPending();
  expect(data()).toEqual([{ path: "/rest/v1/photos", auth: "Bearer user-token" }]);
});

test("offline with an expired token: still signed in, nothing sent anonymously, and sign-out works", async () => {
  vi.useFakeTimers();
  const { api, store, data } = setup(-60);
  const listing = expect(api.listPending()).rejects.toMatchObject({ message: expect.stringContaining("Can't reach your account") });
  await vi.advanceTimersByTimeAsync(120_000);
  await listing;
  expect(data()).toEqual([]);
  expect(api.storedUser()?.id).toBe("u1");
  const out = api.signOut();
  await vi.advanceTimersByTimeAsync(120_000);
  await out;
  expect(store.has(KEY)).toBe(false);
});

test("no stored session", () => {
  expect(setup(null).api.storedUser()).toBeNull();
});
