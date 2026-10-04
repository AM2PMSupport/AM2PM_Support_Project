/**
 * Lead record skeleton: header strip, form panels on the left, timeline on
 * the right — the frame of components/leads/lead-record.tsx.
 */
import { TopbarSkeleton } from "@/components/ui/skeletons";

export default function Loading() {
  return (
    <div className="flex h-dvh flex-col" aria-busy="true" aria-label="Loading lead">
      <TopbarSkeleton search={false} />
      <div className="flex shrink-0 items-center gap-3 border-b border-rule px-6 py-3">
        <span className="skeleton h-8 w-20" />
        <div className="flex flex-col gap-1.5"><span className="skeleton h-3 w-24" /><span className="skeleton h-5 w-48" /></div>
        <span className="skeleton ml-auto h-9 w-32" />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] xl:grid-cols-[minmax(0,1fr)_440px]">
        <div className="flex flex-col gap-5 px-6 py-5">
          {[4, 3, 6].map((n, s) => (
            <div key={s} className="panel grid grid-cols-1 gap-4 p-5 md:grid-cols-2">
              <span className="skeleton h-3 w-24 md:col-span-2" />
              {Array.from({ length: n }, (_, i) => <span key={i} className="skeleton h-10" />)}
            </div>
          ))}
        </div>
        <div className="hidden flex-col gap-4 border-l border-rule bg-sheet px-5 py-5 lg:flex">
          <span className="skeleton h-8 w-full" />
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex gap-3"><span className="skeleton h-3 w-3 rounded-full" /><div className="flex flex-1 flex-col gap-1.5"><span className="skeleton h-3.5 w-[70%]" /><span className="skeleton h-3 w-[40%]" /></div></div>
          ))}
        </div>
      </div>
    </div>
  );
}
