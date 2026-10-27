import { Suspense } from "react";
import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth/require-owner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle, AlertDialogTrigger } from "@/ui/primitives/alert-dialog";
import { Button } from "@/ui/primitives/button";
import { Card } from "@/ui/primitives/card";
import { Checkbox } from "@/ui/primitives/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/ui/primitives/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/ui/primitives/dropdown-menu";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { Pill } from "@/ui/primitives/pill";
import { Progress } from "@/ui/primitives/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/primitives/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/ui/primitives/sheet";
import { Skeleton } from "@/ui/primitives/skeleton";
import { Switch } from "@/ui/primitives/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/primitives/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/primitives/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/ui/primitives/tooltip";
import { ChannelInitial } from "@/ui/domain/channel-initial";
import { CutStrip } from "@/ui/domain/cut-strip";
import { DecisionRow } from "@/ui/domain/decision-row";
import { EmptyFrame } from "@/ui/domain/empty-frame";
import { FrameStrip } from "@/ui/domain/frame-strip";
import { Gate } from "@/ui/domain/gate";
import { KpiStrip } from "@/ui/domain/kpi-strip";
import { LogTail } from "@/ui/domain/log-tail";
import { SpendLine } from "@/ui/domain/spend-line";
import { stagesFor, type CutStage, type Format, type StageState } from "@/ui/domain/stages";
import { VideoBox } from "@/ui/domain/video-box";
import { sample } from "@/ui/sample/data";

// Design review aid: every building block in every state. Dev/staging only, never in the nav.
export default function DevUi() {
  return (
    <Suspense fallback={<div aria-hidden className="h-64 rounded-card bg-surface" />}>
      <Owned />
    </Suspense>
  );
}

async function Owned() {
  await requireOwner();
  if (process.env.NODE_ENV === "production") notFound();
  return <Gallery />;
}

const LONG_HI = sample.videos[0]!.title + " और यह शीर्षक जानबूझकर बहुत लंबा रखा गया है ताकि कभी न कटे";
const LONG_TA = sample.videos[1]!.title + " என்பதை விளக்கும் மிக நீண்ட தலைப்பு இங்கே சோதனைக்காக";
const LONG_ML = sample.videos[3]!.title + " എന്നതിനെക്കുറിച്ചുള്ള വളരെ നീണ്ട തലക്കെട്ട് പരിശോധനയ്ക്കായി";
const LONG_TE = sample.videos[2]!.title + " అనే దాని గురించి చాలా పొడవైన శీర్షిక పరీక్ష కోసం";
const LONG_KN = sample.videos[4]!.title + " ಎಂಬುದರ ಬಗ್ಗೆ ತುಂಬಾ ಉದ್ದವಾದ ಶೀರ್ಷಿಕೆ ಪರೀಕ್ಷೆಗಾಗಿ";
const NOSPACE = "x".repeat(120);

const mk = (format: Format, states: Record<string, StageState> = {}): CutStage[] =>
  stagesFor(format).map((s) => ({ ...s, ...(states[s.key] ?? { state: "todo" as const }) }));
const done = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, { state: "done" as const }]));

const CUTS: [string, Format, Record<string, StageState>][] = [
  ["Not started", "short", {}],
  ["Running", "short", { ...done("draft", "build"), voice: { state: "running", progress: 60 } }],
  ["Held at a gate", "short", { ...done("draft"), build: { state: "held", gate: "script" } }],
  ["Failed", "short", { ...done("draft", "build"), voice: { state: "failed" } }],
  ["All done", "short", done("draft", "build", "voice", "render", "sound", "check", "review", "publish")],
  ["Long, with chapters", "long", { ...done("outline", "draft"), build: { state: "running", progress: 40, chapters: ["done", "done", "running", "todo", "todo"] } }],
];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-gap">
      <h2 id={id} className="text-title font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}
const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex min-w-0 flex-col gap-2">
    <p className="m-0 text-small text-muted">{label}</p>
    <div className="flex min-w-0 flex-wrap items-center gap-3">{children}</div>
  </div>
);

