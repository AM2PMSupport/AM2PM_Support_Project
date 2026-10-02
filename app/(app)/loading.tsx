/**
 * Instant feedback while a signed-in screen loads its data. The sidebar
 * (layout) stays put; this skeleton fills the content area until the page's
 * server render streams in, so a click never looks like nothing happened.
 */
export default function Loading() {
  return (
    <div className="flex min-h-dvh flex-col" aria-busy="true" aria-label="Loading">
      <div className="flex h-[60px] items-center justify-between border-b border-rule px-6">
        <div className="flex flex-col gap-1.5">
          <span className="skeleton h-4 w-28" />
          <span className="skeleton h-3 w-44" />
        </div>
        <span className="skeleton h-9 w-[380px] max-w-[40vw]" />
      </div>
      <div className="flex flex-col gap-6 px-6 py-6">
        <div className="panel grid grid-cols-3 gap-px overflow-hidden xl:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex flex-col gap-2 px-5 py-4">
              <span className="skeleton h-3 w-20" />
              <span className="skeleton h-7 w-16" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <div className="panel flex flex-col gap-3 p-5">
            <span className="skeleton h-4 w-32" />
            <span className="skeleton h-[180px] w-full" />
          </div>
          <div className="panel flex flex-col gap-3 p-5">
            {Array.from({ length: 5 }, (_, i) => (
              <span key={i} className="skeleton h-9 w-full" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
