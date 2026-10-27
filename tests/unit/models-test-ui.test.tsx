// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/settings/models/actions", () => ({
  saveModelAction: vi.fn(),
  deleteModelAction: vi.fn(),
  copyDefaultAction: vi.fn(),
  setRouteAction: vi.fn(),
  testModelAction: vi.fn(),
}));
import { LastTestLine } from "@/app/(app)/settings/models/last-test";
import { TestModelButton } from "@/app/(app)/settings/models/model-form";

afterEach(cleanup);

describe("models page: Test", () => {
  it("models_page_shows_last_test_result", () => {
    render(<LastTestLine test={{ ok: true, latencyMs: 812, structuredOutput: true, costMicroUsd: 210, message: "Answered in 812 ms. Structured JSON worked. Cost 0.00021 USD.", at: new Date("2026-10-27T10:05:00Z") }} />);
    expect(screen.getByText("Last test passed")).toBeTruthy();
    expect(document.body.textContent).toContain("27 Oct 2026");
    expect(document.body.textContent).toContain("Structured JSON worked");
  });

  it("a_failed_test_is_shown_as_failed_with_its_plain_reason", () => {
    render(<LastTestLine test={{ ok: false, latencyMs: 0, structuredOutput: false, costMicroUsd: 0, message: "The provider rejected the key (401). Check the key on the Keys page. Nothing was charged.", at: new Date("2026-10-27T10:05:00Z") }} />);
    expect(screen.getByText("Last test failed")).toBeTruthy();
    expect(document.body.textContent).toContain("rejected the key (401)");
  });

  it("never_tested_says_so", () => {
    render(<LastTestLine test={undefined} />);
    expect(document.body.textContent).toContain("Not tested yet.");
  });

  it("the_button_says_hosted_tests_cost_money_and_local_ones_do_not", () => {
    render(<TestModelButton id="m1" label="Paid one" free={false} />);
    expect(screen.getByRole("button", { name: "Test Paid one" })).toBeTruthy();
    expect(document.body.textContent).toContain("Costs a fraction of a cent");
    cleanup();
    render(<TestModelButton id="m2" label="Local" free />);
    expect(document.body.textContent).toContain("Free");
  });
});
