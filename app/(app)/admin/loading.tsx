/**
 * Setup skeleton: search box and the grid of setting groups from
 * components/admin/setup-home.tsx (also a fair stand-in while a tab loads).
 */
import { TopbarSkeleton } from "@/components/ui/skeletons";

export default function Loading() {
  return (
    <div className="flex min-h-dvh flex-col" aria-busy="true" aria-label="Loading Setup">
      <TopbarSkeleton />
      <div className="flex flex-col gap-6 px-6 py-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <span className="skeleton h-10 w-full max-w-[420px]" />
          <span className="skeleton h-4 w-72" />
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, g) => (
            <div key={g} className="panel flex flex-col gap-3 p-5">
              <span className="skeleton h-5 w-28" />
              {Array.from({ length: 3 + (g % 2) }, (_, i) => <span key={i} className="skeleton h-4 w-[80%]" />)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
