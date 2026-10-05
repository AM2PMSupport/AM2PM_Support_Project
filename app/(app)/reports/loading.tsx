/** Reports skeleton: filter bar, tabs and KPI strip, so the numbers drop into place. */
import { TopbarSkeleton } from "@/components/ui/skeletons";

export default function Loading() {
  return (
    <div className="flex min-h-dvh flex-col" aria-busy="true" aria-label="Loading Reports">
      <TopbarSkeleton />
      <div className="flex flex-col gap-5 px-4 py-5 sm:px-6">
        <span className="skeleton h-16 w-full" />
        <span className="skeleton h-8 w-80" />
        <div className="panel grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex flex-col gap-2 border-r border-b border-rule px-4 py-3.5">
              <span className="skeleton h-3 w-16" />
              <span className="skeleton h-6 w-14" />
            </div>
          ))}
        </div>
        <span className="skeleton h-64 w-full" />
      </div>
    </div>
  );
}
