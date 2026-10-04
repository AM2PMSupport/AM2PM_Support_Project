/**
 * Sign-in. Left: the brand clock as a working watch (live IST, hour/minute/
 * second hands — components/shell/brand-watch.tsx). Right: sign-in form.
 *
 * Email + password sign-in (POST /api/auth/login → HttpOnly session cookie).
 * Already signed in → straight to the console.
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/shell/login-form";
import { ShiftClock } from "@/components/shell/topbar";
import { getSession } from "@/lib/auth/session";
import { homeFor } from "@/lib/auth/rbac";
import { Wordmark } from "@/components/ui/logo";
import { BrandWatch } from "@/components/shell/brand-watch";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  const session = await getSession();
  if (session) redirect(homeFor(session.actor));
  return (
    <main className="grid min-h-dvh grid-cols-1 lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden bg-ink p-10 text-sheet lg:flex">
        <Wordmark dark />
        <div className="flex flex-1 items-center justify-center py-8">
          <BrandWatch />
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
          <p className="mt-2 text-[14px] text-ink-3">Use the work email and password your admin gave you.</p>

          <div className="mt-8">
            <LoginForm />
          </div>
          <p className="mt-6 text-[12px] leading-relaxed text-ink-3">
            Forgot your password? Ask your workspace admin to reset it. Google sign-in is coming later.
          </p>
        </div>

        <p className="text-center text-[11px] text-ink-4">Protected by row-level security · data stays in your workspace</p>
      </section>
    </main>
  );
}
