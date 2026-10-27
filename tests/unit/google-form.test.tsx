// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/settings/google/actions", () => ({ saveGoogleAppAction: vi.fn(), testGoogleAppAction: vi.fn() }));
import { FormatTest, GoogleForm, VaultBanner } from "@/app/(app)/settings/google/google-form";

afterEach(cleanup);
const SRC = "src/app/(app)/settings/google";

describe("google form", () => {
  it.each(["missing_key", "wrong_key", "unreadable"] as const)("vault %s: banner shown, saving disabled (fail closed)", (vault) => {
    render(
      <>
        <VaultBanner vault={vault} />
        <GoogleForm vault={vault} maskedId={null} secretHint="" secretStored={false} />
      </>,
    );
    expect(screen.getByRole("alert").textContent).toContain("Saving is off");
    expect((screen.getByLabelText("Client ID") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Client secret") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save to vault" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("vault ok: no banner, enabled, secret field is a password input", () => {
    render(
      <>
        <VaultBanner vault="ok" />
        <GoogleForm vault="ok" maskedId="1234….apps.googleusercontent.com" secretHint="0001" secretStored />
      </>,
    );
    expect(screen.queryByText("Saving is off")).toBeNull();
    const s = screen.getByLabelText("Client secret") as HTMLInputElement;
    expect(s.type).toBe("password");
    expect(s.value).toBe("");
    expect(s.disabled).toBe(false);
    expect(screen.getByText("••••0001")).toBeTruthy();
  });

  it("short-secret case shows no tail", () => {
    render(<GoogleForm vault="ok" maskedId={null} secretHint="" secretStored />);
    expect(screen.getByText("set (hidden)")).toBeTruthy();
  });

  it("format check says it sends nothing to Google", () => {
    render(<FormatTest disabled={false} />);
    expect(screen.getByText(/Nothing is sent to Google/)).toBeTruthy();
  });
});

describe("source guards", () => {
  const read = (f: string) => readFileSync(`${SRC}/${f}`, "utf8");
  it("the page and client form never read or decrypt the secret", () => {
    for (const f of ["page.tsx", "google-form.tsx"]) expect(read(f), f).not.toMatch(/getSecret|decryptSecret/);
  });
  it("no network call and no logging in the settings code", () => {
    for (const f of ["page.tsx", "actions.ts", "google-form.tsx"]) expect(read(f), f).not.toMatch(/\bfetch\(|safeFetch|console\./);
    expect(readFileSync("src/server/db/google-app.ts", "utf8")).not.toMatch(/\bfetch\(|safeFetch|console\./);
  });
  it("exactly two actions, each authenticating first", () => {
    const a = read("actions.ts");
    expect(a.match(/export async function/g)).toHaveLength(2);
    expect(a.match(/\{\s*await requireOwner\(\);/g)).toHaveLength(2);
  });
});
