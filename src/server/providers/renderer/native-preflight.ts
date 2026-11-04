import { accessSync, constants, readdirSync, readFileSync, realpathSync, statfsSync } from "node:fs";
import path from "node:path";

// Phase 5d: can this machine render 3D videos natively? Plain sentences for the owner; read only, never downloads anything.
// The Chrome headless shell is fetched once by the owner with `npx remotion browser ensure` (the worker never downloads).

/** Must equal the Remotion version in package.json and in the render image (infra/Dockerfile.render). */
export const REMOTION_PIN = "4.0.538";
export const NATIVE_MODULES = ["@remotion/renderer", "@remotion/bundler"] as const;
export const MIN_FREE_BYTES = 5 * 1024 ** 3;
const ENSURE_HINT = "Run `npx remotion browser ensure` once in the project folder, then reload this page.";

export interface NativeReadiness {
  ready: boolean;
  /** One short, plain paragraph for /settings/system. */
  message: string;
  /** Folder holding the Chrome headless shell (readable by the sandbox), when found. */
  chromeDir: string | null;
}

export interface PreflightDeps {
  platform?: string;
  /** Repo root: where node_modules lives. */
  repoRoot?: string;
  /** Folder whose free space is checked (the storage root). */
  storageRoot?: string;
  sandboxExec?: string;
  /** Version of an installed module, or null when it cannot be resolved. */
  moduleVersion?: (name: string, repoRoot: string) => string | null;
  /** Full path of the Chrome headless shell binary under the repo's node_modules/.remotion, or null. */
  findChrome?: (repoRoot: string) => string | null;
  executable?: (file: string) => boolean;
  freeBytes?: (dir: string) => number | null;
}

function moduleVersionOf(name: string, repoRoot: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(path.join(repoRoot, "node_modules", name, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** The headless shell Remotion downloads into node_modules/.remotion (a few levels deep). */
function findChromeShell(repoRoot: string): string | null {
  const base = path.join(repoRoot, "node_modules", ".remotion");
  const walk = (dir: string, depth: number): string | null => {
    let names: import("node:fs").Dirent[];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const n of names) {
      const f = path.join(dir, n.name);
      if (n.isFile() && (n.name === "headless_shell" || n.name === "chrome-headless-shell")) return f;
    }
    if (depth > 0) for (const n of names) if (n.isDirectory()) { const r = walk(path.join(dir, n.name), depth - 1); if (r) return r; }
    return null;
  };
  return walk(base, 5);
}

const isExecutable = (f: string): boolean => {
  try {
    accessSync(f, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const freeBytesOf = (dir: string): number | null => {
  try {
    const s = statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
};

/** Checks every prerequisite; returns what is missing as plain sentences. Never throws, never downloads. */
export async function checkNativeRenderReady(d: PreflightDeps = {}): Promise<NativeReadiness> {
  const platform = d.platform ?? process.platform;
  const repoRoot = d.repoRoot ?? process.cwd();
  const problems: string[] = [];
  let chromeDir: string | null = null;
  if (platform !== "darwin") {
    problems.push("native 3D rendering works only on a Mac");
  } else {
    if (!(d.executable ?? isExecutable)(d.sandboxExec ?? "/usr/bin/sandbox-exec")) problems.push("the macOS sandbox program (sandbox-exec) is missing, so the render could not be locked down");
    const version = d.moduleVersion ?? moduleVersionOf;
    for (const m of NATIVE_MODULES) {
      const v = version(m, repoRoot);
      if (v === null) problems.push(`${m} is not installed (run npm install)`);
      else if (v !== REMOTION_PIN) problems.push(`${m} is version ${v} but must be ${REMOTION_PIN}`);
    }
    const shell = (d.findChrome ?? findChromeShell)(repoRoot);
    if (shell === null) problems.push("the Chrome headless shell is not downloaded yet");
    else {
      try {
        chromeDir = realpathSync(path.dirname(shell));
      } catch {
        chromeDir = path.dirname(shell);
      }
    }
    const free = (d.freeBytes ?? freeBytesOf)(d.storageRoot ?? repoRoot);
    if (free !== null && free < MIN_FREE_BYTES) problems.push(`less than ${MIN_FREE_BYTES / 1024 ** 3} GB of disk is free`);
  }
  if (problems.length === 0) return { ready: true, message: "Ready: this Mac can render 3D videos natively.", chromeDir };
  const hint = problems.some((p) => p.includes("Chrome")) ? ` ${ENSURE_HINT}` : "";
  return { ready: false, message: `Not ready: ${problems.join("; ")}.${hint}`, chromeDir: null };
}
