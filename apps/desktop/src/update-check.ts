import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "./toast";

const LATEST = "https://api.github.com/repos/iscobar456/texture/releases/latest";
const SEEN_KEY = "texture:update-seen";

/** True if version `a` ("v0.5.0" or "0.5.0") is newer than `b`. Anything that is not plain x.y.z is never newer. */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())?.slice(1).map(Number);
  const [x, y] = [parse(a), parse(b)];
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/**
 * Once per launch: asks GitHub for the latest published release and, if it is newer than this build, says so with
 * a link to the download. The app does not update itself. Each new version is announced once per device; any
 * failure (offline, rate limit) is ignored. The request carries nothing about the user.
 */
export async function checkForUpdate() {
  try {
    const res = await fetch(LATEST, { headers: { accept: "application/vnd.github+json" } });
    if (!res.ok) return;
    const rel = (await res.json()) as { tag_name?: string; html_url?: string };
    if (!rel.tag_name || !rel.html_url || !isNewer(rel.tag_name, await getVersion())) return;
    try {
      if (localStorage.getItem(SEEN_KEY) === rel.tag_name) return;
      localStorage.setItem(SEEN_KEY, rel.tag_name);
    } catch {}
    const url = rel.html_url;
    toast(`Texture ${rel.tag_name.replace(/^v/, "")} is available`, { actionLabel: "Download", onAction: () => void openUrl(url).catch(() => {}), ms: 20_000 });
  } catch {
    // not being able to check is not worth a message
  }
}
