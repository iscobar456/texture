/**
 * Sync tests. Two simulated devices (an in-memory stand-in for the Rust commands in `lib.rs`) share one simulated
 * server (an in-memory stand-in for `@texture/api` and the `documents`/`templates` tables with their triggers
 * and unique indexes). The sync algorithm in `sync.ts` is the real one.
 *
 * The stand-ins only model what `sync.ts` and the user actions below depend on. Keep them in step with
 * `src-tauri/src/lib.rs` (Meta, move_item, rename_local, apply_remote, mark_synced, tombstones) and
 * `supabase/migrations/0009_stable_ids.sql`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ dev: null as unknown }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown, opts?: unknown) => (state.dev as Device).call(cmd, args, opts),
}));

import { runSync } from "./sync";

// ---------------------------------------------------------------- the server

type Row = { id: string; kind: string; path: string; source: string; updated_at: string; deleted_at: string | null; preview_at: string | null };

class Server {
  private n = 0;
  docs = new Map<string, Row>(); // documents + folders
  templates = new Map<string, Row>();
  files = new Map<string, string>(); // storage: "<id>/images/<name>" -> content
  uploads: string[] = [];

  private tick = () => `v${String(++this.n).padStart(4, "0")}`;
  private table = (kind: string) => (kind === "template" ? this.templates : this.docs);

  live(kind: string) {
    return [...this.table(kind).values()]
      .filter((r) => !r.deleted_at && (kind === "template" || r.kind === kind))
      .map((r) => ({ id: r.id, path: r.path, source: r.source }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }
  row(kind: string, path: string) {
    return [...this.table(kind).values()].find((r) => r.path === path && !r.deleted_at);
  }
  private dup() {
    return Object.assign(new Error("duplicate key"), { code: "23505" });
  }
  private checkPath(t: Map<string, Row>, r: Row) {
    for (const o of t.values()) if (o.id !== r.id && !o.deleted_at && !r.deleted_at && o.path === r.path) throw this.dup();
  }

  api = {
    listDocs: async (kind: string): Promise<unknown[]> => {
      if (kind === "config") return [];
      return [...this.table(kind).values()]
        .filter((r) => kind === "template" || r.kind === kind)
        .map((r) => ({ id: r.id, path: r.path, updated_at: r.updated_at, deleted_at: r.deleted_at, preview_at: r.preview_at }));
    },
    getDoc: async (kind: string, id: string) => {
      const r = this.table(kind).get(id);
      if (!r) throw new Error("not found");
      return { ...r };
    },
    insertDoc: async (kind: string, id: string, path: string, source: string) => {
      const t = this.table(kind);
      const r: Row = { id, kind, path, source, updated_at: this.tick(), deleted_at: null, preview_at: null };
      if (t.has(id)) return null;
      try {
        this.checkPath(t, r);
      } catch {
        return null;
      }
      t.set(id, r);
      return r.updated_at;
    },
    updateDoc: async (kind: string, id: string, patch: { path?: string; source?: string }, baseAt: string, undelete = false) => {
      const t = this.table(kind);
      const r = t.get(id);
      if (!r || r.updated_at !== baseAt) return null;
      const next: Row = { ...r, ...patch, deleted_at: undelete ? null : r.deleted_at };
      this.checkPath(t, next);
      // the touch trigger: the version moves when content, name or deletion state changes
      if (next.source !== r.source || next.path !== r.path || next.deleted_at !== r.deleted_at) next.updated_at = this.tick();
      t.set(id, next);
      return next.updated_at;
    },
    deleteDoc: async (kind: string, ref: { id?: string | null; path: string }, baseAt: string) => {
      const r = ref.id ? this.table(kind).get(ref.id) : this.row(kind, ref.path);
      if (!r || r.deleted_at || r.updated_at !== baseAt) return false;
      r.deleted_at = "now";
      r.updated_at = this.tick();
      return true;
    },
    setPreviewAt: async () => true,
    uploadPreview: async () => {},
    downloadPreview: async () => null,
    removePreview: async () => {},
    removeDocFiles: async (id: string) => {
      for (const k of [...this.files.keys()]) if (k.startsWith(`${id}/`)) this.files.delete(k);
    },
    listDocImages: async (id: string) =>
      [...this.files.keys()].filter((k) => k.startsWith(`${id}/images/`)).map((k) => k.split("/").pop()!),
    uploadDocImage: async (id: string, name: string, bytes: Uint8Array) => {
      this.uploads.push(`${id}/${name}`);
      this.files.set(`${id}/images/${name}`, new TextDecoder().decode(bytes));
    },
    downloadDocImage: async (id: string, name: string) => new TextEncoder().encode(this.files.get(`${id}/images/${name}`) ?? ""),
  };
}

// ---------------------------------------------------------------- a device

type Meta = { dirty: boolean; remote_at: string | null; id: string | null; remote_path: string | null };
const blank = (): Meta => ({ dirty: false, remote_at: null, id: null, remote_path: null });
type Item = { kind: "document" | "folder"; source: string; images: Map<string, string>; meta: Meta };
type Tomb = { kind: string; path: string; id: string | null; remote_at: string };

const parentsOf = (p: string) => p.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"));
const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

class Device {
  items = new Map<string, Item>();
  templates = new Map<string, { source: string; meta: Meta }>();
  tombs: Tomb[] = [];
  downloads: string[] = [];

  // ---- what the user does (mirrors the Rust commands) ----
  private ensureParents(path: string) {
    for (const p of parentsOf(path)) if (!this.items.has(p)) this.items.set(p, { kind: "folder", source: "", images: new Map(), meta: blank() });
  }
  createDoc(path: string, source = "", images: Record<string, string> = {}) {
    this.ensureParents(path);
    this.items.set(path, { kind: "document", source, images: new Map(Object.entries(images)), meta: { ...blank(), dirty: true } });
  }
  createFolder(path: string) {
    this.ensureParents(path);
    if (!this.items.has(path)) this.items.set(path, { kind: "folder", source: "", images: new Map(), meta: blank() });
  }
  edit(path: string, source: string) {
    const it = this.items.get(path)!;
    it.source = source;
    it.meta.dirty = true;
  }
  moveItem(from: string, to: string) {
    if (to === from || under(to, from)) throw new Error("cannot move something into itself");
    if (this.items.has(to)) throw new Error("already exists");
    for (const [p, it] of this.items) if (under(p, from) && it.meta.remote_at && !it.meta.remote_path) it.meta.remote_path = p;
    this.ensureParents(to);
    for (const [p, it] of [...this.items]) {
      if (!under(p, from)) continue;
      this.items.delete(p);
      this.items.set(to + p.slice(from.length), it);
    }
  }
  deleteItem(path: string) {
    for (const [p, it] of [...this.items]) {
      if (!under(p, path)) continue;
      if (it.meta.remote_at) this.tombs.push({ kind: it.kind, path: p, id: it.meta.id, remote_at: it.meta.remote_at });
      this.items.delete(p);
    }
  }
  createTemplate(name: string, source: string) {
    this.templates.set(name, { source, meta: { ...blank(), dirty: true } });
  }
  renameTemplate(from: string, to: string) {
    this.call("rename_local", { kind: "template", from, to });
  }
  deleteTemplate(name: string) {
    const t = this.templates.get(name)!;
    if (t.meta.remote_at) this.tombs.push({ kind: "template", path: name, id: t.meta.id, remote_at: t.meta.remote_at });
    this.templates.delete(name);
  }

  // ---- what you can see ----
  paths(kind?: "document" | "folder") {
    return [...this.items].filter(([, it]) => !kind || it.kind === kind).map(([p]) => p).sort();
  }
  doc(path: string) {
    return this.items.get(path);
  }

  // ---- the Tauri commands sync.ts calls ----
  call(cmd: string, a: any = {}, opts?: any): unknown {
    const info = (path: string, it: Item) => ({ path, ...it.meta, has_preview: false, preview_dirty: false, preview_at: null });
    const sameTomb = (t: Tomb, kind: string, path: string, id: string | null) =>
      t.kind === kind && (t.id && id ? t.id === id : t.path === path);
    switch (cmd) {
      case "list_documents":
        return [...this.items].filter(([, it]) => it.kind === "document").map(([p, it]) => info(p, it));
      case "list_folders":
        return [...this.items].filter(([, it]) => it.kind === "folder").map(([p, it]) => info(p, it));
      case "list_templates":
        return [...this.templates].map(([p, t]) => ({ path: p, ...t.meta, builtin: false, has_preview: false, preview_dirty: false, preview_at: null }));
      case "list_configs":
        return [];
      case "list_deletions":
        return this.tombs.map((t) => ({ ...t }));
      case "clear_deletion":
        this.tombs = this.tombs.filter((t) => !sameTomb(t, a.kind, a.path, a.id));
        return;
      case "set_item_id": {
        const m = a.kind === "template" ? this.templates.get(a.path)!.meta : this.items.get(a.path)!.meta;
        m.id = a.id;
        return;
      }
      case "rename_local":
        return this.renameLocal(a.kind, a.from, a.to);
      case "load_source":
        return this.items.get(a.path)!.source;
      case "read_template":
        return this.templates.get(a.name)!.source;
      case "apply_remote": {
        const meta: Meta = { dirty: a.dirty, remote_at: a.remoteAt, id: a.id, remote_path: a.remotePath };
        if (a.kind === "template") {
          this.templates.set(a.path, { source: a.source, meta });
        } else {
          this.ensureParents(a.path);
          const old = this.items.get(a.path);
          this.items.set(a.path, { kind: a.kind, source: a.kind === "folder" ? "" : a.source, images: old?.images ?? new Map(), meta });
        }
        return;
      }
      case "mark_synced": {
        const t = a.kind === "template" ? this.templates.get(a.path) : this.items.get(a.path);
        if (!t) return false; // deleted while the push was in flight
        t.meta = { dirty: a.kind === "folder" ? false : t.source !== a.pushed, remote_at: a.remoteAt, id: a.id, remote_path: a.path };
        return true;
      }
      case "remove_local": {
        if (a.kind === "template") return void this.templates.delete(a.path);
        const it = this.items.get(a.path);
        if (!it) return;
        if (it.kind === "document") this.items.delete(a.path);
        else if (![...this.items.keys()].some((p) => p !== a.path && under(p, a.path))) this.items.delete(a.path);
        return;
      }
      case "list_images":
        return [...(this.items.get(a.path)?.images.keys() ?? [])];
      case "read_image": {
        const bytes = new TextEncoder().encode(this.items.get(a.path)!.images.get(a.name)!);
        return bytes.buffer;
      }
      case "save_image": {
        const path = decodeURIComponent(opts.headers["x-path"]);
        this.downloads.push(`${path}/${opts.headers["x-name"]}`);
        this.items.get(path)!.images.set(opts.headers["x-name"], new TextDecoder().decode(a));
        return;
      }
      default:
        throw new Error(`fake device: unhandled command ${cmd}`);
    }
  }

  private renameLocal(kind: string, from: string, to: string) {
    if (kind === "template") {
      const t = this.templates.get(from);
      if (!t) throw new Error("built-in or missing");
      if (this.templates.has(to)) throw new Error("exists");
      if (t.meta.remote_at && !t.meta.remote_path) t.meta.remote_path = from;
      this.templates.delete(from);
      this.templates.set(to, t);
      return;
    }
    if (!this.items.has(from) && this.items.has(to)) return; // moved along with a parent
    if (!this.items.has(from)) throw new Error("not found");
    this.ensureParents(to);
    for (const [p, it] of [...this.items]) {
      if (!under(p, from)) continue;
      const target = to + p.slice(from.length);
      const there = this.items.get(target);
      // merging into an implicit parent folder (no sync state) is fine; anything else is a real clash
      if (there && !(there.kind === "folder" && it.kind === "folder" && !there.meta.id && !there.meta.remote_at)) throw new Error("already exists");
      this.items.delete(p);
      this.items.set(target, it);
    }
  }
}

// ---------------------------------------------------------------- helpers

let server: Server;
let A: Device;
let B: Device;

const sync = async (d: Device) => {
  state.dev = d;
  const res = await runSync(server.api as never, "u", null);
  if (!res) throw new Error("a pass was already running");
  return res;
};
/** Both devices until nothing moves any more. */
const settle = async () => {
  for (let i = 0; i < 3; i++) {
    await sync(A);
    await sync(B);
  }
};

