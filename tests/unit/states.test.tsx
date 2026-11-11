// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Film } from "lucide-react";
import Link from "next/link";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatIst, formatMoney } from "@/server/core/display-format";
import { EmptyState } from "@/ui/states/empty-state";
import { ErrorState } from "@/ui/states/error-state";
import { PageSkeleton } from "@/ui/states/page-skeleton";
import { TimeAgo } from "@/ui/states/time-ago";
import { WithReason } from "@/ui/states/with-reason";
import { TooltipProvider } from "@/ui/primitives/tooltip";

afterEach(cleanup);

describe("EmptyState", () => {
  it("nothing yet: title, body and the one action", () => {
    render(<EmptyState icon={Film} title="No videos yet" body="Make your first short." action={<Link href="/videos/new">New short</Link>} />);
    expect(screen.getByRole("heading", { name: "No videos yet" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "New short" })).toBeTruthy();
  });
  it("filtered: says no results and offers Clear filters", () => {
    render(<EmptyState icon={Film} title="No videos yet" filtered={{ clearHref: "/videos" }} />);
    expect(screen.getByRole("heading", { name: "No results for these filters" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Clear filters" }).getAttribute("href")).toBe("/videos");
    expect(screen.queryByText("No videos yet")).toBeNull();
  });
});

describe("ErrorState", () => {
  it("Try again calls retry", async () => {
    const retry = vi.fn();
    render(<ErrorState retry={retry} />);
    expect(screen.getByRole("heading", { name: "This part could not load" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});

describe("PageSkeleton", () => {
  it.each(["list", "grid", "detail", "form", "inbox"] as const)("%s is hidden from screen readers but says Loading", (v) => {
    const { container } = render(<PageSkeleton variant={v} />);
    expect(screen.getByText("Loading")).toBeTruthy();
    expect(container.querySelector("[aria-hidden='true']")).not.toBeNull();
  });
});

describe("TimeAgo", () => {
  it("shows the relative age with the exact IST time on hover", () => {
    const at = new Date(Date.now() - 2 * 3600_000);
    render(<TimeAgo at={at} />);
    const t = screen.getByText("2 h ago");
    expect(t.getAttribute("title")).toBe(formatIst(at));
    expect(t.closest("time")?.getAttribute("dateTime")).toBe(at.toISOString());
  });
});

describe("WithReason", () => {
  it("a reason becomes the button's accessible description", () => {
    render(
      <TooltipProvider>
        <WithReason reason="Add a Kling key first">
          <button disabled>Generate</button>
        </WithReason>
      </TooltipProvider>,
    );
    const b = screen.getByRole("button", { name: "Generate" });
    const id = b.getAttribute("aria-describedby");
    expect(id && document.getElementById(id)?.textContent).toBe("Add a Kling key first");
  });
  it("no reason: renders the child untouched", () => {
    render(<WithReason reason={null}><button>Generate</button></WithReason>);
    expect(screen.getByRole("button", { name: "Generate" }).getAttribute("aria-describedby")).toBeNull();
  });
});

describe("money", () => {
  it("rupees use Indian digit grouping", () => {
    expect(formatMoney(1_938_000_000, 95.05)).toBe("$1938.00 (₹1,84,206.9)");
  });
});
