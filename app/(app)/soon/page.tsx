/**
 * Coming soon — a showcase of every planned module (lib/ui/coming-soon.ts),
 * each with a preview on fictional sample data. Open to every role unless switched off in Setup → Roles → Module access:
 * it shows what is on the way, nothing here touches real data.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { requirePage } from "@/lib/auth/guard";
import { Topbar } from "@/components/shell/topbar";
import { SOON_MODULES } from "@/lib/ui/coming-soon";
import { ComingSoonBadge, SoonIcon } from "@/components/soon/soon-icon";

export const metadata: Metadata = { title: "Coming soon" };

export default async function ComingSoonPage() {
  await requirePage("soon");
  return (
    <div className="flex min-h-dvh flex-col">
      <Topbar title="Coming soon" subtitle="Modules on the way · previews use sample data" />
      <div className="flex flex-col gap-5 px-6 py-6">
        <p className="max-w-[760px] text-[13px] leading-relaxed text-ink-3">
          What we’re building next. Open any module to see how it will look and what it will do. Previews use fictional sample data and nothing on these pages can be changed yet.
        </p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {SOON_MODULES.map((m) => (
            <Link key={m.slug} href={`/soon/${m.slug}`} className="panel group flex flex-col gap-3 p-5 transition hover:border-ink-3">
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-md bg-teal/15 text-teal-ink"><SoonIcon kind={m.icon} size={20} /></span>
                <ComingSoonBadge />
              </div>
              <div>
                <h2 className="text-[15px] font-semibold">{m.title}</h2>
                <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">{m.tagline}</p>
              </div>
              <div className="mt-auto flex items-center justify-between pt-1 text-[11.5px] text-ink-4">
                <span>{m.plan}</span>
                <span className="inline-flex items-center gap-1 font-medium text-teal-ink group-hover:underline">Preview <ArrowRight size={12} /></span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
