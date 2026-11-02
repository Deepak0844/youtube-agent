import { describe, expect, it } from "vitest";
import { RIGHTS_TEXT, checkRights, rightsSchema, systemRightsText } from "@/server/core/asset-rules";

describe("system rights record", () => {
  const rec = (text: string, by?: "system") => ({ attestations: [{ at: new Date().toISOString(), text, ...(by ? { by } : {}) }] });
  it("accepts the system sentence and passes the rights check", () => {
    const r = rightsSchema.safeParse(rec(systemRightsText("CC BY 4.0", "Wikimedia Commons"), "system"));
    expect(r.success).toBe(true);
    expect(checkRights(r.data!, { kind: "image", tags: ["stock"] })).toEqual({ ok: true });
  });
  it("still accepts the owner statement and refuses any other text", () => {
    expect(rightsSchema.safeParse(rec(RIGHTS_TEXT)).success).toBe(true);
    expect(rightsSchema.safeParse(rec("trust me")).success).toBe(false);
    expect(rightsSchema.safeParse(rec("Free licence (x) checked automatically from Evil Site")).success).toBe(false);
    expect(rightsSchema.safeParse(rec(RIGHTS_TEXT, "owner" as never)).success).toBe(false);
  });
  it("strips odd characters from the licence name", () => {
    expect(rightsSchema.safeParse(rec(systemRightsText("CC<script> BY", "Pixabay"))).success).toBe(true);
  });
});
