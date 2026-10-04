/**
 * Fallback skeleton for signed-in screens without their own loading.tsx
 * (each main screen has one shaped like itself). The sidebar (layout) stays
 * put; this fills the content area so a click never looks like nothing happened.
 */
import { TopbarSkeleton } from "@/components/ui/skeletons";

export default function Loading() {
  return (
    <div className="flex min-h-dvh flex-col" aria-busy="true" aria-label="Loading">
      <TopbarSkeleton />
      <div className="flex flex-col gap-4 px-6 py-6">
        <div className="panel flex flex-col gap-3 p-5">
          <span className="skeleton h-4 w-40" />
          {Array.from({ length: 6 }, (_, i) => <span key={i} className="skeleton h-9 w-full" />)}
        </div>
      </div>
    </div>
  );
}
