/**
 * 404 for everything: URLs that don't exist AND pages/modules the person may
 * not open (lib/auth/guard.ts requirePage, Setup tabs). Same page, same
 * status, so a URL can't be used to probe which modules exist or are hidden
 * (SECURITY.md §3.3). Shows the AM2PM clock, dizzy and lost, as the "0".
 */
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Page not found" };

function LostClock() {
  return (
    <svg viewBox="0 0 120 120" className="h-[120px] w-[120px] sm:h-[150px] sm:w-[150px]" aria-hidden="true">
      <g className="lost-clock">
        {/* The logo's teal clock arc and orange inner arc, as the face */}
        <path d="M94.5 25.5A48 48 0 1 0 108 60" stroke="#6BD3DC" strokeWidth="11" strokeLinecap="round" fill="none" />
        <path d="M85.8 34.2A36 36 0 0 1 72 93.9" stroke="#F56332" strokeWidth="6.5" strokeLinecap="round" fill="none" />
        {/* Dizzy eyes */}
        <path d="M40 46l10 10M50 46 40 56M66 46l10 10M76 46 66 56" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
        {/* Wobbly mouth */}
        <path d="M44 78q5-6 10 0t10 0 10 0" stroke="currentColor" strokeWidth="4" strokeLinecap="round" fill="none" />
        {/* The check-mark hand, lost and spinning */}
        <g className="lost-hand">
          <path d="M60 60 60 34" stroke="#6BD3DC" strokeWidth="5" strokeLinecap="round" />
          <circle cx="60" cy="60" r="4.5" fill="#6BD3DC" />
        </g>
        {/* Sweat drop */}
        <path className="lost-drop" d="M100 38c3 5 4 7 4 9a4 4 0 0 1-8 0c0-2 1-4 4-9z" fill="#6BD3DC" opacity="0.8" />
      </g>
    </svg>
  );
}

export default function NotFound() {
  return (
    <main className="dotgrid flex min-h-dvh flex-col items-center justify-center bg-paper px-4 py-12 text-center text-ink">
      <div className="flex items-center gap-1 font-mono text-[96px] leading-none font-bold tracking-tight sm:text-[128px]" aria-label="404">
        <span aria-hidden="true">4</span>
        <LostClock />
        <span aria-hidden="true">4</span>
      </div>
      <h1 className="mt-6 text-[22px] font-bold">This page clocked out.</h1>
      <p className="mt-2 max-w-[420px] text-[14px] leading-relaxed text-ink-3">
        We looked from AM to PM and still couldn’t find it. It doesn’t exist, or it isn’t part of your access in this workspace.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        {/* "/" → sign-in → the person's own home (homeFor). */}
        <Link href="/" className="inline-flex h-10 items-center rounded-md bg-ink px-4 text-[13px] font-semibold text-sheet hover:bg-ink-2">
          Take me home
        </Link>
      </div>
      <p className="mt-8 font-mono text-[11px] tracking-[0.2em] text-ink-4">AM2PM · ERROR 404</p>
    </main>
  );
}
