import { Suspense } from "react";
import { safeNext } from "@/lib/auth/policy";
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
  return <LoginForm next={safeNext(Array.isArray(raw) ? raw[0] : raw)} />;
}
