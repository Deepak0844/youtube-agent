import { describe, expect, it } from "vitest";
import { badCheck, dockerVersion, ffVersion, okCheck, toolsSummary } from "@/server/core/tool-check";
import { cachedToolChecks, runToolChecks } from "@/server/render/tool-check";

describe("version parsing", () => {
  it("reads the version from the first line of ffmpeg and ffprobe, and refuses anything else", () => {
    expect(ffVersion("ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers\nbuilt with Apple clang", "ffmpeg")).toBe("7.1.1");
    expect(ffVersion("ffprobe version n6.0-4ubuntu1 Copyright", "ffprobe")).toBe("n6.0-4ubuntu1");
    expect(ffVersion("ffprobe version 7.1", "ffmpeg")).toBeNull();
    expect(ffVersion("command not found", "ffmpeg")).toBeNull();
    expect(ffVersion("", "ffprobe")).toBeNull();
  });
  it("accepts a docker server version and nothing that looks like an error or a path", () => {
    expect(dockerVersion("27.1.0\n")).toBe("27.1.0");
    expect(dockerVersion("29.4.0")).toBe("29.4.0");
    for (const bad of ["", "Cannot connect to the Docker daemon at unix:///x/docker.sock", "/usr/local/bin/docker", "<no value>", "x".repeat(60)]) expect(dockerVersion(bad), bad).toBeNull();
  });
});

describe("summary", () => {
  it("says all ready, or names what needs attention", () => {
    expect(toolsSummary([okCheck("ffmpeg", "v"), okCheck("docker", "v")])).toEqual({ ok: true, line: "All 2 tools are ready." });
    const s = toolsSummary([okCheck("ffmpeg", "v"), badCheck("docker", "x"), badCheck("render_image", "y")]);
    expect(s).toEqual({ ok: false, line: "2 of 3 tools need attention: Docker, Render image." });
  });
  it("a failing check carries a plain fix, a working one carries none", () => {
    expect(badCheck("ffmpeg", "Not found.").fix).toMatch(/brew install ffmpeg/);
    expect(badCheck("render_image", "x").fix).toMatch(/npm run image:render/);
    expect(okCheck("ffmpeg", "version 1").fix).toBeNull();
  });
});

const buf = (s: string) => Buffer.from(s);
type Ex = NonNullable<Parameters<typeof runToolChecks>[0]>["exec"];
/** A scripted exec: answers by command line, or fails. */
const scripted = (answers: Record<string, string | Error>): { ex: Ex; calls: string[] } => {
  const calls: string[] = [];
  const ex: Ex = async (bin, args) => {
    const key = `${bin} ${args.join(" ")}`;
    calls.push(key);
    const a = answers[key];
    if (a === undefined || a instanceof Error) throw a ?? new Error("not scripted");
    return buf(a);
  };
  return { ex, calls };
};
const ALL = {
  "ffmpeg -version": "ffmpeg version 7.1.1 Copyright",
  "ffprobe -version": "ffprobe version 7.1.1 Copyright",
  "docker info --format {{.ServerVersion}}": "27.1.0\n",
  "docker image inspect ytstudio-render:dev --format {{.Id}}": `sha256:${"a".repeat(64)}\n`,
};

describe("runToolChecks", () => {
  it("everything present: four ready rows with versions", async () => {
    const { ex } = scripted(ALL);
    const r = await runToolChecks({ exec: ex, env: { PATH: "/bin" } });
    expect(r.map((c) => [c.id, c.ok, c.detail])).toEqual([["ffmpeg", true, "version 7.1.1"], ["ffprobe", true, "version 7.1.1"], ["docker", true, "version 27.1.0"], ["render_image", true, "Built and ready."]]);
  });
  it("a missing tool is one failing row and does not stop the other checks", async () => {
    const { ex } = scripted({ ...ALL, "ffmpeg -version": new Error("ENOENT /usr/secret/path/ffmpeg") });
    const r = await runToolChecks({ exec: ex, env: {} });
    expect(r[0]).toMatchObject({ id: "ffmpeg", ok: false, detail: "Not found." });
    expect(r.slice(1).every((c) => c.ok)).toBe(true);
    expect(JSON.stringify(r)).not.toContain("secret"); // an error's text (paths, hosts) never reaches the page
  });
  it("Docker down: docker fails and the image cannot be checked, without running the image command", async () => {
    const { ex, calls } = scripted({ ...ALL, "docker info --format {{.ServerVersion}}": new Error("Cannot connect") });
    const r = await runToolChecks({ exec: ex, env: {} });
    expect(r.find((c) => c.id === "docker")).toMatchObject({ ok: false, detail: "Not running or not installed." });
    expect(r.find((c) => c.id === "render_image")).toMatchObject({ ok: false, detail: "Cannot be checked until Docker runs." });
    expect(calls.some((c) => c.includes("image inspect"))).toBe(false);
  });
  it("image not built: only the image row fails", async () => {
    const { ex } = scripted({ ...ALL, "docker image inspect ytstudio-render:dev --format {{.Id}}": new Error("No such image") });
    const r = await runToolChecks({ exec: ex, env: {} });
    expect(r.filter((c) => !c.ok).map((c) => [c.id, c.detail])).toEqual([["render_image", "Not built on this computer."]]);
  });
  it("a program that answers with something else is 'found, but did not answer like ffmpeg'", async () => {
    const { ex } = scripted({ ...ALL, "ffprobe -version": "something else entirely" });
    expect((await runToolChecks({ exec: ex, env: {} }))[1]).toMatchObject({ id: "ffprobe", ok: false, detail: "Found, but it did not answer like ffmpeg." });
  });
  it("runs fixed commands only, in a clean environment (no secrets passed on)", async () => {
    const seen: Array<Record<string, string>> = [];
    const ex: Ex = async (_bin, _args, o) => { seen.push(o.env); return buf("ffmpeg version 1"); };
    await runToolChecks({ exec: ex, env: { PATH: "/bin", LANG: "C", DATABASE_URL: "postgres://secret", ELEVENLABS_API_KEY: "k" } });
    for (const env of seen) expect(Object.keys(env).sort()).toEqual(["LANG", "PATH"]);
  });
});

describe("cachedToolChecks", () => {
  it("remembers the answer for a minute and checks again after", async () => {
    let t = 1_000_000;
    const first = await cachedToolChecks(() => t);
    const again = await cachedToolChecks(() => (t += 30_000));
    expect(again).toBe(first); // same object: no new processes
    const later = await cachedToolChecks(() => (t += 40_000));
    expect(later).not.toBe(first);
  });
});
