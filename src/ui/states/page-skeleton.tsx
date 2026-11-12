import { Skeleton } from "../primitives/skeleton";

type Variant = "list" | "grid" | "detail" | "form" | "inbox";

const Header = () => (
  <div className="flex items-end justify-between gap-4">
    <div className="flex flex-col gap-2">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-4 w-72" />
    </div>
    <Skeleton className="h-8 w-28" />
  </div>
);
const Rows = ({ n }: { n: number }) => (
  <div className="flex flex-col divide-y divide-border rounded-card border border-border">
    {Array.from({ length: n }, (_, i) => (
      <div key={i} className="flex items-center gap-3 p-3">
        <Skeleton className="h-10 w-8" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-1/4" />
        </div>
        <Skeleton className="h-5 w-24 rounded-full" />
      </div>
    ))}
  </div>
);

/** Page-shaped placeholder (spec §4.6.1), so nothing jumps when the data arrives. Screen readers hear "Loading". */
export function PageSkeleton({ variant }: { variant: Variant }) {
  return (
    <div className="ui-wait flex min-w-0 flex-col gap-layout">
      <span className="sr-only" role="status">
        Loading
      </span>
      <div aria-hidden="true" className="flex min-w-0 flex-col gap-layout">
        <Header />
        {variant === "list" && <Rows n={6} />}
        {variant === "grid" && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-gap">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-36" />
            ))}
          </div>
        )}
        {variant === "detail" && (
          <>
            <Skeleton className="h-14" />
            <div className="grid gap-layout lg:grid-cols-[minmax(320px,38%)_1fr]">
              <Skeleton className="aspect-video" />
              <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] content-start gap-gap">
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} className="h-12" />
                ))}
              </div>
            </div>
          </>
        )}
        {variant === "form" && (
          <div className="flex flex-col gap-gap rounded-card border border-border p-pad">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex flex-col gap-2">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-8" />
              </div>
            ))}
          </div>
        )}
        {variant === "inbox" && (
          <div className="grid gap-layout md:grid-cols-[310px_1fr]">
            <Rows n={5} />
            <Skeleton className="hidden h-96 md:block" />
          </div>
        )}
      </div>
    </div>
  );
}
