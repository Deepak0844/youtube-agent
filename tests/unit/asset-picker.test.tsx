// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const cards = [
  { id: "a1", kind: "image", name: "one.png", tags: [], keep: false, url: null, purgeAt: null },
  { id: "a2", kind: "audio", name: "two.wav", tags: [], keep: false, url: null, purgeAt: null },
];
vi.mock("@/app/(app)/assets/actions", () => ({ searchAssetsAction: vi.fn(async () => cards) }));
vi.mock("@/app/(app)/assets/upload-zone", () => ({ UploadZone: () => null }));
import { AssetPicker } from "@/ui/domain/asset-picker";

afterEach(cleanup);

describe("AssetPicker", () => {
  it("single mode returns the chosen asset id", async () => {
    const onPick = vi.fn();
    render(<AssetPicker onPick={onPick} />);
    await userEvent.click(await screen.findByRole("button", { name: /one\.png/ }));
    expect(onPick).toHaveBeenCalledWith(["a1"]);
  });
  it("multiple mode returns every chosen id on confirm", async () => {
    const onPick = vi.fn();
    render(<AssetPicker multiple onPick={onPick} />);
    await userEvent.click(await screen.findByRole("button", { name: /one\.png/ }));
    await userEvent.click(screen.getByRole("button", { name: /two\.wav/ }));
    expect(onPick).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Use 2 chosen/ }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(["a1", "a2"]));
  });
});
