// Brings OpenMontage (AGPL-3.0) files into this app from a pinned upstream commit, then re-applies our edits.
//   npm run openmontage:sync -- --ref <commit|main> [--upstream <dir>]   copy the keep-list at that commit, apply patches, update the pin
//   npm run openmontage:sync -- --make-patches                           write patches/ from our edits vs the pinned commit
// The keep-list is engine-kit/openmontage/MANIFEST.json; nothing outside it is copied. Text files only are patched.
// Dev-only tool: never run at app runtime.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const KIT = "engine-kit/openmontage";
const PATCHES = path.join(KIT, "patches");
type Manifest = { repo: string; files: Array<{ from: string; to: string }> };
type Pin = { repo: string; commit: string; date: string };

const manifest = JSON.parse(readFileSync(path.join(KIT, "MANIFEST.json"), "utf8")) as Manifest;
const pin = JSON.parse(readFileSync(path.join(KIT, "UPSTREAM.json"), "utf8")) as Pin;
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const upstream = arg("--upstream") ?? path.join(homedir(), "Personal/openmontage-upstream");
const git = (...a: string[]) => execFileSync("git", ["-C", upstream, ...a], { encoding: "utf8", maxBuffer: 256 << 20 }).trim();
const patchName = (to: string) => `${to.replace(/\//g, "__")}.patch`;
const isText = (f: string) => !/\.(woff2?|ttf|otf|png|jpe?g|webp|mp3|wav|mp4)$/i.test(f);

/** Exports the manifest's source files at a commit into a fresh temp folder. */
function exportAt(commit: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "om-sync-"));
  for (const { from } of manifest.files) {
    const out = path.join(dir, from);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, execFileSync("git", ["-C", upstream, "show", `${commit}:${from}`], { maxBuffer: 256 << 20 }));
  }
  return dir;
}

function makePatches(): void {
  const pristine = exportAt(pin.commit);
  try {
    rmSync(PATCHES, { recursive: true, force: true });
    mkdirSync(PATCHES, { recursive: true });
    for (const { from, to } of manifest.files.filter((f) => isText(f.to))) {
      let diff = "";
      try {
        execFileSync("diff", ["-u", "--label", `a/${to}`, "--label", `b/${to}`, path.join(pristine, from), to], { encoding: "utf8" });
      } catch (e) {
        diff = (e as { stdout?: string }).stdout ?? "";
      }
      if (diff) writeFileSync(path.join(PATCHES, patchName(to)), diff);
    }
    console.log(`patches: ${readdirSync(PATCHES).join(", ") || "none"}`);
  } finally {
    rmSync(pristine, { recursive: true, force: true });
  }
}

function sync(ref: string): void {
  git("fetch", "--quiet", "origin");
  const commit = git("rev-parse", ref === "main" ? "origin/main" : ref);
  const date = git("show", "-s", "--format=%cI", commit);
  const fresh = exportAt(commit);
  const changed: string[] = [];
  const conflicts: string[] = [];
  try {
    for (const { from, to } of manifest.files) {
      const before = existsSync(to) ? readFileSync(to) : null;
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(path.join(fresh, from), to);
      const p = path.join(PATCHES, patchName(to));
      if (existsSync(p)) {
        try {
          execFileSync("git", ["apply", "--whitespace=nowarn", p], { stdio: "pipe" });
        } catch {
          conflicts.push(to);
        }
      }
      if (!before || !before.equals(readFileSync(to))) changed.push(to);
    }
    // Upstream files in the folders we take from but not in the keep-list: new components, skills or styles to consider.
    const kept = new Set(manifest.files.map((f) => f.from));
    const watched = ["remotion-composer/src", "styles", "skills", "pipeline_defs"];
    const unseen = git("ls-tree", "-r", "--name-only", commit, "--", ...watched).split("\n").filter((f) => f && !kept.has(f));
    writeFileSync(path.join(KIT, "UPSTREAM.json"), `${JSON.stringify({ repo: manifest.repo, commit, date }, null, 2)}\n`);
    console.log(`OpenMontage ${pin.commit.slice(0, 7)} -> ${commit.slice(0, 7)} (${date})`);
    console.log(`changed (${changed.length}):\n  ${changed.join("\n  ") || "-"}`);
    console.log(`patches that no longer apply (${conflicts.length}):\n  ${conflicts.join("\n  ") || "-"}`);
    console.log(`upstream files not in the keep-list (${unseen.length}), e.g.:\n  ${unseen.slice(0, 40).join("\n  ")}`);
    if (conflicts.length) process.exitCode = 1;
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
}

if (process.argv.includes("--make-patches")) makePatches();
else sync(arg("--ref") ?? pin.commit);
