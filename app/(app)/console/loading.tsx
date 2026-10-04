/**
 * Console skeleton: queue | lead workspace | timeline, using the same
 * responsive columns as components/console/live-console.tsx so the frame
 * doesn't shift when the queue and first lead arrive.
 */
import { TopbarSkeleton } from "@/components/ui/skeletons";

export default function Loading() {
  return (
    <div className="flex h-dvh flex-col" aria-busy="true" aria-label="Loading Console">
      <TopbarSkeleton />
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[270px_minmax(0,1fr)] lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)_320px] 2xl:grid-cols-[340px_minmax(0,1fr)_360px]">
        <aside className="hidden min-h-0 flex-col border-r border-rule bg-sheet md:flex">
          <div className="flex gap-1 border-b border-rule p-2">
            {Array.from({ length: 3 }, (_, i) => <span key={i} className="skeleton h-8 flex-1" />)}
          </div>
          <div className="border-b border-rule p-2"><span className="skeleton h-8 w-full" /></div>
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex flex-col gap-1.5 border-b border-rule px-4 py-3">
              <span className="skeleton h-3.5 w-[60%]" />
              <span className="skeleton h-3 w-[40%]" />
            </div>
          ))}
        </aside>
        <main className="flex min-h-0 flex-col gap-6 overflow-hidden px-4 py-5 md:px-6 xl:px-8 xl:py-7">
          <div className="flex flex-col gap-2">
            <span className="skeleton h-3 w-24" />
            <span className="skeleton h-7 w-64 max-w-full" />
            <span className="skeleton h-4 w-44" />
          </div>
          <div className="flex gap-3">
            <span className="skeleton h-12 w-48" />
            <span className="skeleton h-12 w-40" />
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {Array.from({ length: 8 }, (_, i) => <span key={i} className="skeleton h-10" />)}
          </div>
          <div className="panel flex flex-col gap-3 p-5">
            {Array.from({ length: 4 }, (_, i) => <span key={i} className="skeleton h-9 w-full" />)}
          </div>
        </main>
        <aside className="hidden min-h-0 flex-col gap-5 border-l border-rule bg-sheet px-5 py-6 xl:flex">
          <span className="skeleton h-4 w-24" />
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex gap-3">
              <span className="skeleton h-6 w-6 shrink-0 rounded-full" />
              <div className="flex flex-1 flex-col gap-1.5">
                <span className="skeleton h-3.5 w-[70%]" />
                <span className="skeleton h-3 w-[45%]" />
              </div>
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}
