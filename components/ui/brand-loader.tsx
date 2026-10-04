/**
 * Full-page loader: the AM2PM mark with its clock arcs turning and the
 * check-mark hand redrawing. Used where the whole screen is about to change
 * (first load before the shell exists, signing in, switching workspace) —
 * in-screen waits use the skeletons in components/ui/skeletons.tsx instead,
 * so the layout never jumps. No hooks: it renders from loading.tsx on the
 * server as well as from client overlays. Animation lives in globals.css
 * (.brand-*) and stops under prefers-reduced-motion.
 */
export function AnimatedLogoMark({ size = 56 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <path className="brand-arc-outer" d="M31.5 8.5A16 16 0 1 0 36 20" stroke="#6BD3DC" strokeWidth="4.2" strokeLinecap="round" />
      <path className="brand-arc-inner" d="M28.6 11.4A12 12 0 0 1 24 31.3" stroke="#F56332" strokeWidth="2.4" strokeLinecap="round" />
      <path className="brand-check" d="M12.5 15.5 19 22.5 33.5 8" stroke="#6BD3DC" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** `overlay` covers whatever is on screen (client-side waits); without it, it fills its parent (loading.tsx). */
export function BrandLoader({ label = "Loading", overlay = false }: { label?: string; overlay?: boolean }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`brand-loader flex flex-col items-center justify-center gap-5 bg-paper ${overlay ? "fixed inset-0 z-[100]" : "min-h-dvh w-full"}`}
    >
      <AnimatedLogoMark />
      <span className="leading-none text-ink text-center">
        <span className="block text-[17px] font-bold tracking-[0.06em]">AM2PM</span>
        <span className="mt-1 block text-[9px] font-semibold tracking-[0.42em] text-teal-ink opacity-90">SUPPORT</span>
      </span>
      <span className="text-[12.5px] text-ink-3">{label}…</span>
    </div>
  );
}
