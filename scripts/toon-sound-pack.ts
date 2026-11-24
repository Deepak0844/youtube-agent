// Dev only (Mac, needs python3 with numpy, ffmpeg and a clone of cartoon-shorts): makes the cartoon sound pack from cartoon-shorts' own synth (engine/audio.py, MIT).
//   npx tsx scripts/toon-sound-pack.ts [~/Personal/test-work/cartoon-shorts]
// Writes assets-builtin/audio/sfx/clips/toon-*.mp3 and assets-builtin/audio/music/clips/toon-*.mp3 (loudness-normalised like the rest of the library:
// about -20 LUFS, -1.5 dBFS peak) and rewrites the "toon-" entries of both catalog.json and palette.json. Run again to remake them; other entries are untouched.
// Import into the app's library afterwards: npx tsx scripts/audio-library-import.ts. No Python runs in the app or its render container.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const up = path.resolve((process.argv[2] ?? "~/Personal/test-work/cartoon-shorts").replace(/^~/, os.homedir()));
const LICENCE = "generated locally by scripts/toon-sound-pack.ts from cartoon-shorts engine/audio.py (MIT, Copyright (c) 2026 Matteoikarieth96; numpy synthesis); no third-party samples; redistributable";

// what each sound is for, so the engine can find it by tag (every sound also gets the tags toon, cartoon and comic)
const SFX: Record<string, { category: string; desc: string; tags: string[] }> = {
  bell: { category: "chime", desc: "a school bell ringing", tags: ["bell", "school", "ring", "alarm"] },
  bounce: { category: "motion", desc: "a rubber bounce", tags: ["bounce", "boing", "spring", "rubber"] },
  buzzer: { category: "emphasis", desc: "a wrong-answer buzzer", tags: ["buzzer", "wrong", "no", "error", "nope"] },
  chop: { category: "snap", desc: "one knife chop", tags: ["chop", "knife", "cut", "kitchen"] },
  chops: { category: "snap", desc: "a run of knife chops", tags: ["chops", "knife", "chopping", "kitchen"] },
  cymbal: { category: "emphasis", desc: "a crash cymbal swell", tags: ["cymbal", "crash", "finale", "big"] },
  ding: { category: "chime", desc: "a small bright bell: payment received, a correct answer", tags: ["ding", "bell", "received", "correct", "notification"] },
  flash: { category: "motion", desc: "a camera flash zap", tags: ["flash", "zap", "photo", "light"] },
  heartbeat: { category: "tension", desc: "a heartbeat thump", tags: ["heartbeat", "thump", "nervous", "tension"] },
  hit: { category: "impact", desc: "a short comic hit", tags: ["hit", "punch", "thud", "comic"] },
  impact: { category: "impact", desc: "a big comic impact", tags: ["impact", "boom", "slam", "crash"] },
  kick: { category: "impact", desc: "a kick drum", tags: ["kick", "drum", "beat", "thump"] },
  plop: { category: "motion", desc: "a drop landing in water or a basket", tags: ["plop", "drop", "water", "land"] },
  pop: { category: "snap", desc: "a small pop: something appears", tags: ["pop", "appear", "bubble", "reveal"] },
  pour: { category: "motion", desc: "liquid poured", tags: ["pour", "liquid", "water", "kitchen"] },
  riser: { category: "tension", desc: "a rising whoosh into a reveal", tags: ["riser", "build", "tension", "reveal"] },
  rewind: { category: "motion", desc: "a tape rewind", tags: ["rewind", "tape", "back", "undo"] },
  sizzle: { category: "ambience", desc: "food sizzling in a pan", tags: ["sizzle", "fry", "pan", "kitchen"] },
  sparkle: { category: "chime", desc: "a magic sparkle", tags: ["sparkle", "magic", "shine", "twinkle"] },
  squeak: { category: "snap", desc: "a comic squeak", tags: ["squeak", "worry", "mouse", "funny"] },
  sub: { category: "impact", desc: "a deep sub drop", tags: ["sub", "bass", "drop", "deep"] },
  swish: { category: "motion", desc: "a quick swish", tags: ["swish", "swoosh", "fast", "pass"] },
  taiko: { category: "impact", desc: "a taiko drum hit", tags: ["taiko", "drum", "epic", "big"] },
  tick: { category: "snap", desc: "a clock tick", tags: ["tick", "clock", "time", "click"] },
  trumpet: { category: "emphasis", desc: "a short trumpet fanfare call", tags: ["trumpet", "fanfare", "win", "announce"] },
  typewriter: { category: "snap", desc: "typewriter keys", tags: ["typewriter", "typing", "keys", "text"] },
  whoosh: { category: "motion", desc: "a scene-cut whoosh", tags: ["whoosh", "cut", "transition", "air"] },
};
const MUSIC: Record<string, { desc: string; tags: string[] }> = {
  groove: { desc: "light fun momentum, a groove under quick explainers", tags: ["groove", "fun", "light", "upbeat"] },
  rise: { desc: "a building, hopeful rise", tags: ["rise", "build", "hope", "energy"] },
  tense: { desc: "ticking clock and heartbeat, something is at stake", tags: ["tense", "suspense", "clock", "stakes"] },
  triumph: { desc: "a bright, winning fanfare feel", tags: ["triumph", "win", "victory", "fanfare"] },
  warm: { desc: "warm, cosy chords", tags: ["warm", "cosy", "gentle", "friendly"] },
  end: { desc: "a settling final-chord mood for the last scene", tags: ["end", "finale", "resolve", "settle"] },
  sad: { desc: "a soft sad piano and strings mood", tags: ["sad", "soft", "emotional", "slow"] },
  home: { desc: "a homely, comforting mood", tags: ["home", "comfort", "family", "calm"] },
  promise: { desc: "a hopeful, promising mood", tags: ["promise", "hope", "bright", "begin"] },
  epic: { desc: "big drums and brass for a big moment", tags: ["epic", "drums", "big", "heroic"] },
};

