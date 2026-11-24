import { describe, expect, it } from "vitest";
import { parseCast } from "@/server/core/cartoon-cast";

const c = (name: string, options: Record<string, unknown> = { skin: "#b07a52" }) => ({ name, role: "a role", style: "cartoon_comic", options });

describe("parseCast", () => {
  it("accepts a small cast", () => {
    expect(parseCast([c("Raju"), c("Meena")])).toMatchObject({ ok: true });
  });
  it("rejects duplicate names, even in another case", () => {
    expect(parseCast([c("Raju"), c("raju")])).toMatchObject({ ok: false, message: expect.stringContaining("Two characters") });
  });
  it("rejects an unknown option key, a long name, nine characters and an empty cast", () => {
    expect(parseCast([c("Raju", { skinTone: "#fff" })])).toMatchObject({ ok: false, message: expect.stringContaining("skinTone") });
    expect(parseCast([c("x".repeat(31))])).toMatchObject({ ok: false });
    expect(parseCast(Array.from({ length: 9 }, (_, i) => c(`C${i}`)))).toMatchObject({ ok: false });
    expect(parseCast([])).toMatchObject({ ok: false });
  });
  it("rejects extra fields, a bad style and option values that are not text, numbers, booleans or null", () => {
    expect(parseCast([{ ...c("Raju"), extra: 1 }])).toMatchObject({ ok: false });
    expect(parseCast([{ ...c("Raju"), style: "cartoon_nope" }])).toMatchObject({ ok: false });
    expect(parseCast([c("Raju", { skin: { a: 1 } })])).toMatchObject({ ok: false });
    expect(parseCast([c("Raju", { skin: "x".repeat(41) })])).toMatchObject({ ok: false });
  });
});