beforeEach(() => {
  server = new Server();
  A = new Device();
  B = new Device();
});

// ---------------------------------------------------------------- tests

describe("basic sync", () => {
  it("pushes a new document and another device pulls it, images included", async () => {
    A.createDoc("Physics/HW 1", "\\section{1}", { "fig.png": "PNG" });
    const res = await sync(A);
    expect(res.errors).toEqual([]);
    expect(server.live("document")).toHaveLength(1);
    expect(server.live("folder").map((f) => f.path)).toEqual(["Physics"]);

    await sync(B);
    expect(B.doc("Physics/HW 1")?.source).toBe("\\section{1}");
    expect(B.doc("Physics/HW 1")?.images.get("fig.png")).toBe("PNG");
    expect(B.doc("Physics/HW 1")?.meta.id).toBe(A.doc("Physics/HW 1")?.meta.id);
  });

  it("gives new items an id that is not a valid path", async () => {
    A.createDoc("HW", "x");
    await sync(A);
    expect(A.doc("HW")?.meta.id).toMatch(/^!/);
  });

  it("propagates edits", async () => {
    A.createDoc("HW", "v1");
    await settle();
    A.edit("HW", "v2");
    await sync(A);
    await sync(B);
    expect(B.doc("HW")?.source).toBe("v2");
  });

  it("an idle second pass changes nothing", async () => {
    A.createDoc("Course/HW", "x");
    A.createTemplate("Mine", "t");
    await settle();
    const before = JSON.stringify(server.docs.get([...server.docs.keys()][0]));
    const res = await sync(A);
    expect(res.errors).toEqual([]);
    expect(res.renamed).toEqual([]);
    expect(JSON.stringify(server.docs.get([...server.docs.keys()][0]))).toBe(before);
  });
});

