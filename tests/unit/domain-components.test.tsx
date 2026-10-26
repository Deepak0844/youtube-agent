// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { stagesFor, type StageState } from "@/ui/domain/stages";
import { CutStrip } from "@/ui/domain/cut-strip";
import { EmptyFrame } from "@/ui/domain/empty-frame";
import { KpiStrip } from "@/ui/domain/kpi-strip";
import { SpendLine, formatUsd } from "@/ui/domain/spend-line";
import { DecisionRow } from "@/ui/domain/decision-row";
import { Gate } from "@/ui/domain/gate";
import { VideoBox } from "@/ui/domain/video-box";
import { FrameStrip } from "@/ui/domain/frame-strip";
import { LogTail } from "@/ui/domain/log-tail";
import { ChannelInitial, hueFor, hueGap } from "@/ui/domain/channel-initial";

afterEach(cleanup);

const INDIC = {
  hi: "बारिश में मिट्टी की खुशबू क्यों आती है और यह बहुत लंबा शीर्षक कभी नहीं कटना चाहिए",
  ta: "மின்மினிப் பூச்சிகள் ஒளிர்வது எப்படி என்பதை விளக்கும் மிக நீண்ட தலைப்பு",
  ml: "കടൽ തിരമാലകൾ എങ്ങനെ ഉണ്ടാകുന്നു എന്നതിനെക്കുറിച്ചുള്ള വളരെ നീണ്ട തലക്കെട്ട്",
};
const NOSPACE = "x".repeat(200);
const WRAP = /\[overflow-wrap:anywhere\]/;

const mk = (format: "short" | "long", states: Record<string, Partial<StageState>> = {}) =>
  stagesFor(format).map((s) => ({ ...s, state: "todo" as const, ...(states[s.key] ?? {}) }));

describe("stages (Doc 2 §4.1)", () => {
  it("short has eight segments, no Outline", () => {
    expect(stagesFor("short").map((s) => s.label)).toEqual(["Draft", "Build", "Voice", "Render", "Sound", "Check", "Review", "Publish"]);
  });
  it("long adds Outline first", () => {
    const l = stagesFor("long").map((s) => s.label);
    expect(l).toHaveLength(9);
    expect(l[0]).toBe("Outline");
  });
});

