// A persistent log for diagnosing problems after the fact. Rust's tauri-plugin-log writes it (see `run` in lib.rs);
// this forwards the webview's console warnings and errors there, plus a few events worth a line of their own.
import { error as logError, info as logInfo, warn as logWarn } from "@tauri-apps/plugin-log";
import { getVersion } from "@tauri-apps/api/app";

function fmt(v: unknown): string {
  if (v instanceof Error || v instanceof DOMException) return `${v.name}: ${v.message}`;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

const line = (args: unknown[]) => args.map(fmt).join(" ");

// Never let logging itself throw or reject.
export function info(...args: unknown[]) {
  void logInfo(line(args)).catch(() => {});
}
export function warn(...args: unknown[]) {
  void logWarn(line(args)).catch(() => {});
}
export function error(...args: unknown[]) {
  void logError(line(args)).catch(() => {});
}

/** Call once at startup, before anything else logs. */
export function initLog() {
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    warn(...args);
  };
  console.error = (...args: unknown[]) => {
    origError(...args);
    error(...args);
  };
  void getVersion().then((v) => info(`Texture ${v} started`), () => info("Texture started"));
  window.addEventListener("online", () => info("network: browser reports online"));
  window.addEventListener("offline", () => info("network: browser reports offline"));
  // A gap in wall-clock time between timer ticks means the machine slept; requests right after a wake are where
  // network trouble shows up, so mark it in the log.
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    if (now - last > 60_000) info(`woke after about ${Math.round((now - last) / 60_000)} min asleep`);
    last = now;
  }, 15_000);
}
