// Downloads the tectonic binary that Tauri bundles as a sidecar (bundle.externalBin = binaries/tectonic).
// Tauri wants it at src-tauri/binaries/tectonic-<rust target triple>[.exe]; this runs before `tauri dev`/`build`
// (see build.beforeDevCommand / beforeBuildCommand) and does nothing when the right file is already there.
//
// Pinned to one release and checked against its SHA-256, so a build is reproducible. To upgrade, change VERSION
// and the digests below (GitHub shows each asset's digest on the release page).
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.17.0";
// Rust target triple -> [release asset (without the version), sha256]. Linux uses the static musl build so the
// sidecar runs on any distro, whatever libraries it has.
const ASSETS = {
  "x86_64-unknown-linux-gnu": ["x86_64-unknown-linux-musl.tar.gz", "8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7"],
  "aarch64-unknown-linux-gnu": ["aarch64-unknown-linux-musl.tar.gz", "b10954a95404f3ab2328d2fa59a5ebab8e657f893fab096f98be8db7c0c979b8"],
  "x86_64-apple-darwin": ["x86_64-apple-darwin.tar.gz", "7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80"],
  "aarch64-apple-darwin": ["aarch64-apple-darwin.tar.gz", "a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667"],
  "x86_64-pc-windows-msvc": ["x86_64-pc-windows-msvc.zip", "f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f"],
};

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "src-tauri", "binaries");

function hostTriple() {
  const line = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).split("\n").find((l) => l.startsWith("host:"));
  return line.slice(5).trim();
}

async function fetchOne(triple) {
  const spec = ASSETS[triple];
  if (!spec) throw new Error(`No tectonic build for ${triple}. Add it to ASSETS in scripts/fetch-tectonic.mjs.`);
  const [asset, sha] = spec;
  const exe = triple.includes("windows") ? ".exe" : "";
  const dest = join(outDir, `tectonic-${triple}${exe}`);
  const stamp = `${dest}.sha256`;
  if (existsSync(dest) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === sha) return dest;

  const url = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${VERSION}/tectonic-${VERSION}-${asset}`;
  console.log(`Downloading tectonic ${VERSION} for ${triple}…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== sha) throw new Error(`Checksum mismatch for ${asset}: expected ${sha}, got ${got}`);

  const tmp = mkdtempSync(join(tmpdir(), "tectonic-"));
  try {
    const archive = join(tmp, asset);
    writeFileSync(archive, bytes);
    execFileSync("tar", ["-xf", archive, "-C", tmp]); // bsdtar (macOS, Windows 10+) also reads .zip
    mkdirSync(outDir, { recursive: true });
    copyFileSync(join(tmp, `tectonic${exe}`), dest);
    if (!exe) chmodSync(dest, 0o755);
    writeFileSync(stamp, sha + "\n");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return dest;
}

const triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
if (triple === "universal-apple-darwin") {
  // A universal macOS app needs both slices, plus one binary holding both.
  const a = await fetchOne("aarch64-apple-darwin");
  const x = await fetchOne("x86_64-apple-darwin");
  execFileSync("lipo", ["-create", a, x, "-output", join(outDir, "tectonic-universal-apple-darwin")]);
} else {
  await fetchOne(triple);
}
