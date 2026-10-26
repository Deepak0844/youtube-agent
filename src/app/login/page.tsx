import { Suspense } from "react";
import { safeNext } from "@/lib/auth/policy";
import { LoginForm } from "./login-form";

// Public (see PUBLIC_ROUTES). searchParams is request-time data, so it is read inside <Suspense> (cacheComponents).
export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <Suspense fallback={null}>
        <Form searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Form({ searchParams }: { searchParams: PageProps<"/login">["searchParams"] }) {
  const sp = await searchParams;
  const raw = sp.next;
  return <LoginForm next={safeNext(Array.isArray(raw) ? raw[0] : raw)} />;
}
