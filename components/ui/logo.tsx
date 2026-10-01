/**
 * AM2PM mark, redrawn as SVG from the brand logo: a teal clock arc, an orange
 * inner arc and a check-mark "hand". Drawn (not an image) so it stays crisp
 * and can be coloured per context.
 */
export function LogoMark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true" className={className}>
      {/* Outer teal arc, open at the top-right like the logo */}
      <path d="M31.5 8.5A16 16 0 1 0 36 20" stroke="#6BD3DC" strokeWidth="4.2" strokeLinecap="round" />
      {/* Inner orange arc on the right */}
      <path d="M28.6 11.4A12 12 0 0 1 24 31.3" stroke="#F56332" strokeWidth="2.4" strokeLinecap="round" />
      {/* Check-mark hand */}
      <path d="M12.5 15.5 19 22.5 33.5 8" stroke="#6BD3DC" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Wordmark({ dark = false }: { dark?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <LogoMark size={26} />
      <span className={`leading-none ${dark ? "text-sheet" : "text-ink"}`}>
        <span className="block text-[15px] font-bold tracking-[0.06em]">AM2PM</span>
        <span className="block text-[8.5px] font-semibold tracking-[0.42em] text-teal-ink opacity-90">SUPPORT</span>
      </span>
    </span>
  );
}
