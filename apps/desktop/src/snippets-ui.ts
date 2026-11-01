import { showKey } from "./completions";
import { browseGroups, getActive } from "./snippets";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * The Snippets dialog: a searchable list of everything the snippets file currently provides, plus the
 * way into editing that file. The file itself is the only place snippets are defined.
 */
export function initSnippetsUi(opts: {
  /** Problems from the last time the file was parsed. */
  errors: () => string[];
  /** Open the snippets file in the editor. */
  onEdit: () => void;
  onReset: () => Promise<void>;
}) {
  const dialog = $<HTMLDialogElement>("snippets-dialog");
  const body = $("snip-body");
  const search = $<HTMLInputElement>("snip-search");
  const errorBox = $("snip-errors");

  function render() {
    const errs = opts.errors();
    errorBox.hidden = errs.length === 0;
    errorBox.textContent = errs.length
      ? `Your snippets file has problems, so the last working version is in use:\n${errs.map((e) => `• ${e}`).join("\n")}`
      : "";

    const q = search.value.trim().toLowerCase();
    const out: HTMLElement[] = [];
    for (const g of browseGroups(getActive().config)) {
      const items = g.items.filter(
        (it) => !q || it.label.toLowerCase().includes(q) || (it.detail ?? "").toLowerCase().includes(q) || g.title.toLowerCase().includes(q),
      );
      if (!items.length && (q || g.items.length)) continue;
      const sec = document.createElement("section");
      const h = document.createElement("h4");
      h.textContent = g.title;
      const how = document.createElement("p");
      how.className = "muted";
      how.textContent = g.how;
      sec.append(h, how);
      if (items.some((it) => it.insert || it.detail || it.key)) {
        // Entries with an expansion or a shortcut get a table: what you type, what it inserts, its shortcut.
        const table = document.createElement("div");
        table.className = "bi-rows";
        for (const it of items) {
          const label = document.createElement("code");
          label.textContent = it.label;
          const what = document.createElement("div");
          if (it.insert) {
            const code = document.createElement("code");
            code.textContent = it.insert;
            what.append(code);
          }
          if (it.detail) {
            const d = document.createElement("div");
            d.className = "muted";
            d.textContent = it.detail;
            what.append(d);
          }
          const key = document.createElement("div");
          if (it.key) {
            const k = document.createElement("kbd");
            k.textContent = showKey(it.key).split("-").join("+");
            key.append(k);
          }
          table.append(label, what, key);
        }
        sec.append(table);
      } else {
        // Plain names (Greek letters, packages, ...) are just a wrapped list.
        const cols = document.createElement("div");
        cols.className = "bi-cols";
        for (const it of items) {
          const c = document.createElement("code");
          c.textContent = it.label;
          cols.append(c);
        }
        sec.append(cols);
      }
      out.push(sec);
    }
    body.replaceChildren(...out);
    if (!out.length) body.textContent = "No snippets match.";
  }

  search.addEventListener("input", render);

  $("open-snippets").addEventListener("click", () => {
    search.value = "";
    render();
    dialog.showModal();
  });

  $("snip-edit").addEventListener("click", () => {
    dialog.close();
    opts.onEdit();
  });

  const resetDialog = $<HTMLDialogElement>("snip-reset-dialog");
  $("snip-reset").addEventListener("click", () => resetDialog.showModal());
  $("snip-reset-form").addEventListener("submit", async (e) => {
    const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.value !== "ok") return;
    await opts.onReset();
    render();
  });

  return { render };
}
