import { describe, expect, it } from "vitest";
import { AUDIT_EVENTS } from "@/server/core/audit-events";
import { AUDIT_FILTERS, MAX_CURSOR, auditHref, describeDetail, parseAuditQuery, relativeTime, truncateText, utcStamp } from "@/server/core/audit-view";

describe("parseAuditQuery", () => {
  it("accepts_digit_cursors_and_known_filters", () => {
    expect(parseAuditQuery({ before: "123", event: "login" })).toEqual({ before: "123", filter: "login", ignored: false });
    expect(parseAuditQuery({})).toEqual({ before: null, filter: null, ignored: false });
  });
  it("rejects_hostile_cursors_and_reports_them_ignored", () => {
    for (const bad of ["", "0", "-1", "1e3", "1.5", " 12", "12 ", "0x10", "١٢٣", "1; drop table audit_log", "9".repeat(19), "9".repeat(18), String(MAX_CURSOR + 1), "00000000000000000001x"]) {
      expect(parseAuditQuery({ before: bad }), JSON.stringify(bad)).toMatchObject({ before: null });
    }
    expect(parseAuditQuery({ before: "x" }).ignored).toBe(true);
  });
  it("takes_the_first_value_of_a_repeated_param_and_nothing_else", () => {
    expect(parseAuditQuery({ before: ["5", "6"] })).toMatchObject({ before: "5" });
    expect(parseAuditQuery({ before: [] })).toMatchObject({ before: null });
  });
  it("only_catalogue_groups_are_filters", () => {
    for (const bad of ["", "nope", "login.", "login.success", "%", "_", "LOGIN", "__proto__", "constructor", "login%"]) {
      expect(parseAuditQuery({ event: bad }), bad).toMatchObject({ filter: null });
    }
  });
});

describe("AUDIT_FILTERS", () => {
  it("covers_every_catalogue_event_exactly_by_prefix", () => {
    const ids = AUDIT_FILTERS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of Object.keys(AUDIT_EVENTS)) expect(ids, e).toContain(e.split(".")[0]);
    for (const f of AUDIT_FILTERS) expect(f.label.length).toBeGreaterThan(0);
  });
});

describe("auditHref", () => {
  it("builds_a_clean_query", () => {
    expect(auditHref({})).toBe("/settings/audit");
    expect(auditHref({ filter: "key", before: "40" })).toBe("/settings/audit?event=key&before=40");
  });
});

describe("relativeTime and utcStamp", () => {
  const now = new Date("2026-10-27T12:00:00Z");
  it("reads_naturally", () => {
    expect(relativeTime(new Date("2026-10-27T11:59:50Z"), now)).toBe("just now");
    expect(relativeTime(new Date("2026-10-27T11:55:00Z"), now)).toBe("5 min ago");
    expect(relativeTime(new Date("2026-10-27T09:00:00Z"), now)).toBe("3 h ago");
    expect(relativeTime(new Date("2026-10-25T12:00:00Z"), now)).toBe("2 days ago");
    expect(relativeTime(new Date("2026-08-01T12:00:00Z"), now)).toBe("1 Aug 2026");
    expect(relativeTime(new Date("2026-10-27T12:05:00Z"), now)).toBe("just now"); // clock skew never prints a negative
  });
  it("utc_stamp_is_fixed_format", () => {
    expect(utcStamp(new Date("2026-03-04T05:06:07Z"))).toBe("2026-03-04 05:06:07 UTC");
  });
});

describe("truncateText", () => {
  it("never_splits_a_grapheme", () => {
    const s = "नमस्ते".repeat(40);
    const t = truncateText(s, 20);
    expect(t.endsWith("…")).toBe(true);
    expect(Array.from(new Intl.Segmenter().segment(t.slice(0, -1))).length).toBe(20);
    expect(truncateText("short", 20)).toBe("short");
  });
});

describe("describeDetail", () => {
  it("renders_plain_values", () => {
    expect(describeDetail({ setting: "jobs.concurrent_jobs", from: 2, to: 3, ok: true, none: null })).toEqual({
      pairs: [
        { key: "setting", value: "jobs.concurrent_jobs" },
        { key: "from", value: "2" },
        { key: "to", value: "3" },
        { key: "ok", value: "true" },
        { key: "none", value: "–" },
      ],
      hidden: 0,
    });
  });
  it("is_defensive_about_shape_and_length", () => {
    expect(describeDetail(null)).toEqual({ pairs: [], hidden: 0 });
    expect(describeDetail("<script>" as never)).toEqual({ pairs: [], hidden: 0 });
    expect(describeDetail([1, 2] as never)).toEqual({ pairs: [], hidden: 0 });
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
    const d = describeDetail(many);
    expect(d.pairs).toHaveLength(8);
    expect(d.hidden).toBe(12);
    const long = describeDetail({ note: "x".repeat(5000), ["k".repeat(500)]: "v" });
    for (const p of long.pairs) {
      expect(p.key.length).toBeLessThanOrEqual(41);
      expect(p.value.length).toBeLessThanOrEqual(121);
    }
  });
  it("flattens_nested_values_to_short_text_never_a_json_dump", () => {
    const d = describeDetail({ nested: { a: { b: { c: "deep".repeat(100) } } }, list: ["a", "<img src=x onerror=alert(1)>", 3] });
    for (const p of d.pairs) expect(p.value.length).toBeLessThanOrEqual(121);
    expect(d.pairs.find((p) => p.key === "list")!.value).toContain("<img src=x onerror=alert(1)>"); // kept as inert text; escaping is React's job
    expect(d.pairs.find((p) => p.key === "nested")!.value).not.toMatch(/^\s*\{/);
  });
  it("survives_circular_and_exotic_values", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => describeDetail({ a, big: BigInt(5), fn: () => 1 })).not.toThrow();
  });
});