describe("renaming a document", () => {
  it("is an update of the same server row, not a delete and a create", async () => {
    A.createDoc("HW 1", "body", { "a.png": "A" });
    await settle();
    const id = A.doc("HW 1")!.meta.id;
    const uploadsBefore = server.uploads.length;

    A.moveItem("HW 1", "Homework 1");
    expect((await sync(A)).errors).toEqual([]);

    expect(server.live("document")).toEqual([{ id, path: "Homework 1", source: "body" }]);
    expect(server.docs.size).toBe(1 + server.live("folder").length); // no tombstone, no second row
    expect([...server.docs.values()].some((r) => r.deleted_at)).toBe(false);
    expect(A.tombs).toEqual([]);
    expect(server.uploads.length).toBe(uploadsBefore); // images stay where they are
    expect(A.doc("Homework 1")?.meta.remote_path).toBe("Homework 1");
    expect(A.doc("Homework 1")?.meta.dirty).toBe(false);
  });

  it("moves the document on the other device without re-downloading its images", async () => {
    A.createDoc("HW 1", "body", { "a.png": "A" });
    await settle();
    B.downloads.length = 0;

    A.moveItem("HW 1", "Homework 1");
    await sync(A);
    const res = await sync(B);

    expect(res.errors).toEqual([]);
    expect(res.renamed).toEqual([{ kind: "document", from: "HW 1", to: "Homework 1" }]);
    expect(B.paths("document")).toEqual(["Homework 1"]);
    expect(B.doc("Homework 1")?.images.get("a.png")).toBe("A");
    expect(B.downloads).toEqual([]);
    expect(B.doc("Homework 1")?.meta.id).toBe(A.doc("Homework 1")?.meta.id);
  });

  it("moving into another folder works the same way", async () => {
    A.createDoc("HW", "body");
    A.createFolder("Physics");
    await settle();
    A.moveItem("HW", "Physics/HW");
    await sync(A);
    await sync(B);
    expect(B.paths("document")).toEqual(["Physics/HW"]);
    expect(server.live("document").map((d) => d.path)).toEqual(["Physics/HW"]);
  });

  it("a rename made offline waits and is pushed later", async () => {
    A.createDoc("HW", "body");
    await settle();
    A.moveItem("HW", "HW 2");
    expect(A.doc("HW 2")?.meta.dirty).toBe(false); // content is unchanged; the rename is detected from remote_path
    expect(A.doc("HW 2")?.meta.remote_path).toBe("HW");
    await sync(A);
    expect(server.live("document").map((d) => d.path)).toEqual(["HW 2"]);
  });

  it("rename + edit on the same device is one push", async () => {
    A.createDoc("HW", "v1");
    await settle();
    A.moveItem("HW", "HW 2");
    A.edit("HW 2", "v2");
    await sync(A);
    expect(server.live("document")).toEqual([{ id: A.doc("HW 2")!.meta.id, path: "HW 2", source: "v2" }]);
  });

  it("can reuse the old name for a new document in the same pass", async () => {
    A.createDoc("HW", "old");
    await settle();
    const oldId = A.doc("HW")!.meta.id;
    A.moveItem("HW", "HW old");
    A.createDoc("HW", "fresh");
    const res = await sync(A);
    expect(res.errors).toEqual([]);
    expect(server.live("document").map((d) => [d.path, d.source]).sort()).toEqual([["HW old", "old"], ["HW", "fresh"]]);
    expect(server.live("document").find((d) => d.path === "HW old")!.id).toBe(oldId);
    await sync(B);
    expect(B.doc("HW")?.source).toBe("fresh");
    expect(B.doc("HW old")?.source).toBe("old");
  });

  it("refuses to take a name another document already has on the server", async () => {
    A.createDoc("One", "1");
    A.createDoc("Two", "2");
    await settle();
    // B renames One to Two while offline; meanwhile the server still has both
    B.moveItem("One", "Zwei");
    A.moveItem("Two", "Zwei"); // A got there first
    await sync(A);
    const res = await sync(B);
    // two complaints: B's own rename is refused, and A's rename of "Two" cannot be applied on top of B's "Zwei"
    expect(res.errors.length).toBe(2);
    expect(res.errors.join("\n")).toMatch(/already used/);
    expect(server.live("document").map((d) => d.path).sort()).toEqual(["One", "Zwei"]);
    expect(B.doc("Zwei")?.source).toBe("1"); // nothing of B's was lost
  });
});