const ff = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });
const dur = (f: string) => Math.round(Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }).trim()) * 100) / 100;
const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown> & { clips?: Record<string, unknown>[]; sounds?: Record<string, unknown>[]; beds?: Record<string, unknown>[] };

const tmp = mkdtempSync(path.join(os.tmpdir(), "toon-pack-"));
try {
  execFileSync("python3", [path.join(root, "scripts/toon-sound-pack.py"), up, tmp], { stdio: "inherit" });
  for (const [kind, table] of [["sfx", SFX], ["music", MUSIC]] as const) {
    const dir = path.join(root, "assets-builtin/audio", kind);
    mkdirSync(path.join(dir, "clips"), { recursive: true });
    const cat = readJson(path.join(dir, "catalog.json"));
    const pal = readJson(path.join(dir, "palette.json"));
    const key = kind === "sfx" ? "sounds" : "beds";
    const keep = (e: Record<string, unknown>) => !String(e.id).startsWith("toon-");
    cat.clips = (cat.clips ?? []).filter(keep);
    pal[key] = (pal[key] ?? []).filter(keep);
    for (const [name, meta] of Object.entries(table)) {
      const id = `toon-${name}`;
      const out = path.join(dir, "clips", `${id}.mp3`);
      // loudness like the rest of the library: about -20 LUFS, -1.5 dBFS peak; one channel, 44.1 kHz
      ff(["-i", path.join(tmp, kind, `${name}.wav`), "-af", "loudnorm=I=-20:TP=-1.5:LRA=7", "-ar", "44100", "-ac", "1", "-codec:a", "libmp3lame", "-q:a", "3", out]);
      const tags = [...new Set([...meta.tags, "toon", "cartoon", "comic"])];
      const category = kind === "sfx" ? (meta as (typeof SFX)[string]).category : "bed";
      const d = dur(out);
      cat.clips.push({ id, file: `clips/${id}.mp3`, category, desc: `${id} — ${meta.desc} (cartoon styles)`, tags, licence: LICENCE, duration_s: d, source: "scripts/toon-sound-pack.ts (cartoon-shorts audio.py synth)", recipe: id, ...(kind === "music" ? { loop: true } : {}) });
      (pal[key] as Record<string, unknown>[]).push({ id, category, duration_s: d, tags, prompt: `Synthesised by scripts/toon-sound-pack.ts from cartoon-shorts audio.py: ${meta.desc}.` });
      console.log(`${kind} ${id} ${d}s`);
    }
    writeFileSync(path.join(dir, "catalog.json"), JSON.stringify(cat, null, 2) + "\n");
    writeFileSync(path.join(dir, "palette.json"), JSON.stringify(pal, null, 2) + "\n");
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
