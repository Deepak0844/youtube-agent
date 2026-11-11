// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "@/ui/primitives/button";
import { Card, CardHeader } from "@/ui/primitives/card";
import { Pill } from "@/ui/primitives/pill";

afterEach(cleanup);

describe("Button", () => {
  it("loading: busy, disabled, keeps its label and shows a spinner", () => {
    render(<Button loading>Approve script</Button>);
    const b = screen.getByRole("button", { name: /Approve script/ });
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(b.querySelector("[data-spinner]")).not.toBeNull();
  });
  it("not loading: no spinner, not busy", () => {
    render(<Button>Save</Button>);
    const b = screen.getByRole("button", { name: "Save" });
    expect(b.getAttribute("aria-busy")).toBeNull();
    expect(b.querySelector("[data-spinner]")).toBeNull();
  });
  it("secondary is bordered, primary is solid text colour", () => {
    render(<><Button>One</Button><Button variant="secondary">Two</Button></>);
    expect(screen.getByRole("button", { name: "One" }).className).toContain("bg-text");
    expect(screen.getByRole("button", { name: "Two" }).className).toContain("border-border");
  });
});

describe("Pill", () => {
  it("info tone uses the info colours and a leading dot", () => {
    render(<Pill tone="info">Cost approval</Pill>);
    const p = screen.getByText("Cost approval");
    expect(p.className).toContain("bg-pill-info-bg");
    expect(p.className).toContain("before:rounded-full");
  });
});

describe("Card", () => {
  it("is bordered and its header shows title, description and actions", () => {
    render(
      <Card data-testid="c">
        <CardHeader title="Decision queue" description="3 waiting" actions={<a href="/queue">View all</a>} />
      </Card>,
    );
    expect(screen.getByTestId("c").className).toContain("border-border");
    expect(screen.getByRole("heading", { name: "Decision queue" })).toBeTruthy();
    expect(screen.getByText("3 waiting")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View all" })).toBeTruthy();
  });
});