describe("renaming together with changes elsewhere", () => {
  it("an edit on another device survives a rename (kept as a conflict copy, newest content wins)", async () => {
    A.createDoc("HW", "v1");
    await settle();
    A.moveItem("HW", "Homework");
    await sync(A);
    B.edit("HW", "v1 + B's edit");
    const res = await sync(B);

    expect(res.errors).toEqual([]);
    expect(res.conflicts).toEqual(["Homework (conflict)"]);
    // B follows the new name instead of reverting it, and its edit is what the server has
    expect(server.live("document").map((d) => [d.path, d.source])).toEqual([["Homework", "v1 + B's edit"]]);
    expect(B.doc("Homework")?.source).toBe("v1 + B's edit");
    expect(B.doc("Homework (conflict)")?.source).toBe("v1");
  });

  it("a rename on one device and an edit on another, edit synced first, merge without a conflict", async () => {
    A.createDoc("HW", "v1");
    await settle();
    B.edit("HW", "v2");
    await sync(B); // server: HW = v2
    A.moveItem("HW", "Homework"); // A still has v1 and renamed it
    const res = await sync(A);
    expect(res.errors).toEqual([]);
    // A's copy is clean, so it takes v2 and then pushes its rename
    expect(server.live("document").map((d) => [d.path, d.source])).toEqual([["Homework", "v2"]]);
    expect(A.doc("Homework")?.source).toBe("v2");
    expect(res.conflicts).toEqual([]);
  });

  it("two renames of the same document converge on the one that syncs last", async () => {
    A.createDoc("HW", "body");
    await settle();
    A.moveItem("HW", "From A");
    B.moveItem("HW", "From B");
    await sync(A);
    await sync(B);
    await settle();
    expect(server.live("document").map((d) => d.path)).toEqual(["From B"]);
    expect(A.paths("document")).toEqual(["From B"]);
    expect(B.paths("document")).toEqual(["From B"]);
    expect(server.live("document")).toHaveLength(1);
  });

  it("a rename beats a delete made without seeing it (the document comes back under its new name)", async () => {
    A.createDoc("HW", "body");
    await settle();
    A.moveItem("HW", "Homework");
    await sync(A);
    B.deleteItem("HW"); // B had not seen the rename
    await sync(B); // the delete is conditional on the old version, so it loses
    expect(server.live("document").map((d) => d.path)).toEqual(["Homework"]);
    await sync(B);
    expect(B.paths("document")).toEqual(["Homework"]);
  });

  it("a delete after seeing the rename removes the document everywhere", async () => {
    A.createDoc("HW", "body");
    await settle();
    A.moveItem("HW", "Homework");
    await settle();
    B.deleteItem("Homework");
    await sync(B);
    await sync(A);
    expect(server.live("document")).toEqual([]);
    expect(A.paths("document")).toEqual([]);
  });

  it("a rename made after another device's delete restores the document under its new name", async () => {
    A.createDoc("HW", "body");
    await settle();
    B.deleteItem("HW");
    await sync(B);
    A.moveItem("HW", "Homework"); // changed locally after the (unseen) delete
    await sync(A);
    expect(server.live("document").map((d) => [d.path, d.source])).toEqual([["Homework", "body"]]);
  });
});

