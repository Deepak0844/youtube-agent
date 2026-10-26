import { BottomBar } from "@/ui/shell/bottom-bar";
import { Sidebar } from "@/ui/shell/sidebar";
import { SkipLink } from "@/ui/shell/skip-link";
import { TopBar } from "@/ui/shell/topbar";

// The shell is static: nothing here reads the session except the spend figure, which sits in its own <Suspense>.
// Each page still guards itself with requireOwner() (the layout is not a security boundary).
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <SkipLink />
      <div className="flex min-h-dvh">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main id="main" tabIndex={-1} className="flex-1 px-4 pt-6 pb-24 outline-none md:px-gutter md:pb-12">
            {children}
          </main>
        </div>
      </div>
      <BottomBar />
    </>
  );
}
