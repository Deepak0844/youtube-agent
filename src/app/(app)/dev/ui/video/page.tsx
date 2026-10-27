import { Suspense } from "react";
import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth/require-owner";
import { CutStrip } from "@/ui/domain/cut-strip";
import { FrameStrip } from "@/ui/domain/frame-strip";
import { Gate } from "@/ui/domain/gate";
import { LogTail } from "@/ui/domain/log-tail";
import { stagesFor } from "@/ui/domain/stages";
import { VideoBox } from "@/ui/domain/video-box";
import { formatUsd } from "@/ui/domain/spend-line";
import { Pill } from "@/ui/primitives/pill";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/primitives/tabs";
import { sample } from "@/ui/sample/data";
import { videoCost } from "@/ui/sample/reconcile";

// The Short detail layout against made-up data. Dev/staging only, never in the nav.
export default function DevVideo() {
  return (
    <Suspense fallback={<div aria-hidden className="h-64 rounded-card bg-surface" />}>
      <Owned />
    </Suspense>
  );
}

async function Owned() {
  await requireOwner();
  if (process.env.NODE_ENV === "production") notFound();
  return <VideoSample />;
}

function VideoSample() {
  const v = sample.videos[0]!; // Hindi short held at the script gate
  const stages = stagesFor("short").map((s) => ({
    ...s,
    ...(s.key === "draft" ? { state: "held" as const, gate: "script" } : { state: "todo" as const }),
  }));
  return (
    <div data-testid="dev-ui" className="flex max-w-6xl flex-col gap-layout">
      <header className="flex min-w-0 flex-col gap-3">
        <h1 lang={v.lang} className="text-page-title font-semibold tracking-tight [overflow-wrap:anywhere]">{v.title}</h1>
        <div className="flex flex-wrap items-center gap-2 text-small text-muted">
          <Pill>Short</Pill>
          <span>{sample.channels.find((c) => c.id === v.channelId)!.name}</span>
          <span className="tabular-nums">{formatUsd(videoCost(sample, v.id))} so far</span>
        </div>
        <CutStrip format="short" aspect="9:16" stages={stages} thumbnail={false} />
      </header>
      <div className="grid gap-layout lg:grid-cols-[minmax(0,360px)_1fr]">
        <VideoBox aspect="9:16" label="Short preview" />
        <div className="flex min-w-0 flex-col gap-gap">
          <Gate title="Script gate" consequence="Approving starts the voice and render. That step costs about $0.35." />
          <FrameStrip aspect="9:16" frames={["0:00", "0:07", "0:14"].map((time) => ({ time }))} />
        </div>
      </div>
      <Tabs defaultValue="script">
        <TabsList><TabsTrigger value="script">Script</TabsTrigger><TabsTrigger value="log">Log</TabsTrigger><TabsTrigger value="cost">Cost</TabsTrigger></TabsList>
        <TabsContent value="script" className="pt-4"><p lang={v.lang} className="m-0 max-w-[60ch] text-body [overflow-wrap:anywhere]">{v.title}</p></TabsContent>
        <TabsContent value="log" className="pt-4"><LogTail lines={[{ time: "12:00:01", level: "info", text: "Script drafted" }]} /></TabsContent>
        <TabsContent value="cost" className="pt-4"><p className="m-0 text-body tabular-nums">{formatUsd(videoCost(sample, v.id))}</p></TabsContent>
      </Tabs>
    </div>
  );
}