describe("folders", () => {
  beforeEach(async () => {
    A.createDoc("Physics/HW 1", "one", { "a.png": "A" });
    A.createDoc("Physics/Labs/Lab 1", "lab");
    A.createDoc("Math/HW", "math");
    await settle();
  });

  it("renaming a folder renames everything inside it on the server, with the same ids", async () => {
    const ids = new Map([...A.items].map(([p, it]) => [p, it.meta.id]));
    A.moveItem("Physics", "Phys 101");
    const res = await sync(A);
    expect(res.errors).toEqual([]);

    expect(server.live("document").map((d) => d.path)).toEqual(["Math/HW", "Phys 101/HW 1", "Phys 101/Labs/Lab 1"]);
    expect(server.live("folder").map((d) => d.path)).toEqual(["Math", "Phys 101", "Phys 101/Labs"]);
    expect([...server.docs.values()].filter((r) => r.deleted_at)).toEqual([]);
    expect(server.live("document").find((d) => d.path === "Phys 101/HW 1")!.id).toBe(ids.get("Physics/HW 1"));
    expect(server.live("folder").find((d) => d.path === "Phys 101")!.id).toBe(ids.get("Physics"));
  });

  it("the other device follows, whatever order the items come in", async () => {
    B.downloads.length = 0;
    A.moveItem("Physics", "Phys 101");
    await sync(A);
    const res = await sync(B);
    expect(res.errors).toEqual([]);
    expect(B.paths()).toEqual(["Math", "Math/HW", "Phys 101", "Phys 101/HW 1", "Phys 101/Labs", "Phys 101/Labs/Lab 1"]);
    expect(B.doc("Phys 101/HW 1")?.images.get("a.png")).toBe("A");
    expect(B.downloads).toEqual([]);
    // and everything is quiet afterwards
    expect((await sync(B)).renamed).toEqual([]);
    expect((await sync(A)).renamed).toEqual([]);
  });

  it("moving a folder into another folder", async () => {
    A.moveItem("Physics/Labs", "Math/Labs");
    await sync(A);
    await sync(B);
    expect(B.paths("document")).toEqual(["Math/HW", "Math/Labs/Lab 1", "Physics/HW 1"]);
    expect(server.live("document").map((d) => d.path)).toEqual(["Math/HW", "Math/Labs/Lab 1", "Physics/HW 1"]);
  });

  it("deleting a folder deletes what is in it", async () => {
    A.deleteItem("Physics");
    await sync(A);
    await sync(B);
    expect(B.paths()).toEqual(["Math", "Math/HW"]);
    expect(server.live("document").map((d) => d.path)).toEqual(["Math/HW"]);
  });

  it("an edit inside a folder that was renamed elsewhere is kept", async () => {
    A.moveItem("Physics", "Phys 101");
    await sync(A);
    B.edit("Physics/HW 1", "one, edited on B");
    await sync(B);
    await settle();
    expect(server.live("document").map((d) => [d.path, d.source]).filter(([p]) => p.endsWith("HW 1"))).toEqual([
      ["Phys 101/HW 1", "one, edited on B"],
    ]);
    expect(A.doc("Phys 101/HW 1")?.source).toBe("one, edited on B");
    expect(B.paths("document")).toEqual(A.paths("document"));
  });
});

