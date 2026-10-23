import type { Page } from "@playwright/test";

export async function installFakeClock(page: Page, isoTime: string): Promise<void> {
  await page.clock.install({ time: new Date(isoTime) });
}
