// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "@/ui/primitives/button";
import { Card } from "@/ui/primitives/card";
import { Pill } from "@/ui/primitives/pill";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { Switch } from "@/ui/primitives/switch";
import { Checkbox } from "@/ui/primitives/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/ui/primitives/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/primitives/tabs";
import { Progress } from "@/ui/primitives/progress";

afterEach(cleanup);

const dir = "src/ui/primitives";
const sources = readdirSync(dir).map((f) => ({ f, src: readFileSync(`${dir}/${f}`, "utf8") }));

describe("primitive source rules (Doc 3 §7)", () => {
  it("has all eighteen primitives", () => {
    expect(sources.map((s) => s.f).sort()).toEqual(
      ["alert-dialog", "button", "card", "checkbox", "dialog", "dropdown-menu", "input", "label", "pill", "progress", "select", "sheet", "skeleton", "sonner", "switch", "table", "tabs", "tooltip"].map((n) => `${n}.tsx`),
    );
  });
  for (const bad of [/shadow/, /rounded-xl/, /ring-indigo/, /bg-gradient/, /\b(indigo|slate|zinc|purple|violet)-\d/]) {
    it(`no primitive uses ${bad}`, () => {
      for (const { f, src } of sources) expect(src.match(bad), f).toBeNull();
    });
  }
  it("Card has no border", () => {
    const { container } = render(<Card>x</Card>);
    expect(container.firstElementChild?.className).not.toMatch(/\bborder/);
  });
  it("every transition is guarded for reduced motion", () => {
    const cn = readFileSync("src/ui/lib/cn.ts", "utf8");
    expect(cn).toMatch(/transition-colors[^"]*motion-reduce:transition-none/);
    for (const { f, src } of sources) {
      for (const m of src.matchAll(/"[^"]*\btransition(-\w+)?\b[^"]*"/g)) expect(m[0], f).toMatch(/motion-reduce:transition-none/);
      for (const m of src.matchAll(/"[^"]*\banimate-\w+[^"]*"/g)) expect(m[0], f).toMatch(/motion-safe:animate-|motion-reduce:animate-none/);
    }
  });
  it("focus ring is 2 px --text, offset 2 px", () => {
    const { container } = render(<Button>Go</Button>);
    const c = container.firstElementChild?.className ?? "";
    expect(c).toContain("focus-visible:outline-2");
    expect(c).toContain("focus-visible:outline-offset-2");
    expect(c).toContain("focus-visible:outline-text");
  });
  it("controls are 44 px on phone, 36 px from sm", () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole("button", { name: "Go" }).className).toMatch(/min-h-11 sm:min-h-9/);
  });
});

describe("roles and names", () => {
  it("Button is type=button by default and has role+name", () => {
    render(<Button variant="destructive">Delete</Button>);
    expect(screen.getByRole("button", { name: "Delete" }).getAttribute("type")).toBe("button");
  });
  it("Label names an Input", () => {
    render(
      <>
        <Label htmlFor="n">Name</Label>
        <Input id="n" />
      </>,
    );
    expect(screen.getByLabelText("Name")).toBeTruthy();
  });
  it("Pill shows its word", () => {
    render(<Pill tone="warning">held</Pill>);
    expect(screen.getByText("held")).toBeTruthy();
  });
  it("Progress exposes a progressbar", () => {
    render(<Progress value={40} aria-label="Render" />);
    expect(screen.getByRole("progressbar", { name: "Render" })).toBeTruthy();
  });
});

describe("keyboard", () => {
  it("Switch toggles on Space", async () => {
    const user = userEvent.setup();
    render(<Switch aria-label="Notify" />);
    const sw = screen.getByRole("switch", { name: "Notify" });
    sw.focus();
    await user.keyboard(" ");
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });
  it("Checkbox toggles on Space", async () => {
    const user = userEvent.setup();
    render(<Checkbox aria-label="Agree" />);
    const cb = screen.getByRole("checkbox", { name: "Agree" });
    cb.focus();
    await user.keyboard(" ");
    expect(cb.getAttribute("aria-checked")).toBe("true");
  });
  it("Dialog traps focus and closes on Escape", async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Body</DialogDescription>
          <Button>Inside</Button>
        </DialogContent>
      </Dialog>,
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    const dlg = screen.getByRole("dialog", { name: "Title" });
    for (let i = 0; i < 5; i++) {
      await user.tab();
      expect(dlg.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("Tabs move with arrow keys", async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="a">
        <TabsList aria-label="Sections">
          <TabsTrigger value="a">One</TabsTrigger>
          <TabsTrigger value="b">Two</TabsTrigger>
        </TabsList>
        <TabsContent value="a">A</TabsContent>
        <TabsContent value="b">B</TabsContent>
      </Tabs>,
    );
    screen.getByRole("tab", { name: "One" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Two" }));
    expect(screen.getByRole("tab", { name: "Two" }).getAttribute("aria-selected")).toBe("true");
  });
});
