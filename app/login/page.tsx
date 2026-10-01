/**
 * Sign-in. Left: the brand clock as a large drawn mark with the live IST
 * time. Right: Google and email-OTP sign-in.
 *
 * TODO(T1.11): wire both buttons to Auth.js. Until then sign-in is disabled
 * and the preview opens the screens on fictional sample data.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Mail } from "lucide-react";
import { ShiftClock } from "@/components/shell/topbar";
import { Wordmark } from "@/components/ui/logo";

export const metadata: Metadata = { title: "Sign in" };

function BigClock() {
  // The logo's geometry at poster scale: teal outer arc, orange inner arc, check hand.
  return (
    <svg viewBox="0 0 400 400" className="h-auto w-full max-w-[420px]" aria-hidden="true">
      <circle cx="200" cy="200" r="168" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
      {Array.from({ length: 60 }).map((_, i) => {
        const a = (i / 60) * Math.PI * 2;
        const long = i % 5 === 0;
        const r1 = long ? 184 : 188;
        return (
          <line
            key={i}
            x1={200 + Math.cos(a) * r1}
            y1={200 + Math.sin(a) * r1}
            x2={200 + Math.cos(a) * 194}
            y2={200 + Math.sin(a) * 194}
            stroke="rgba(255,255,255,0.18)"
            strokeWidth={long ? 2 : 1}
          />
        );
      })}
      <path d="M315 85A160 160 0 1 0 360 200" stroke="#6BD3DC" strokeWidth="34" strokeLinecap="round" fill="none" />
      <path d="M286 114A120 120 0 0 1 240 313" stroke="#F56332" strokeWidth="18" strokeLinecap="round" fill="none" />
      <path d="M125 155 190 225 335 80" stroke="#6BD3DC" strokeWidth="32" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

export default function LoginPage() {
  return (
    <main className="grid min-h-dvh grid-cols-1 lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden bg-ink p-10 text-sheet lg:flex">
        <Wordmark dark />
        <div className="flex flex-1 items-center justify-center py-8">
          <BigClock />
        </div>
        <div className="flex items-end justify-between gap-6">
          <p className="max-w-[340px] text-[26px] font-semibold leading-[1.15] tracking-[-0.02em]">
            Every lead, called <span className="text-teal">on time</span>.
          </p>
          <div className="text-right text-[11px] leading-relaxed text-ink-4">
            Multi-client calling CRM
            <br />
            AM2PM Support Pvt. Ltd.
          </div>
        </div>
      </section>

      <section className="flex flex-col justify-between bg-paper p-8 sm:p-12">
        <div className="flex items-center justify-between lg:justify-end">
          <span className="lg:hidden"><Wordmark /></span>
          <ShiftClock />
        </div>

        <div className="mx-auto w-full max-w-[380px]">
          <h1 className="text-[30px] font-semibold leading-tight tracking-[-0.02em]">Sign in to your desk</h1>
          <p className="mt-2 text-[14px] text-ink-3">Use the Google or work email your team admin added.</p>

          <div className="mt-8 flex flex-col gap-3">
            <button disabled className="flex h-12 items-center justify-center gap-3 rounded-md border border-rule-strong bg-sheet text-[14px] font-semibold text-ink-3">
              <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
                <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
                <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
                <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
                <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
              </svg>
              Continue with Google
            </button>

            <div className="flex items-center gap-3 py-1 text-[11px] uppercase tracking-[0.14em] text-ink-4">
              <span className="h-px flex-1 bg-rule" />or<span className="h-px flex-1 bg-rule" />
            </div>

            <label className="flex h-12 items-center gap-2 rounded-md border border-rule bg-sheet px-3 text-ink-3 focus-within:border-ink">
              <Mail size={16} />
              <input disabled type="email" placeholder="you@company.com" className="h-full flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-4" />
            </label>
            <button disabled className="h-12 rounded-md bg-rule-strong text-[14px] font-semibold text-ink-3">Email me a code</button>
          </div>

          <div className="mt-8 rounded-md border border-dashed border-ember/60 bg-ember-wash/50 p-4">
            <p className="text-[12.5px] leading-relaxed text-ember-ink">
              Sign-in switches on with Auth.js (T1.11). Until then, the preview opens every screen on fictional sample data.
            </p>
            <Link href="/console" className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-semibold text-ink hover:underline">
              Open the preview <ArrowRight size={14} />
            </Link>
          </div>
        </div>

        <p className="text-center text-[11px] text-ink-4">Protected by row-level security · data stays in your workspace</p>
      </section>
    </main>
  );
}
