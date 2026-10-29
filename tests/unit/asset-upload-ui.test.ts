import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UploadRow } from "@/app/(app)/assets/upload-row";
import { decodeName, heicRefusal } from "@/app/(app)/assets/upload-status";
import { isAuditEvent } from "@/server/core/audit-events";

describe("upload file names", () => {
  it("decodes the route's escaping exactly once", () => {
    expect(decodeName("&lt;b&gt;cat.png")).toBe("<b>cat.png");
    expect(decodeName("a&amp;lt;b")).toBe("a&lt;b"); // one pass: never decodes twice
    expect(decodeName("it&#39;s &quot;x&quot;")).toBe(`it's "x"`);
  });
  it("renders a name like <b>cat.png literally, once escaped", () => {
    const html = renderToStaticMarkup(createElement(UploadRow, { name: decodeName("&lt;b&gt;cat.png"), state: "done", percent: 100, onCancel: () => {} }));
    expect(html).toContain("&lt;b&gt;cat.png");
    expect(html).not.toContain("&amp;lt;");
    expect(html).not.toContain("<b>");
  });
  it("refuses HEIC before sending, with the convert message", () => {
    expect(heicRefusal({ name: "IMG_1.HEIC", type: "" })).toMatch(/Convert the photo to JPEG or PNG/);
    expect(heicRefusal({ name: "x.bin", type: "image/heif" })).not.toBeNull();
    expect(heicRefusal({ name: "x.jpg", type: "image/jpeg" })).toBeNull();
  });
});

describe("asset audit events", () => {
  it("are on the closed list", () => {
    for (const e of ["asset.kept", "asset.deleted", "asset.restored", "asset.tagged"]) expect(isAuditEvent(e), e).toBe(true);
  });
});