describe("CutStrip", () => {
  it("every state renders a word, not only a colour", () => {
    render(
      <CutStrip
        format="short"
        aspect="9:16"
        stages={mk("short", {
          draft: { state: "done" },
          build: { state: "done" },
          voice: { state: "running", progress: 40 },
          render: { state: "held", gate: "cost" },
          sound: { state: "failed" },
        })}
      />,
    );
    const list = screen.getByRole("list", { name: /stages/i });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(8);
    expect(items[0]!.textContent).toMatch(/draft.*done/i);
    expect(items[2]!.textContent).toMatch(/voice.*running.*40%/i);
    expect(items[3]!.textContent).toMatch(/render.*held.*cost/i);
    expect(items[4]!.textContent).toMatch(/sound.*failed/i);
    expect(items[5]!.textContent).toMatch(/check.*waiting/i);
    expect(items[2]!.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("40");
    expect(items[4]!.querySelector("svg")).not.toBeNull(); // cross shape
    expect(items[3]!.getAttribute("data-state")).toBe("held");
  });
  it("tells states apart by shape too", () => {
    render(<CutStrip format="short" aspect="9:16" stages={mk("short", { draft: { state: "done" }, build: { state: "held", gate: "script" } })} />);
    const items = screen.getAllByRole("listitem");
    const seg = (i: number) => items[i]!.querySelector("[data-seg]")!.className;
    expect(seg(0)).not.toEqual(seg(1));
    expect(seg(1)).toMatch(/outline/);
  });
  it("renders a summary line", () => {
    render(<CutStrip format="short" aspect="9:16" stages={mk("short", { draft: { state: "held", gate: "script" } })} />);
    expect(screen.getByText(/held at the script gate/i)).toBeTruthy();
  });
  it("long videos add one sub-segment per chapter", () => {
    const stages = mk("long", { render: { state: "running", progress: 50, chapters: ["done", "running", "todo", "todo", "todo"] } });
    const { container } = render(<CutStrip format="long" aspect="16:9" stages={stages} />);
    expect(container.querySelectorAll("[data-chapter]")).toHaveLength(5);
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(9);
  });
  it("short videos never draw chapters", () => {
    const { container } = render(<CutStrip format="short" aspect="9:16" stages={mk("short")} />);
    expect(container.querySelectorAll("[data-chapter]")).toHaveLength(0);
  });
  it("aspect classes differ 9:16 vs 16:9", () => {
    const a = render(<CutStrip format="short" aspect="9:16" stages={mk("short")} />);
    expect(a.container.querySelector("[data-thumb]")!.className).toMatch(/aspect-\[9\/16\]/);
    cleanup();
    const b = render(<CutStrip format="long" aspect="16:9" stages={mk("long")} />);
    expect(b.container.querySelector("[data-thumb]")!.className).toMatch(/aspect-video/);
  });
  it("can hide the thumbnail", () => {
    const { container } = render(<CutStrip format="short" aspect="9:16" stages={mk("short")} thumbnail={false} />);
    expect(container.querySelector("[data-thumb]")).toBeNull();
  });
  it("segments can shrink and wrap so labels never clip", () => {
    render(<CutStrip format="short" aspect="9:16" stages={mk("short", { render: { state: "held", gate: INDIC.hi } })} />);
    expect(screen.getAllByRole("listitem")[0]!.className).toMatch(/min-w-0/);
    const hits = screen.getAllByText(new RegExp(INDIC.hi.slice(0, 10)));
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.className).toMatch(WRAP);
  });
});

describe("EmptyFrame", () => {
  it("keeps its frame with a sentence and one action", () => {
    render(<EmptyFrame message="Nothing is waiting for you." action={<a href="/new">Start a Short</a>} />);
    expect(screen.getByText("Nothing is waiting for you.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Start a Short" })).toBeTruthy();
  });
  it("works without an action and in a video aspect", () => {
    const { container } = render(<EmptyFrame message="No frames yet." aspect="9:16" />);
    expect(container.firstElementChild!.className).toMatch(/aspect-\[9\/16\]/);
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("wraps long Indic text", () => {
    render(<EmptyFrame message={INDIC.ta} />);
    expect(screen.getByText(INDIC.ta).className).toMatch(WRAP);
  });
});

describe("KpiStrip", () => {
  it("prints a lead figure and the others as a definition list", () => {
    render(<KpiStrip lead={{ label: "Waiting on you", value: 4 }} figures={[{ label: "In production", value: 2 }, { label: "Published this month", value: 0 }]} />);
    expect(screen.getByText("Waiting on you")).toBeTruthy();
    expect(screen.getByText("0")).toBeTruthy();
    expect(screen.getAllByRole("term")).toHaveLength(3);
  });
  it("prints unknowns as a dash with a spoken reason", () => {
    render(<KpiStrip lead={{ label: "Waiting on you", value: null }} figures={[]} />);
    expect(screen.getByText("–")).toBeTruthy();
    expect(screen.getByText(/not known yet/i)).toBeTruthy();
  });
  it("has no icon and no chart", () => {
    const { container } = render(<KpiStrip lead={{ label: "A", value: 1, note: "vs last Monday" }} figures={[{ label: "B", value: 2 }]} />);
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByText("vs last Monday")).toBeTruthy();
  });
  it("wraps long labels", () => {
    render(<KpiStrip lead={{ label: INDIC.hi, value: 1 }} figures={[]} />);
    expect(screen.getByText(INDIC.hi).className).toMatch(WRAP);
  });
});

