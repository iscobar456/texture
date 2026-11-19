// The HTTP transport for Supabase requests. They go through Rust (tauri-plugin-http, a fresh reqwest client per
// request) rather than the webview's fetch: WebKit pools connections and, after a sleep in which the network
// silently forgot one, keeps sending every request down it until the kernel gives up (15+ minutes), so the app looked
// offline while the network was fine. The realtime websocket still uses the webview; it has its own heartbeat.
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { warn } from "./log";

/** Time allowed to open the TCP + TLS connection; the wait for the response is limited in `@texture/api`. */
const CONNECT_TIMEOUT_MS = 10_000;

/** Method, host and path only: no query string. */
function describe(input: RequestInfo | URL, init?: RequestInit): string {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const raw = input instanceof Request ? input.url : String(input);
  try {
    const u = new URL(raw);
    return `${method} ${u.host}${u.pathname}`;
  } catch {
    return `${method} ${raw.split("?")[0]}`;
  }
}

export const rustFetch: typeof fetch = async (input, init) => {
  const started = Date.now();
  try {
    const res = await tauriFetch(input, { ...init, connectTimeout: CONNECT_TIMEOUT_MS });
    if (res.status >= 500) warn(`http ${res.status} ${describe(input, init)} after ${Date.now() - started}ms`);
    return res;
  } catch (e) {
    // A caller's own cancel (signal aborted before we were asked to time out) is not worth a line.
    if (!init?.signal?.aborted || Date.now() - started > 15_000) {
      warn(`http failed ${describe(input, init)} after ${Date.now() - started}ms:`, e);
    }
    throw e;
  }
};
