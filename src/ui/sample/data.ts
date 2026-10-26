// Invented sample data for /dev/ui screens only. Never import from production
// code (enforced by tests/unit/sample-data-isolation.test.ts). All money is
// integer micro-USD (1 USD = 1_000_000).

export type Lang = "en" | "hi" | "ta" | "te" | "ml" | "kn";
export type Format = "short" | "long";
export type Status = "done" | "running" | "held" | "failed";
export type GateName =
  | "outline"
  | "script"
  | "cost"
  | "chapter"
  | "video"
  | "evidence"
  | "publish";

export interface SampleVideo {
  id: string;
  title: string;
  lang: Lang;
  format: Format;
  channelId: string;
  status: Status;
  /** Set exactly when status is "held". */
  gate: GateName | null;
}
export interface LedgerRow {
  id: string;
  videoId: string;
  day: string; // YYYY-MM-DD
  stage: string;
  microUsd: number;
}
export interface SampleIdea {
  id: string;
  title: string;
  lang: Lang;
}
export interface SampleData {
  today: string;
  budget: { dayCapMicroUsd: number };
  accounts: { id: string; name: string }[];
  channels: { id: string; name: string; accountId: string }[];
  gates: { name: GateName; waiting: number }[];
  videos: SampleVideo[];
  ledger: LedgerRow[];
  ideas: SampleIdea[];
}

const usd = (cents: number) => cents * 10_000;

export const sample: SampleData = {
  today: "2026-10-26",
  budget: { dayCapMicroUsd: 15_000_000 },
  accounts: [
    { id: "acc1", name: "kiran.sample@example.test" },
    { id: "acc2", name: "meera.sample@example.test" },
  ],
  channels: [
    { id: "ch1", name: "Tamarind Lane", accountId: "acc1" },
    { id: "ch2", name: "Kite Workshop", accountId: "acc1" },
    { id: "ch3", name: "Lantern Notes", accountId: "acc2" },
  ],
  gates: [
    { name: "outline", waiting: 1 },
    { name: "script", waiting: 1 },
    { name: "cost", waiting: 1 },
    { name: "chapter", waiting: 0 },
    { name: "video", waiting: 1 },
    { name: "evidence", waiting: 0 },
    { name: "publish", waiting: 0 },
  ],
  videos: [
    { id: "v1", title: "बारिश में मिट्टी की खुशबू क्यों आती है", lang: "hi", format: "short", channelId: "ch1", status: "held", gate: "script" },
    { id: "v2", title: "மின்மினிப் பூச்சிகள் ஒளிர்வது எப்படி", lang: "ta", format: "short", channelId: "ch2", status: "running", gate: null },
    { id: "v3", title: "చంద్రుడు రోజూ ఆకారం ఎందుకు మారుతాడు", lang: "te", format: "short", channelId: "ch3", status: "held", gate: "video" },
    { id: "v4", title: "കടൽ തിരമാലകൾ എങ്ങനെ ഉണ്ടാകുന്നു", lang: "ml", format: "long", channelId: "ch1", status: "held", gate: "outline" },
    { id: "v5", title: "ಇರುವೆಗಳು ಸಾಲಾಗಿ ಏಕೆ ನಡೆಯುತ್ತವೆ", lang: "kn", format: "short", channelId: "ch2", status: "done", gate: null },
    { id: "v6", title: "How a paper kite really stays up", lang: "en", format: "long", channelId: "ch3", status: "held", gate: "cost" },
    { id: "v7", title: "Why bridges hum in the wind", lang: "en", format: "short", channelId: "ch1", status: "failed", gate: null },
    { id: "v8", title: "पतंग की डोर का विज्ञान", lang: "hi", format: "long", channelId: "ch2", status: "running", gate: null },
  ],
  ledger: [
    { id: "l1", videoId: "v1", day: "2026-10-26", stage: "script", microUsd: usd(42) },
    { id: "l2", videoId: "v2", day: "2026-10-26", stage: "voice", microUsd: usd(118) },
    { id: "l3", videoId: "v3", day: "2026-10-26", stage: "script", microUsd: usd(35) },
    { id: "l4", videoId: "v3", day: "2026-10-26", stage: "voice", microUsd: usd(96) },
    { id: "l5", videoId: "v4", day: "2026-10-26", stage: "outline", microUsd: usd(61) },
    { id: "l6", videoId: "v6", day: "2026-10-26", stage: "outline", microUsd: usd(74) },
    { id: "l7", videoId: "v7", day: "2026-10-26", stage: "script", microUsd: usd(29) },
    { id: "l8", videoId: "v8", day: "2026-10-26", stage: "script", microUsd: usd(88) },
    { id: "l9", videoId: "v5", day: "2026-10-12", stage: "script", microUsd: usd(33) },
    { id: "l10", videoId: "v5", day: "2026-10-12", stage: "voice", microUsd: usd(105) },
    { id: "l11", videoId: "v2", day: "2026-10-20", stage: "script", microUsd: usd(40) },
    { id: "l12", videoId: "v6", day: "2026-10-21", stage: "research", microUsd: usd(52) },
  ],
  ideas: [
    { id: "i1", title: "मॉनसून की पहली बूंद", lang: "hi" },
    { id: "i2", title: "கோவில் மணியின் ஒலி அறிவியல்", lang: "ta" },
    { id: "i3", title: "ఇంద్రధనస్సు ఏడు రంగులు ఎందుకు", lang: "te" },
    { id: "i4", title: "How a stepwell keeps water cool", lang: "en" },
  ],
};
