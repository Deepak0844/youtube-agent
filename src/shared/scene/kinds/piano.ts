import { z } from "zod";
import { base, LIMITS } from "./common";
import { noteMidi } from "../../../../remotion/kit/pianoLogic";

const NOTE_MSG = "must be a note like C4 or F#3 (letters A-G, optional # for sharp, octave 0-8; no flats)";
const note = z.string().refine((n) => noteMidi(n) !== null, { message: NOTE_MSG });

export const schema = z
  .object({
    ...base,
    kind: z.literal("piano"),
    from: note.default("C3"),
    to: note.default("C5"),
    events: z
      .array(
        z.object({
          atMs: z.number().int().min(0, "must be 0 or more").max(LIMITS.maxSceneMs, `must be at most ${LIMITS.maxSceneMs} ms`),
          notes: z
            .array(note)
            .min(1, "needs at least one note")
            .max(LIMITS.pianoNotesPerEvent, `must have at most ${LIMITS.pianoNotesPerEvent} notes`),
          label: z.string().trim().min(1, "must not be empty").max(LIMITS.pianoLabel, `must be at most ${LIMITS.pianoLabel} characters`).optional(),
        }),
      )
      .min(1)
      .max(LIMITS.pianoEvents, `must have at most ${LIMITS.pianoEvents} events`),
  })
  .superRefine((s, ctx) => {
    const lo = noteMidi(s.from);
    const hi = noteMidi(s.to);
    if (lo === null || hi === null) return; // reported by the note checks above
    if (hi <= lo) return void ctx.addIssue({ code: "custom", path: ["to"], message: `must be higher than from (${s.from})` });
    if (hi - lo > LIMITS.pianoMaxSpan) return void ctx.addIssue({ code: "custom", path: ["to"], message: `keyboard span must be at most ${LIMITS.pianoMaxSpan} semitones (3 octaves)` });
    s.events.forEach((e, i) => {
      if (i > 0 && e.atMs < s.events[i - 1]!.atMs)
        ctx.addIssue({ code: "custom", path: ["events", i, "atMs"], message: "events must be in time order" });
      e.notes.forEach((n, j) => {
        const m = noteMidi(n);
        if (m !== null && (m < lo || m > hi)) ctx.addIssue({ code: "custom", path: ["events", i, "notes", j], message: `${n} is outside the keyboard (${s.from} to ${s.to})` });
      });
    });
  });

export const describe = `kind "piano": optional from/to (keyboard range, notes like "C3" "C5", sharps as "F#3" never flats, max ${LIMITS.pianoMaxSpan} semitones, default C3-C5), events[] (1-${LIMITS.pianoEvents}, in time order) each {atMs (offset in the scene), notes[] (1-${LIMITS.pianoNotesPerEvent} notes inside the range), label (optional, max ${LIMITS.pianoLabel} chars, e.g. "C major")}. Each event stays lit until the next.`;
