// Fills the download buttons from GitHub releases. Each platform links the newest published release that has a
// file for it (macOS and Windows files are built on other machines and can arrive later than the rest). Without
// JavaScript, or if GitHub cannot be reached, every button keeps its link to the latest release page.
(function () {
  const REPO = "iscobar456/texture";
  const buttons = document.querySelectorAll("[data-asset]");
  if (!buttons.length) return;

  // Suggest the button for this device.
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? "android"
    : /iPhone|iPad|iPod/i.test(ua) ? "ios"
    : /Mac/i.test(ua) ? "mac"
    : /Win/i.test(ua) ? "windows"
    : /Linux/i.test(ua) ? "linux" : "";
  const first = document.querySelector(`[data-os="${os}"]`);
  if (first) first.classList.add("suggested");

  const size = (n) => (n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round(n / 1e3)} KB`);

  fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, { headers: { accept: "application/vnd.github+json" } })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((releases) => {
      const published = releases.filter((r) => !r.draft && !r.prerelease);
      const latest = published[0];
      if (latest) {
        const v = document.getElementById("latest-version");
        if (v) v.textContent = latest.tag_name.replace(/^v/, "");
      }
      buttons.forEach((btn) => {
        const pattern = new RegExp(btn.dataset.asset);
        for (const rel of published) {
          const asset = rel.assets.find((a) => pattern.test(a.name));
          if (!asset) continue;
          btn.href = asset.browser_download_url;
          const meta = btn.querySelector("span");
          if (meta) meta.textContent = `${asset.name} · ${size(asset.size)}`;
          return;
        }
        const meta = btn.querySelector("span");
        if (meta) meta.textContent = "Not built yet. See all releases.";
      });
    })
    .catch(() => {});
})();
