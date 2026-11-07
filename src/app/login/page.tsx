import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { safeNext } from "@/lib/auth/policy";
import { readSessionCookie } from "@/lib/auth/session-cookie";
import { validateSession } from "@/server/db/auth";
import { getPool } from "@/server/db/pool";
import { AuthFrame } from "@/ui/auth/auth-frame";
import { LoginForm } from "./login-form";

// Public (see PUBLIC_ROUTES). searchParams is request-time data, so it is read inside <Suspense> (cacheComponents).
export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <AuthFrame title="Sign in" lead="Your studio is private. Sign in to see what is waiting for you.">
      <Suspense fallback={null}>
        <Form searchParams={searchParams} />
      </Suspense>
    </AuthFrame>
  );
}

async function Form({ searchParams }: { searchParams: PageProps<"/login">["searchParams"] }) {
  const sp = await searchParams;
  const raw = sp.next;
  const next = safeNext(Array.isArray(raw) ? raw[0] : raw);
  // Already signed in (a REAL session check, not just a cookie): skip the form.
  const token = readSessionCookie((await headers()).get("cookie"));
  if (token && (await validateSession(getPool(), token)).ok) redirect(next);
  return <LoginForm next={next} />;
}