describe("SpendLine", () => {
  it("formats micro-USD", () => {
    expect(formatUsd(4_200_000)).toBe("$4.20");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(15_000_000)).toBe("$15.00");
  });
  it("states spend against the cap with a labelled bar", () => {
    render(<SpendLine spentMicroUsd={4_200_000} capMicroUsd={15_000_000} />);
    expect(screen.getByText("$4.20 of $15.00 today")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: /spend today/i }).getAttribute("aria-valuenow")).toBe("28");
  });
  it("says so in words when over the cap", () => {
    render(<SpendLine spentMicroUsd={16_000_000} capMicroUsd={15_000_000} />);
    expect(screen.getByText(/over today's cap/i)).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
  });
  it("handles a zero cap", () => {
    render(<SpendLine spentMicroUsd={0} capMicroUsd={0} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
  });
});

describe("DecisionRow", () => {
  const base = {
    format: "short" as const,
    aspect: "9:16" as const,
    stages: mk("short", { draft: { state: "held" as const, gate: "script" } }),
    gateLabel: "Waiting for your script review",
    costLabel: "$0.40",
    ageLabel: "2 h",
    href: "/videos/v1",
    channelName: "Tamarind Lane",
    channelIndex: 0,
  };
  it.each(Object.entries(INDIC))("long %s title wraps instead of overflowing", (lang, title) => {
    render(<DecisionRow {...base} title={title} lang={lang} />);
    const t = screen.getByText(title);
    expect(t.className).toMatch(WRAP);
    expect(t.className).toMatch(/min-w-0/);
    expect(t.getAttribute("lang")).toBe(lang);
  });
  it("breaks an unbroken string", () => {
    render(<DecisionRow {...base} title={NOSPACE} lang="en" />);
    expect(screen.getByText(NOSPACE).className).toMatch(WRAP);
  });
  it("review link names the video and is a 44px phone target", () => {
    render(<DecisionRow {...base} title="Why bridges hum" lang="en" />);
    const a = screen.getByRole("link", { name: /review.*why bridges hum/i });
    expect(a.getAttribute("href")).toBe("/videos/v1");
    expect(a.className).toMatch(/min-h-11/);
  });
  it("shows gate, cost, age, format chip and channel", () => {
    render(<DecisionRow {...base} title="T" lang="en" />);
    for (const t of ["Waiting for your script review", "$0.40", "2 h", "Short", "Tamarind Lane"]) expect(screen.getByText(t)).toBeTruthy();
  });
});

describe("Gate (static)", () => {
  it("states the consequence in a sentence and offers the white pill", () => {
    render(<Gate title="Script review" consequence={<>Uploads privately to <strong>Tamarind Lane</strong>. Spends $0.00 more.</>} />);
    expect(screen.getByRole("heading", { name: "Script review" })).toBeTruthy();
    expect(screen.getByText(/Spends \$0\.00 more/)).toBeTruthy();
    const approve = screen.getByRole("button", { name: /approve/i });
    expect(approve.className).toMatch(/bg-text/);
    expect(approve.className).toMatch(/text-ground/);
  });
  it("has no approve logic: both buttons are disabled", () => {
    render(<Gate title="G" consequence="x" />);
    expect(screen.getByRole("button", { name: /approve/i }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /send back/i }).hasAttribute("disabled")).toBe(true);
  });
  it("wraps long text", () => {
    render(<Gate title={INDIC.ml} consequence={INDIC.hi} />);
    expect(screen.getByText(INDIC.hi).className).toMatch(WRAP);
  });
});

