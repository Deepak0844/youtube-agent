import type { Entry3d } from "./schema";

// assets3d/LICENSES.md is generated from the manifest (npm run assets3d:licenses); a test keeps it in step.
export function renderLicenses(entries: readonly Entry3d[]): string {
  const lines = [
    "# 3D asset licences",
    "",
    "Generated from assets3d/manifest.json. Do not edit by hand. Every entry is CC0 1.0 or Public Domain; the evidence is the line we saw on the source page.",
    "",
    "| id | name | author | licence | source page | evidence |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  const cell = (s: string) => s.replace(/\|/g, "/").replace(/\s+/g, " ");
  for (const e of entries) {
    lines.push(`| ${e.id} | ${cell(e.name)} | ${cell(e.author)} | ${e.license} | ${e.url} | ${cell(e.license_evidence)} |`);
  }
  return lines.join("\n") + "\n";
}
