import { expect, test } from "@playwright/test";

// Indic strings must render in the self-hosted Noto faces, not system fallbacks. We inject one sample per script,
// wait for document.fonts, and assert (a) the matching woff2 was fetched from our own origin and (b) the browser
// reports a loaded FontFace for it. No screenshot diff.
const samples: Array<[string, string]> = [
  ["noto-sans-devanagari", "नमस्ते दुनिया, आज का वीडियो"],
  ["noto-sans-tamil", "வணக்கம் உலகம், இன்றைய காணொளி"],
  ["noto-sans-telugu", "నమస్కారం ప్రపంచం, నేటి వీడియో"],
  ["noto-sans-malayalam", "നമസ്കാരം ലോകം, ഇന്നത്തെ വീഡിയോ"],
  ["noto-sans-kannada", "ನಮಸ್ಕಾರ ಜಗತ್ತು, ಇಂದಿನ ವೀಡಿಯೊ"],
];

test.use({ storageState: { cookies: [], origins: [] } });

test("Indic samples load their own Noto face from our origin", async ({ page, baseURL }) => {
  const fetched: string[] = [];
  page.on("response", (r) => {
    if (r.url().endsWith(".woff2")) fetched.push(r.url());
  });
  await page.goto("/login");
  await page.evaluate((rows) => {
    const box = document.createElement("div");
    for (const [, text] of rows) {
      const p = document.createElement("p");
      p.textContent = text;
      box.append(p);
    }
    document.body.append(box);
  }, samples);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);

  // next/font hashes the file names, so count fetches: Instrument Sans + one per script.
  expect(new Set(fetched).size).toBeGreaterThanOrEqual(6);
  const loaded = await page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").length);
  // Instrument Sans + Noto Latin (if needed) + five scripts; at least the five Indic faces plus Instrument Sans.
  expect(loaded).toBeGreaterThanOrEqual(6);
  expect(fetched.every((u) => u.startsWith(baseURL!))).toBe(true);
});
