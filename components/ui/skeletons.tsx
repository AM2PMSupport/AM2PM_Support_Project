/**
 * Skeleton building blocks, shaped like the real screens so the wait looks like
 * the page arriving rather than a spinner. Each screen's loading.tsx composes
 * these to match its own frame (Topbar height, panels, table rows), and lists
 * reuse SkeletonRows while a filter / page change is in flight. No hooks, so
 * they render on the server from loading.tsx. Styles: .skeleton in globals.css.
 */

/** Matches components/shell/topbar.tsx: 60px bar, workspace chip, title + subtitle, optional search box. */
export function TopbarSkeleton({ search = true }: { search?: boolean }) {
  return (
    <div className="flex h-[60px] shrink-0 items-center gap-6 border-b border-rule px-6">
      <span className="skeleton h-9 w-9 shrink-0 sm:w-40" />
      <div className="flex flex-col gap-1.5">
        <span className="skeleton h-4 w-28" />
        <span className="skeleton h-3 w-52 max-w-[40vw]" />
      </div>
      {search ? <span className="skeleton ml-auto h-9 w-[380px] max-w-[40vw]" /> : <span className="flex-1" />}
      <span className="skeleton hidden h-4 w-20 sm:block" />
    </div>
  );
}

// Varied widths so rows don't look like a barcode.
const WIDTHS = ["w-[70%]", "w-[55%]", "w-[85%]", "w-[45%]", "w-[65%]", "w-[75%]"];

/** Table body rows; `cols` must equal the table's column count so the columns don't shift. */
export function SkeletonRows({ rows = 10, cols }: { rows?: number; cols: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} aria-hidden="true" className="[&>td]:border-b [&>td]:border-rule">
          {Array.from({ length: cols }, (_, c) => (
            <td key={c} className="px-3 py-3">
              <span className={`skeleton h-3.5 ${WIDTHS[(r + c) % WIDTHS.length]}`} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** A whole table panel (header + rows) for loading.tsx, where no real table exists yet. */
export function TableSkeleton({ rows = 12, cols = 8 }: { rows?: number; cols?: number }) {
  return (
    <div className="panel min-h-0 flex-1 overflow-hidden">
      <table className="w-full border-separate border-spacing-0">
        <thead>
          <tr className="[&>th]:border-b [&>th]:border-rule">
            {Array.from({ length: cols }, (_, c) => (
              <th key={c} className="px-3 py-3">
                <span className="skeleton h-3 w-16" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <SkeletonRows rows={rows} cols={cols} />
        </tbody>
      </table>
    </div>
  );
}

/** A row of filter controls (Leads / Calls toolbars). */
export function ToolbarSkeleton({ items = 5 }: { items?: number }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {Array.from({ length: items }, (_, i) => (
        <span key={i} className={`skeleton h-9 ${i === items - 1 ? "w-60" : "w-28"}`} />
      ))}
      <span className="skeleton ml-auto h-9 w-24" />
    </div>
  );
}
