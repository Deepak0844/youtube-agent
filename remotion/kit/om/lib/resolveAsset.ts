import { staticFile } from "remotion";

// ytstudio: the render box has no network and no host files. Every asset is a file staged in the render's public folder,
// reached through staticFile(); remote URLs, data: URLs, file:// and absolute paths are refused (render error).
/** Resolve a staged public asset. */
export function resolveAsset(src: string): string {
  const clean = src.replace(/^\.\//, "");
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/.test(clean) || clean.split("/").includes("..")) {
    throw new Error(`asset "${src.slice(0, 80)}" is not a staged file name`);
  }
  return staticFile(clean);
}