function Gallery() {
  const v = sample.videos;
  return (
    <TooltipProvider>
      <div data-testid="dev-ui" className="flex max-w-5xl flex-col gap-layout">
        <h1 className="text-page-title font-semibold tracking-tight">UI gallery</h1>
        <p className="m-0 max-w-[60ch] text-body text-muted">
          Every building block in every static state, against made-up data. Development only. <a className="underline" href="/dev/ui/home">Sample Home</a> and{" "}
          <a className="underline" href="/dev/ui/video">sample video page</a>.
        </p>

        <Section id="buttons-h" title="Buttons">
          {(["primary", "secondary", "ghost", "destructive"] as const).map((variant) => (
            <Row key={variant} label={variant}>
              <Button variant={variant}>Default</Button>
              <Button variant={variant} disabled>Disabled</Button>
              <Button variant={variant} className="max-w-48 overflow-hidden">{LONG_HI}</Button>
            </Row>
          ))}
        </Section>

        <Section id="forms-h" title="Fields">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2"><Label htmlFor="f-default">Default</Label><Input id="f-default" placeholder="Placeholder" /></div>
            <div className="flex flex-col gap-2"><Label htmlFor="f-filled">Filled, Indic</Label><Input id="f-filled" lang="hi" defaultValue={LONG_HI} /></div>
            <div className="flex flex-col gap-2"><Label htmlFor="f-dis">Disabled</Label><Input id="f-dis" disabled defaultValue="Locked value" /></div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="f-err">Error</Label>
              <Input id="f-err" aria-invalid="true" aria-describedby="f-err-msg" defaultValue="not-a-key" />
              <p id="f-err-msg" className="m-0 text-small text-negative">That key was not accepted.</p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="f-sel">Select</Label>
              <Select defaultValue="a">
                <SelectTrigger id="f-sel"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="a">First option</SelectItem><SelectItem value="b">{LONG_TA}</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="f-sel-dis">Select, disabled</Label>
              <Select disabled><SelectTrigger id="f-sel-dis"><SelectValue placeholder="Choose" /></SelectTrigger><SelectContent><SelectItem value="a">A</SelectItem></SelectContent></Select>
            </div>
          </div>
          <Row label="Checkbox: off, on, disabled">
            <Checkbox aria-label="Off" /><Checkbox aria-label="On" defaultChecked /><Checkbox aria-label="Disabled" disabled /><Checkbox aria-label="Disabled on" disabled defaultChecked />
          </Row>
          <Row label="Switch: off, on, disabled">
            <Switch aria-label="Off" /><Switch aria-label="On" defaultChecked /><Switch aria-label="Disabled" disabled /><Switch aria-label="Disabled on" disabled defaultChecked />
          </Row>
        </Section>

        <Section id="status-h" title="Pills, progress, skeleton">
          <Row label="Pill tones">
            <Pill tone="neutral">Neutral</Pill><Pill tone="positive">Positive</Pill><Pill tone="warning">Warning</Pill><Pill tone="negative">Negative</Pill>
          </Row>
          <Row label="Progress: 0, 45, 100">
            <Progress value={0} aria-label="0 percent" className="w-40" /><Progress value={45} aria-label="45 percent" className="w-40" /><Progress value={100} aria-label="100 percent" className="w-40" />
          </Row>
          <Row label="Skeleton"><Skeleton className="h-4 w-40" /><Skeleton className="size-10" /></Row>
        </Section>

        <Section id="cards-h" title="Card, table, tabs">
          <Card>Card with a short line.</Card>
          <Card lang="ml" className="max-w-sm [overflow-wrap:anywhere]">{LONG_ML}</Card>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead>Title</TableHead><TableHead>Language</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
              <TableBody>
                {v.map((x) => (
                  <TableRow key={x.id}><TableCell lang={x.lang}>{x.title}</TableCell><TableCell>{x.lang}</TableCell><TableCell>{x.status}</TableCell></TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Tabs defaultValue="one">
            <TabsList><TabsTrigger value="one">First</TabsTrigger><TabsTrigger value="two">Second</TabsTrigger><TabsTrigger value="three" disabled>Disabled</TabsTrigger></TabsList>
            <TabsContent value="one" className="pt-3 text-body">First panel</TabsContent>
            <TabsContent value="two" className="pt-3 text-body">Second panel</TabsContent>
          </Tabs>
        </Section>

        <Section id="overlays-h" title="Dialogs, menus, tooltip">
          <Row label="Triggers (open them to review the overlay)">
            <Dialog><DialogTrigger asChild><Button variant="secondary">Dialog</Button></DialogTrigger><DialogContent><DialogTitle>Dialog title</DialogTitle><DialogDescription>{LONG_TE}</DialogDescription></DialogContent></Dialog>
            <AlertDialog><AlertDialogTrigger asChild><Button variant="destructive">Alert dialog</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogTitle>Remove this key?</AlertDialogTitle><AlertDialogDescription>Videos in progress will stop at the next paid step.</AlertDialogDescription><AlertDialogCancel>Keep it</AlertDialogCancel><AlertDialogAction>Remove</AlertDialogAction></AlertDialogContent></AlertDialog>
            <Sheet><SheetTrigger asChild><Button variant="secondary">Sheet</Button></SheetTrigger><SheetContent><SheetTitle>Sheet title</SheetTitle><SheetDescription>{LONG_KN}</SheetDescription></SheetContent></Sheet>
            <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost">Menu</Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem>First</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem>{LONG_HI}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
            <Tooltip><TooltipTrigger asChild><Button variant="ghost">Tooltip</Button></TooltipTrigger><TooltipContent>Short hint</TooltipContent></Tooltip>
          </Row>
        </Section>

        <Section id="cut-h" title="Cut strip">
          {CUTS.map(([label, format, states]) => (
            <Row key={label} label={label}>
              <CutStrip format={format} aspect={format === "long" ? "16:9" : "9:16"} stages={mk(format, states)} className="w-full max-w-xl" />
            </Row>
          ))}
          <Row label="Inline layout, no thumbnail"><CutStrip format="short" aspect="9:16" thumbnail={false} stages={mk("short", { ...done("draft"), build: { state: "running", progress: 20 } })} className="w-full max-w-xl" /></Row>
        </Section>

        <Section id="decision-h" title="Decision row">
          <DecisionRow title={v[0]!.title} lang="hi" format="short" aspect="9:16" stages={mk("short", { ...done("draft"), build: { state: "held", gate: "script" } })} gateLabel="Script gate" costLabel="$0.42" ageLabel="2 h ago" href="#" channelName="Tamarind Lane" channelIndex={0} />
          <DecisionRow title={LONG_HI} lang="hi" format="short" aspect="9:16" stages={mk("short", { ...done("draft"), build: { state: "held", gate: "script" } })} gateLabel={LONG_TA} costLabel="$12.40" ageLabel="3 days ago" href="#" channelName={NOSPACE} channelIndex={1} />
          <DecisionRow title={LONG_ML} lang="ml" format="long" aspect="16:9" stages={mk("long", { ...done("outline"), draft: { state: "held", gate: "outline" } })} gateLabel="Outline gate" costLabel="$0.61" ageLabel="just now" href="#" channelName="Kite Workshop" channelIndex={2} />
        </Section>

        <Section id="kpi-h" title="Figures and spend">
          <KpiStrip lead={{ label: "Waiting on you", value: 4 }} figures={[{ label: "In production", value: 2 }, { label: "Published this month", value: 0 }, { label: "Average cost", value: null }, { label: LONG_TA, value: 1, note: "vs last Monday" }]} />
          <Row label="Spend: low, near cap, over cap">
            <SpendLine spentMicroUsd={4_200_000} capMicroUsd={15_000_000} className="w-64" />
            <SpendLine spentMicroUsd={14_000_000} capMicroUsd={15_000_000} className="w-64" />
            <SpendLine spentMicroUsd={16_500_000} capMicroUsd={15_000_000} className="w-64" />
          </Row>
          <Row label="Channel initials">
            {sample.channels.map((c, i) => (<span key={c.id} className="flex items-center gap-2 text-small"><ChannelInitial name={c.name} index={i} />{c.name}</span>))}
            <ChannelInitial name={v[0]!.title} index={3} /><ChannelInitial name="" index={4} />
          </Row>
        </Section>

        <Section id="frames-h" title="Video box, frames, gate">
          <Row label="Video box: 9:16 empty, 16:9 empty, 9:16 with a frame">
            <VideoBox aspect="9:16" label="Short, no frame" className="max-w-[160px]" />
            <VideoBox aspect="16:9" label="Long, no frame" className="max-w-[280px]" />
            <VideoBox aspect="9:16" label="Short with frame" className="max-w-[160px]"><span lang="hi" className="p-2 text-center text-section [overflow-wrap:anywhere]">{v[0]!.title}</span></VideoBox>
          </Row>
          <Row label="Frame strip: frames, none">
            <FrameStrip aspect="9:16" frames={["0:00", "0:03", "0:07", "0:12", "0:18"].map((time) => ({ time }))} className="max-w-full" />
            <FrameStrip aspect="16:9" frames={[]} />
          </Row>
          <Gate title="Script gate" consequence="Approving starts the voice, which costs about $0.35." />
          <Gate title={LONG_HI} consequence={LONG_TE} />
        </Section>

        <Section id="empty-h" title="Empty frames and log">
          <EmptyFrame message="Nothing is waiting for your decision." />
          <EmptyFrame message="No short has been rendered yet." aspect="9:16" action={<Button variant="secondary">Start one</Button>} />
          <EmptyFrame message={LONG_ML} aspect="16:9" />
          <LogTail lines={[]} />
          <LogTail lines={[]} loading />
          <LogTail lines={[{ time: "12:00:01", level: "info", text: "Started" }, { time: "12:00:04", level: "warn", text: "Retrying once" }, { time: "12:00:09", level: "error", text: `${LONG_HI} ${NOSPACE}` }]} />
        </Section>
      </div>
    </TooltipProvider>
  );
}
