import { call } from "./commands";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * The API key part of Settings → Photo OCR: save, test and remove the key. The key is stored by the Rust side
 * and never comes back to the page, so this only ever knows whether one is saved.
 */
export function initOcrKeyUi(user: () => string) {
  // -- OCR API key (stored by the Rust side; the key itself never comes back to the page) --
  const ocrKey = $<HTMLInputElement>("set-ocr-key");
  const ocrStatus = $("set-ocr-status");
  const ocrBadge = $("set-ocr-badge");
  const ocrSave = $<HTMLButtonElement>("set-ocr-save");
  const ocrTest = $<HTMLButtonElement>("set-ocr-test");
  const ocrRemove = $<HTMLButtonElement>("set-ocr-remove");
  const ocrShow = $<HTMLButtonElement>("set-ocr-show");
  let keySaved = false;

  function keyNote(text: string, kind: "" | "ok" | "err" = "") {
    ocrStatus.textContent = text;
    ocrStatus.className = `muted ${kind}`.trim();
  }

  /** Save needs something typed; Test and Remove need a saved key. */
  function syncKeyButtons(busy = false) {
    ocrSave.disabled = busy || !ocrKey.value.trim();
    ocrTest.disabled = busy || !keySaved;
    ocrRemove.disabled = busy || !keySaved;
  }

  async function refreshKeyStatus() {
    keySaved = await call("has_api_key", { user: user() });
    ocrBadge.textContent = keySaved ? "Key saved on this device" : "No key saved";
    ocrBadge.classList.toggle("saved", keySaved);
    ocrKey.placeholder = keySaved ? "Paste a new key to replace the saved one" : "sk-ant-…";
    syncKeyButtons();
  }

  async function keyAction(label: string, fn: () => Promise<void>) {
    keyNote(`${label}…`);
    syncKeyButtons(true);
    try {
      await fn();
    } catch (e) {
      keyNote(String(e), "err");
    }
    syncKeyButtons();
  }

  ocrKey.addEventListener("input", () => {
    syncKeyButtons();
    keyNote("");
  });
  ocrKey.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !ocrSave.disabled) {
      e.preventDefault();
      ocrSave.click();
    }
  });
  ocrShow.addEventListener("click", () => {
    const show = ocrKey.type === "password";
    ocrKey.type = show ? "text" : "password";
    ocrShow.textContent = show ? "Hide" : "Show";
    ocrShow.setAttribute("aria-pressed", String(show));
  });

  ocrSave.addEventListener("click", () =>
    keyAction("Saving", async () => {
      if (!ocrKey.value.trim()) throw new Error("Paste a key first.");
      await call("set_api_key", { user: user(), key: ocrKey.value });
      ocrKey.value = "";
      await refreshKeyStatus();
      keyNote("Saved. Use Test key to check it works.", "ok");
    }),
  );
  ocrTest.addEventListener("click", () =>
    keyAction("Testing", async () => {
      await call("test_api_key", { user: user() });
      keyNote("✓ The key works.", "ok");
    }),
  );
  ocrRemove.addEventListener("click", () =>
    keyAction("Removing", async () => {
      await call("set_api_key", { user: user(), key: "" });
      await refreshKeyStatus();
      keyNote("Key removed.");
    }),
  );

  return {
    /** Called when Settings opens: an empty field and the current saved/not-saved state. */
    reset() {
      ocrKey.value = "";
      keyNote("");
      void refreshKeyStatus();
    },
  };
}
