import Link from "next/link";
import { Suspense } from "react";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/require-owner";
import { LANGUAGE_WORDS, STATUS_WORDS } from "@/server/core/videos-view";
import { getPool } from "@/server/db/pool";
import { Pill } from "@/ui/primitives/pill";
import { Skeleton } from "@/ui/primitives/skeleton";

// Placeholder until the full video page lands: topic and status only, so Library and New have somewhere to link.
export default function VideoPage({ params }: PageProps<"/videos/[id]">) {
  return (
    <Suspense fallback={<Skeleton aria-hidden className="h-40 w-full rounded-card" />}>
      <Owned params={params} />
    </Suspense>
  );
}

async function Owned({ params }: { params: PageProps<"/videos/[id]">["params"] }) {
  await requireOwner();
  const id = z.uuid().safeParse((await params).id);
  const r = id.success ? await getPool().query("select topic, language, status from videos where id = $1", [id.data]) : null;
  const v = r?.rows[0] as { topic: string; language: keyof typeof LANGUAGE_WORDS; status: keyof typeof STATUS_WORDS } | undefined;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <h1 className="text-page-title font-semibold tracking-tight [overflow-wrap:anywhere]">{v ? v.topic : "Video not found"}</h1>
      {v ? (
        <p className="m-0 flex flex-wrap items-center gap-3 text-body text-muted">
          <Pill tone={STATUS_WORDS[v.status].tone}>{STATUS_WORDS[v.status].label}</Pill>
          {LANGUAGE_WORDS[v.language]}
        </p>
      ) : null}
      <Link href="/videos" className="text-small text-muted underline">
        Library
      </Link>
    </div>
  );
}
