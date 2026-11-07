import { expect, test } from "@playwright/test";

// The page and its two actions need the owner's session; the action POSTs also pass through Next's origin check.
test("anonymous GET /settings/notifications is sent to login", async ({ request }) => {
  const res = await request.get("/settings/notifications", { maxRedirects: 0 });
  expect(res.status()).toBe(307);
  expect(new URL(res.headers().location!, "http://x").pathname).toBe("/login");
  expect(await res.text()).not.toContain("Quiet hours");
});

test("anonymous POST to the page (server action shape) changes nothing and never reaches the form", async ({ request }) => {
  const res = await request.post("/settings/notifications", { maxRedirects: 0, headers: { "next-action": "00".repeat(20) }, multipart: { webhook_url: "https://evil.example.com/x" } });
  expect(res.status()).not.toBe(200);
});