describe("templates", () => {
  it("a template rename is an update and keeps its id", async () => {
    A.createTemplate("Article", "tpl");
    await settle();
    const id = A.templates.get("Article")!.meta.id;
    A.renameTemplate("Article", "Paper");
    expect((await sync(A)).errors).toEqual([]);
    expect(server.live("template")).toEqual([{ id, path: "Paper", source: "tpl" }]);
    expect(server.templates.size).toBe(1);

    const res = await sync(B);
    expect(res.errors).toEqual([]);
    expect([...B.templates.keys()]).toEqual(["Paper"]);
  });

  it("the other device renames its copy", async () => {
    A.createTemplate("Article", "tpl");
    await settle();
    A.renameTemplate("Article", "Paper");
    await sync(A);
    const res = await sync(B);
    expect([...B.templates.keys()]).toEqual(["Paper"]);
    expect(res.renamed).toEqual([{ kind: "template", from: "Article", to: "Paper" }]);
  });

  it("deleting a renamed template removes it by id", async () => {
    A.createTemplate("Article", "tpl");
    await settle();
    A.renameTemplate("Article", "Paper");
    await settle();
    A.deleteTemplate("Paper");
    await sync(A);
    await sync(B);
    expect(server.live("template")).toEqual([]);
    expect([...B.templates.keys()]).toEqual([]);
  });
});

