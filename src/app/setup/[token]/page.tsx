import { Suspense } from "react";
import { setupLinkUsable } from "@/server/db/owner";
import { getPool } from "@/server/db/pool";
import { AuthFrame } from "@/ui/auth/auth-frame";
import { SetupForm } from "./setup-form";

// Public (see PUBLIC_ROUTES). The token is request-time data, so everything that touches it sits inside <Suspense>.
export default function SetupPage({ params }: PageProps<"/setup/[token]">) {
  return (
    <AuthFrame title="Set up YT Studio" lead="Choose the username and password you will use to sign in. This link works once.">
      <Suspense fallback={null}>
        <Body params={params} />
      </Suspense>
    </AuthFrame>
  );
}

async function Body({ params }: { params: PageProps<"/setup/[token]">["params"] }) {
  const { token } = await params;
  if (!(await setupLinkUsable(getPool(), token))) return <p className="text-body text-pill-negative-ink">This link is invalid or has expired.</p>;
  return <SetupForm token={token} />;
}