describe("VideoBox and FrameStrip", () => {
  it("video box uses the video's own aspect", () => {
    const a = render(<VideoBox aspect="9:16" label="Preview" />);
    expect(a.container.querySelector("[data-aspect]")!.className).toMatch(/aspect-\[9\/16\]/);
    cleanup();
    const b = render(<VideoBox aspect="16:9" label="Preview" />);
    expect(b.container.querySelector("[data-aspect]")!.className).toMatch(/aspect-video/);
  });
  it("says so when there is no frame", () => {
    render(<VideoBox aspect="9:16" label="Short preview" />);
    expect(screen.getByText(/no frame rendered yet/i)).toBeTruthy();
  });
  it("frame strip is a keyboard-reachable scroll region with timecodes", () => {
    render(<FrameStrip aspect="9:16" frames={[{ time: "0:00" }, { time: "0:07" }, { time: "0:14" }]} />);
    const region = screen.getByRole("region", { name: /frames/i });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(within(region).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText("0:07")).toBeTruthy();
  });
  it("empty frame strip says so", () => {
    render(<FrameStrip aspect="16:9" frames={[]} />);
    expect(screen.getByText(/no frames yet/i)).toBeTruthy();
  });
});

describe("LogTail", () => {
  it("is a log with level words and wrapped lines", () => {
    render(<LogTail lines={[{ time: "10:02:11", level: "info", text: "Render started" }, { time: "10:02:40", level: "error", text: NOSPACE }]} />);
    const log = screen.getByRole("log", { name: /log/i });
    expect(within(log).getByText("error")).toBeTruthy();
    expect(within(log).getByText("info")).toBeTruthy();
    expect(screen.getByText(NOSPACE).className).toMatch(WRAP);
  });
  it("shows only the last `max` lines", () => {
    const lines = Array.from({ length: 10 }, (_, i) => ({ time: `0:0${i}`, level: "info" as const, text: `line ${i}` }));
    render(<LogTail lines={lines} max={3} />);
    expect(screen.queryByText("line 6")).toBeNull();
    expect(screen.getByText("line 9")).toBeTruthy();
  });
  it("empty", () => {
    render(<LogTail lines={[]} />);
    expect(screen.getByText(/nothing logged yet/i)).toBeTruthy();
  });
  it("loading is announced", () => {
    render(<LogTail lines={[]} loading />);
    expect(screen.getByText(/loading the log/i)).toBeTruthy();
  });
});

describe("ChannelInitial", () => {
  it("neighbouring channels are at least 60 degrees apart", () => {
    for (let i = 0; i < 40; i++) expect(hueGap(hueFor(i), hueFor(i + 1))).toBeGreaterThanOrEqual(60);
  });
  it("hueGap is circular", () => {
    expect(hueGap(350, 10)).toBe(20);
    expect(hueGap(0, 180)).toBe(180);
  });
  it("shows the first letter, Indic included, hidden from AT", () => {
    const { container } = render(<ChannelInitial name="தமிழ் channel" index={2} />);
    expect(container.firstElementChild!.getAttribute("aria-hidden")).toBe("true");
    expect(container.textContent).toBe("த");
  });
  it("falls back for an empty name", () => {
    const { container } = render(<ChannelInitial name="" index={0} />);
    expect(container.textContent).toBe("?");
  });
});

describe("source rules", () => {
  const dir = "src/ui/domain";
  const files = readdirSync(dir).map((f) => ({ f, src: readFileSync(`${dir}/${f}`, "utf8") }));
  it("has the eleven domain files", () => {
    expect(files.map((x) => x.f).sort()).toEqual(
      ["channel-initial.tsx", "cut-strip.tsx", "decision-row.tsx", "empty-frame.tsx", "frame-strip.tsx", "gate.tsx", "kpi-strip.tsx", "log-tail.tsx", "spend-line.tsx", "stages.ts", "video-box.tsx"],
    );
  });
  for (const bad of [/shadow/, /gradient/, /\b(indigo|slate|zinc|purple|violet|blue|red|green|gray|neutral)-\d/, /backdrop-blur/, /ui\/sample/]) {
    it(`no ${bad}`, () => {
      for (const { f, src } of files) expect(src.match(bad), f).toBeNull();
    });
  }
  it("no client directive: all server-renderable", () => {
    for (const { f, src } of files) expect(src, f).not.toMatch(/["']use client["']/);
  });
});
