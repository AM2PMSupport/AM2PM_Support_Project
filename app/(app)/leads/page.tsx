import type { Metadata } from "next";
import { Download, Upload } from "lucide-react";
import { LeadsTable } from "@/components/leads/leads-table";
import { Topbar } from "@/components/shell/topbar";

export const metadata: Metadata = { title: "Leads" };

export default function LeadsPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <Topbar title="Leads" subtitle="All processes · newest first" />
      <div className="flex flex-col gap-4 px-6 py-6">
        <div className="flex items-center justify-end gap-2">
          <button className="inline-flex h-9 items-center gap-2 rounded-md border border-rule bg-sheet px-3 text-[13px] font-medium text-ink-2 hover:border-ink-3">
            <Upload size={15} /> Import CSV
          </button>
          <button className="inline-flex h-9 items-center gap-2 rounded-md border border-rule bg-sheet px-3 text-[13px] font-medium text-ink-2 hover:border-ink-3">
            <Download size={15} /> Export
          </button>
        </div>
        <LeadsTable />
      </div>
    </div>
  );
}
