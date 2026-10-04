/**
 * Calls skeleton: filter bar and the 9-column call log in the fixed frame of
 * app/(app)/calls/page.tsx, paging pinned at the bottom.
 */
import { TableSkeleton, ToolbarSkeleton, TopbarSkeleton } from "@/components/ui/skeletons";

export default function Loading() {
  return (
    <div className="flex h-dvh flex-col" aria-busy="true" aria-label="Loading Calls">
      <TopbarSkeleton />
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pt-3 pb-2 md:px-6">
        <ToolbarSkeleton items={5} />
        <TableSkeleton rows={14} cols={9} />
        <div className="flex shrink-0 justify-between border-t border-rule pt-2">
          <span className="skeleton h-4 w-24" />
          <span className="skeleton h-8 w-24" />
        </div>
      </div>
    </div>
  );
}
