/**
 * Floor skeleton: KPI strip, calls-by-hour panel and the agents list, in the
 * same grid as app/(app)/dashboard/page.tsx, so the numbers drop into place.
 */
import { TopbarSkeleton } from "@/components/ui/skeletons";

export default function Loading() {
  return (
    <div className="flex min-h-dvh flex-col" aria-busy="true" aria-label="Loading Floor">
      <TopbarSkeleton />
      <div className="flex flex-col gap-6 px-6 py-6">
        <div className="panel grid grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex flex-col gap-2 border-r border-b border-rule px-5 py-4 last:border-r-0 xl:border-b-0">
              <span className="skeleton h-3 w-20" />
              <span className="skeleton h-7 w-16" />
              <span className="skeleton h-2.5 w-24" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <div className="panel flex flex-col gap-4 p-5">
            <span className="skeleton h-4 w-32" />
            <div className="flex h-[180px] items-end gap-1.5">
              {[30, 45, 60, 80, 70, 95, 85, 65, 50, 75, 55, 40].map((h, i) => (
                <span key={i} className="skeleton flex-1" style={{ height: `${h}%` }} />
              ))}
            </div>
            <div className="grid grid-cols-4 gap-4 border-t border-rule pt-4">
              {Array.from({ length: 4 }, (_, i) => <span key={i} className="skeleton h-8" />)}
            </div>
          </div>
          <div className="panel flex flex-col">
            <div className="p-5 pb-3"><span className="skeleton h-4 w-40" /></div>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="grid grid-cols-[28px_1fr_auto] items-center gap-3 border-t border-rule px-5 py-2.5">
                <span className="skeleton h-7 w-7 rounded-full" />
                <span className="skeleton h-3.5 w-32" />
                <span className="skeleton h-5 w-16" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