describe("items from before ids existed", () => {
  /** What an older version of the app left behind: server rows whose id is their path, local items without ids. */
  function legacy() {
    server.docs.set("HW", { id: "HW", kind: "document", path: "HW", source: "body", updated_at: "L0001", deleted_at: null, preview_at: null });
    server.docs.set("Course", { id: "Course", kind: "folder", path: "Course", source: "", updated_at: "L0002", deleted_at: null, preview_at: null });
    server.docs.set("Course/Old", { id: "Course/Old", kind: "document", path: "Course/Old", source: "old", updated_at: "L0003", deleted_at: null, preview_at: null });
    server.files.set("HW/images/a.png", "A");
    for (const d of [A, B]) {
      d.items.set("HW", { kind: "document", source: "body", images: new Map([["a.png", "A"]]), meta: { ...blank(), remote_at: "L0001" } });
      d.items.set("Course", { kind: "folder", source: "", images: new Map(), meta: { ...blank(), remote_at: "L0002" } });
      d.items.set("Course/Old", { kind: "document", source: "old", images: new Map(), meta: { ...blank(), remote_at: "L0003" } });
    }
  }

  it("adopt the server's ids without re-downloading anything, and keep their files where they are", async () => {
    legacy();
    const res = await sync(A);
    expect(res.errors).toEqual([]);
    expect(A.doc("HW")?.meta.id).toBe("HW");
    expect(A.doc("Course/Old")?.meta.id).toBe("Course/Old");
    expect(res.pulled).toEqual([]);
    expect(server.docs.size).toBe(3);
    expect(A.downloads).toEqual([]);
  });

  it("can then be renamed like anything else, and storage keys stay the old path", async () => {
    legacy();
    await settle();
    A.moveItem("HW", "Homework");
    await sync(A);
    expect(server.live("document").find((d) => d.path === "Homework")!.id).toBe("HW");
    expect(server.docs.size).toBe(3);
    await sync(B);
    expect(B.paths("document")).toEqual(["Course/Old", "Homework"]);
    expect(B.doc("Homework")?.images.get("a.png")).toBe("A");
    expect(server.files.has("HW/images/a.png")).toBe(true);
  });

  it("a legacy copy follows a rename made by a device that already has ids", async () => {
    legacy();
    await sync(A);
    A.moveItem("HW", "Homework");
    await sync(A);
    const res = await sync(B); // B is still on the old version of the data
    expect(res.errors).toEqual([]);
    expect(B.paths("document")).toEqual(["Course/Old", "Homework"]);
  });

  it("a legacy tombstone with no id still deletes by path", async () => {
    legacy();
    B.tombs.push({ kind: "document", path: "Course/Old", id: null, remote_at: "L0003" });
    B.items.delete("Course/Old");
    await sync(B);
    expect(server.live("document").map((d) => d.path)).toEqual(["HW"]);
  });

  it("a legacy tombstoned name can be reused by a brand new document", async () => {
    legacy();
    server.docs.get("HW")!.deleted_at = "now";
    server.docs.get("HW")!.updated_at = "L0009";
    for (const d of [A, B]) d.items.delete("HW");
    A.createDoc("HW", "second life");
    const res = await sync(A);
    expect(res.errors).toEqual([]);
    expect(server.live("document").find((d) => d.path === "HW")!.source).toBe("second life");
    expect(server.live("document").find((d) => d.path === "HW")!.id).toMatch(/^!/);
  });
});

