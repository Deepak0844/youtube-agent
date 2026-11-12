// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { AccountMenu } from "@/ui/shell/account-menu";

afterEach(() => {
  cleanup();
  document.cookie = "ytstudio-theme=; path=/; max-age=0";
  document.documentElement.removeAttribute("data-theme");
});

describe("account menu theme icons", () => {
  it("offers System, Light and Dark as icon choices; picking Dark applies it and keeps the menu open", async () => {
    const u = userEvent.setup();
    render(<AccountMenu signOut={async () => {}} />);
    await u.click(screen.getByRole("button", { name: "Account" }));
    const radios = await screen.findAllByRole("menuitemradio");
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual(["System (follow the Mac)", "Light", "Dark"]);
    expect(radios[0]!.getAttribute("aria-checked")).toBe("true");
    await u.click(screen.getByRole("menuitemradio", { name: "Dark" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.cookie).toContain("ytstudio-theme=dark");
    expect(screen.getByRole("menuitemradio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menu")).toBeTruthy();
  });
});
