import { describe, expect, it } from "vitest";
import { allowedLicence, commonsSearchUrl, creditLine, parseCommons, stripHtml } from "@/server/providers/stock/wikimedia";

describe("allowedLicence", () => {
  it.each([
    ["CC0", undefined], ["Public domain", undefined], ["PD-old", undefined], ["PDM", undefined], ["CC BY 4.0", undefined], ["CC BY 2.0", undefined],
    ["CC BY 3.0 DE", undefined], ["cc-by-4.0", undefined], ["CC0", "http://creativecommons.org/publicdomain/zero/1.0/deed.en"],
  ])("accepts %s", (name, url) => {
    expect(allowedLicence(name, url)).not.toBeNull();
  });
  it.each([
    ["CC BY-SA 4.0"], ["CC BY-SA 3.0"], ["CC BY-NC 2.0"], ["CC BY-ND 4.0"], ["GFDL"], ["GFDL 1.2"], ["GFDL, CC BY 3.0"], [""], ["   "], ["All rights reserved"], ["Unknown"], ["Attribution"],
  ])("refuses %j", (name) => {
    expect(allowedLicence(name)).toBeNull();
  });
  it("refuses when the licence url says share-alike or non-commercial even if the name looks fine", () => {
    expect(allowedLicence("CC BY 4.0", "https://creativecommons.org/licenses/by-sa/4.0/")).toBeNull();
    expect(allowedLicence("CC BY 4.0", "https://creativecommons.org/licenses/by-nc/4.0/")).toBeNull();
  });
});

describe("stripHtml / creditLine", () => {
  it("strips tags and entities and caps the length", () => {
    expect(stripHtml('<a href="//x" class="new">Jane &amp; Co</a><script>alert(1)</script>', 100)).toBe("Jane & Co");
    expect(stripHtml("x".repeat(500), 50).length).toBe(50);
  });
  it("builds author + licence + url, capped", () => {
    const c = creditLine({ title: "File:Engine cutaway.jpg", author: "Jane", licence: "CC BY 4.0", pageUrl: "https://commons.wikimedia.org/wiki/File:Engine_cutaway.jpg" });
    expect(c).toContain("Jane");
    expect(c).toContain("CC BY 4.0");
    expect(c).toContain("https://commons.wikimedia.org/wiki/File:Engine_cutaway.jpg");
    expect(creditLine({ title: "t".repeat(900), author: "a".repeat(900), licence: "CC0", pageUrl: "https://commons.wikimedia.org/wiki/X" }).length).toBeLessThanOrEqual(400);
    expect(creditLine({ title: "t", author: "", licence: "Public domain", pageUrl: "https://commons.wikimedia.org/wiki/X" })).toContain("Unknown author");
  });
});

describe("commonsSearchUrl", () => {
  it("encodes the query with URLSearchParams only and stays on the api host", () => {
    const u = new URL(commonsSearchUrl("a&b=c #x", 5));
    expect(u.origin).toBe("https://commons.wikimedia.org");
    expect(u.searchParams.get("gsrsearch")).toBe("a&b=c #x");
    expect(u.searchParams.get("gsrnamespace")).toBe("6");
    expect(u.searchParams.get("gsrlimit")).toBe("5");
    expect(u.searchParams.get("b")).toBeNull();
  });
});

const page = (over: Record<string, unknown> = {}, em: Record<string, string> = {}) => ({
  title: "File:Engine cutaway.jpg", index: 1,
  imageinfo: [{
    url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Engine_cutaway.jpg", thumburl: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Engine_cutaway.jpg/1280px-Engine_cutaway.jpg",
    width: 2922, height: 2656, mime: "image/jpeg", descriptionurl: "https://commons.wikimedia.org/wiki/File:Engine_cutaway.jpg",
    extmetadata: { Artist: { value: '<a href="//x">Jane</a>' }, LicenseShortName: { value: "CC0" }, ImageDescription: { value: "A <b>petrol</b> engine" }, Categories: { value: "Cutaways|Engines" }, ...Object.fromEntries(Object.entries(em).map(([k, v]) => [k, { value: v }])) },
    ...over,
  }],
});

describe("parseCommons", () => {
  const json = (pages: unknown[]) => ({ query: { pages: Object.fromEntries(pages.map((p, i) => [String(i), p])) } });
  it("turns a page into a candidate and downloads the 1280 thumbnail of a big original", () => {
    const [c] = parseCommons(json([page()]));
    expect(c).toMatchObject({ source: "wikimedia", title: "Engine cutaway", width: 2922, height: 2656, mime: "image/jpeg", licence: "CC0", pageUrl: "https://commons.wikimedia.org/wiki/File:Engine_cutaway.jpg" });
    expect(c!.url).toContain("1280px");
    expect(c!.text).toContain("petrol");
    expect(c!.text).toContain("Cutaways");
    expect(c!.credit).toContain("Jane");
    expect(c!.credit).not.toContain("<");
  });
  it("drops refused licences, missing info and junk shapes without throwing", () => {
    expect(parseCommons(json([page({}, { LicenseShortName: "CC BY-SA 4.0" })]))).toEqual([]);
    expect(parseCommons(json([page({}, { LicenseShortName: "" })]))).toEqual([]);
    expect(parseCommons(json([{ title: "File:x.jpg" }]))).toEqual([]);
    expect(parseCommons(null)).toEqual([]);
    expect(parseCommons({ query: { pages: "x" } })).toEqual([]);
  });
  it("uses the original when it is not bigger than the thumbnail", () => {
    const [c] = parseCommons(json([page({ width: 1200, height: 900 })]));
    expect(c!.url).toBe("https://upload.wikimedia.org/wikipedia/commons/a/ab/Engine_cutaway.jpg");
  });
});

import { parsePixabay, pixabaySearchUrl } from "@/server/providers/stock/pixabay-pictures";

describe("pixabay candidates", () => {
  it("builds the url with URLSearchParams and parses hits (licence stamped, tags as text)", () => {
    const u = new URL(pixabaySearchUrl("a&b", "k", 10));
    expect(u.origin).toBe("https://pixabay.com");
    expect(u.searchParams.get("q")).toBe("a&b");
    const [c] = parsePixabay({ hits: [{ id: 1, largeImageURL: "https://pixabay.com/get/x_1280.jpg", pageURL: "https://pixabay.com/photos/x-1/", imageWidth: 4000, imageHeight: 3000, tags: "engine, motor", user: "bob" }, { id: 2 }] });
    expect(c).toMatchObject({ source: "pixabay", licence: "Pixabay Content License", width: 4000, mime: "image/jpeg" });
    expect(c!.credit).toContain("bob");
    expect(parsePixabay(null)).toEqual([]);
  });
});
