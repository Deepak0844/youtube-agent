import { Suspense } from "react";
import { setupLinkUsable } from "@/server/db/owner";
import { getPool } from "@/server/db/pool";
import { SetupForm } from "./setup-form";

// Public (see PUBLIC_ROUTES). The token is request-time data, so everything that touches it sits inside <Suspense>.
export default function SetupPage({ params }: PageProps<"/setup/[token]">) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Set up YT Studio</h1>
      <Suspense fallback={null}>
        <Body params={params} />
      </Suspense>
    </main>
  );
}

async function Body({ params }: { params: PageProps<"/setup/[token]">["params"] }) {
  const { token } = await params;
  if (!(await setupLinkUsable(getPool(), token))) return <p>This link is invalid or has expired.</p>;
  return <SetupForm token={token} />;
}
