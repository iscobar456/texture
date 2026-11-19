import type { createApi, DeletedDoc } from "@texture/api";
import { DELETED_KEEP_DAYS } from "@texture/api";

type Api = ReturnType<typeof createApi>;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function ago(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

/**
 * "Recently deleted" (from the document picker): documents deleted in the last DELETED_KEEP_DAYS, read from the
 * server, each with a Restore button. Restoring clears the deletion marker on the server and runs a sync, which
 * brings the document back like one made on another device. It needs a connection, and only covers documents that
 * had been uploaded before they were deleted.
 */
export function initDeleted(deps: {
  api: () => Api;
  /** Runs a sync pass and resolves when it is over. */
  syncNow: () => Promise<void>;
  status: (s: string) => void;
  /** Something came back; lists showing documents should refresh. */
  onRestored: () => void;
}) {
  const dialog = $<HTMLDialogElement>("deleted-dialog");
  const list = $("deleted-list");

  const note = (text: string) => {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = text;
    list.replaceChildren(p);
  };

  async function load() {
    let docs: DeletedDoc[];
    try {
      docs = await deps.api().listDeletedDocs();
    } catch {
      return note("Recently deleted documents are kept on the server, so this needs a connection.");
    }
    if (!docs.length) return note(`Nothing was deleted in the last ${DELETED_KEEP_DAYS} days.`);
    list.replaceChildren(...docs.map(row));
  }

  function row(d: DeletedDoc): HTMLElement {
    const el = document.createElement("div");
    el.className = "row deleted-item";
    const name = document.createElement("span");
    name.className = "deleted-name";
    name.textContent = d.path;
    name.title = d.path;
    const when = document.createElement("span");
    when.className = "muted";
    when.textContent = `deleted ${ago(d.deleted_at)}`;
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "Restore";
    b.addEventListener("click", async () => {
      b.disabled = true;
      b.textContent = "Restoring…";
      try {
        const path = await deps.api().restoreDoc(d);
        if (path === null) deps.status(`"${d.path}" is no longer available to restore`);
        else {
          await deps.syncNow();
          deps.status(`Restored "${path}"`);
          deps.onRestored();
        }
      } catch (e) {
        deps.status(`Couldn't restore: ${(e as Error)?.message ?? e}`);
      }
      await load();
    });
    el.append(name, when, b);
    return el;
  }

  $("deleted-open").addEventListener("click", () => {
    note("Loading…");
    dialog.showModal();
    void load();
  });
}
