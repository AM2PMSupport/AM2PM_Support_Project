/**
 * Leads skeleton: toolbar, filter rail (lg+) and the lead table inside the
 * same fixed frame as app/(app)/leads/page.tsx, paging pinned at the bottom.
 */
import { TableSkeleton, ToolbarSkeleton, TopbarSkeleton } from "@/components/ui/skeletons";

export default function Loading() {
  return (
    <div className="flex h-dvh flex-col" aria-busy="true" aria-label="Loading Leads">
      <TopbarSkeleton search={false} />
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pt-3 pb-2 md:px-6">
        <ToolbarSkeleton items={4} />
        <div className="flex min-h-0 flex-1 gap-3">
          <aside className="hidden w-[260px] shrink-0 flex-col gap-2 rounded-md border border-rule bg-sheet p-3 lg:flex">
            <span className="skeleton mb-1 h-8 w-full" />
            {Array.from({ length: 10 }, (_, i) => <span key={i} className={`skeleton h-4 ${i % 3 ? "w-[75%]" : "w-[50%]"}`} />)}
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            <TableSkeleton rows={14} cols={8} />
          </div>
        </div>
        <div className="flex shrink-0 justify-between border-t border-rule pt-2">
          <span className="skeleton h-4 w-28" />
          <span className="skeleton h-8 w-40" />
        </div>
      </div>
    </div>
  );
}
