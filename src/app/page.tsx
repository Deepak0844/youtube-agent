import { Suspense } from "react";
import { logoutAction } from "./_actions/logout";
import { requireOwner } from "@/lib/auth/require-owner";

// Protected placeholder. requireOwner() reads the cookie (request-time data), so it runs inside <Suspense>.
export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      <Suspense fallback={<p>Loading…</p>}>
        <Owned />
      </Suspense>
    </main>
  );
}

async function Owned() {
  await requireOwner();
  return (
    <>
      <h1 className="text-3xl font-semibold">YT Studio</h1>
      <form action={logoutAction}>
        <button type="submit" className="rounded border px-3 py-2">
          Log out
        </button>
      </form>
    </>
  );
}