describe("ids from the short-lived '~' form", () => {
  it("map to the '!' form that migration 0010 gave the server rows", async () => {
    server.docs.set("!abc", { id: "!abc", kind: "document", path: "HW", source: "body", updated_at: "L1", deleted_at: null, preview_at: null });
    A.items.set("HW", { kind: "document", source: "body", images: new Map(), meta: { ...blank(), remote_at: "L1", id: "~abc", remote_path: "HW" } });
    const res = await sync(A);
    expect(res.errors).toEqual([]);
    expect(A.doc("HW")?.meta.id).toBe("!abc");
    expect(server.docs.size).toBe(1);
  });

  it("also in a pending deletion", async () => {
    server.docs.set("!abc", { id: "!abc", kind: "document", path: "HW", source: "body", updated_at: "L1", deleted_at: null, preview_at: null });
    A.tombs.push({ kind: "document", path: "HW", id: "~abc", remote_at: "L1" });
    await sync(A);
    expect(server.live("document")).toEqual([]);
  });
});

describe("deleting what was just created", () => {
  it("a synced copy stays deleted", async () => {
    A.createDoc("hw5", "body");
    await settle();
    A.createDoc("hw5 copy", "body");
    await sync(A);
    A.deleteItem("hw5 copy");
    await sync(A);
    await sync(A);
    expect(A.paths("document")).toEqual(["hw5"]);
    expect(server.live("document").map((d) => d.path)).toEqual(["hw5"]);
  });

  it("deleted while its first push is in flight", async () => {
    A.createDoc("copy", "body");
    const insert = server.api.insertDoc;
    server.api.insertDoc = async (...args: Parameters<typeof insert>) => {
      const at = await insert(...args);
      A.deleteItem("copy"); // the user deletes it while the request is on its way
      return at;
    };
    await sync(A);
    server.api.insertDoc = insert;
    await sync(A);
    await sync(A);
    expect(A.paths("document")).toEqual([]);
    expect(server.live("document")).toEqual([]);
  });

  it("a deletion the server does not apply stays queued instead of the item coming back silently", async () => {
    A.createDoc("copy", "body");
    await settle();
    A.deleteItem("copy");
    const del = server.api.deleteDoc;
    server.api.deleteDoc = async () => false; // e.g. the row could not be matched
    const res = await sync(A);
    expect(res.errors.join()).toMatch(/did not apply the deletion/);
    expect(A.tombs).toHaveLength(1);
    server.api.deleteDoc = del;
    await sync(A);
    expect(A.tombs).toEqual([]);
    expect(server.live("document")).toEqual([]);
    expect(A.paths("document")).toEqual([]);
  });

  it("deleted and recreated by a late autosave, the old row is not resurrected", async () => {
    A.createDoc("copy", "body");
    await settle();
    A.deleteItem("copy");
    A.createDoc("copy", "body"); // a pending editor save writes the file back
    await sync(A);
    await sync(A);
    expect(server.live("document").map((d) => d.path)).toEqual(["copy"]);
    expect(A.paths("document")).toEqual(["copy"]);
  });
});

describe("the same name created on two devices", () => {
  it("keeps both versions (the old conflict behaviour)", async () => {
    A.createDoc("HW", "from A");
    B.createDoc("HW", "from B");
    await sync(A);
    const res = await sync(B);
    expect(res.errors).toEqual([]);
    expect(res.conflicts).toEqual(["HW (conflict)"]);
    await settle();
    expect(server.live("document").map((d) => [d.path, d.source]).sort()).toEqual([
      ["HW (conflict)", "from A"],
      ["HW", "from B"],
    ]);
    expect(A.paths("document")).toEqual(B.paths("document"));
  });
});

describe("an interrupted first push", () => {
  it("is recognised on the next pass instead of creating a duplicate", async () => {
    A.createDoc("HW", "body");
    // the row reaches the server, but the device never learns about it
    state.dev = A;
    A.call("set_item_id", { kind: "document", path: "HW", id: "!lost" });
    await server.api.insertDoc("document", "!lost", "HW", "body");
    const res = await sync(A);
    expect(res.errors).toEqual([]);
    expect(res.conflicts).toEqual([]); // no "(conflict)" copy of itself
    expect(server.live("document")).toHaveLength(1);
  });
});
