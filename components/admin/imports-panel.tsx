"use client";

/**
 * CSV / Excel import (T1.26). The file goes straight from the browser to the
 * private Blob store, then a background job imports it 500 rows at a time
 * (dedupe + auto-assign). The batch list polls while anything is running and
 * shows inserted / duplicate / failed, with the failed rows as a CSV.
 */
import { upload } from "@vercel/blob/client";
import { useEffect, useRef, useState, useTransition } from "react";
import { Download, FileUp } from "lucide-react";
import { importsAction, startImportAction } from "@/app/(app)/admin/actions";
import { ErrorNote, Field, Select } from "@/components/ui/form";
import { Tag } from "@/components/ui/primitives";

export interface ImportRow {
  id: string;
  fileName: string | null;
  processName: string;
  status: "queued" | "running" | "done" | "failed";
  total: number;
  inserted: number;
  merged: number;
  failed: number;
  errors: { row: number; reason: string }[];
  by: string | null;
  createdAt: string;
}

function errorCsv(b: ImportRow) {
  const lines = ["row,reason", ...b.errors.map((e) => `${e.row},"${e.reason.replace(/"/g, '""')}"`)];
  return `data:text/csv;charset=utf-8,${encodeURIComponent(lines.join("\n"))}`;
}

export function ImportsPanel({ initial, processes, tenantId, timeZone, canEdit }: { initial: ImportRow[]; processes: { id: string; name: string }[]; tenantId: string; timeZone: string; canEdit: boolean }) {
  const [rows, setRows] = useState(initial);
  const [processId, setProcessId] = useState(processes[0]?.id ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<"idle" | "uploading" | "starting">("idle");
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const active = rows.some((r) => r.status === "queued" || r.status === "running");

  // Poll while a batch is in flight.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(async () => {
      const res = await importsAction();
      if (res.ok && res.data) setRows(res.data as ImportRow[]);
    }, 3000);
    return () => clearInterval(t);
  }, [active]);

  async function submit() {
    if (!file || !processId) return;
    setError(null);
    try {
      setStage("uploading");
      const blob = await upload(`imports/${tenantId}/${file.name.replace(/[^\w.\-]+/g, "_")}`, file, {
        access: "private",
        handleUploadUrl: "/api/imports/upload",
      });
      setStage("starting");
      const res = await startImportAction({ processId, pathname: blob.pathname, fileName: file.name });
      if (!res.ok) throw new Error(res.error);
      setFile(null);
      if (input.current) input.current.value = "";
      startTransition(async () => {
        const list = await importsAction();
        if (list.ok && list.data) setRows(list.data as ImportRow[]);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed. Try again.");
    } finally {
      setStage("idle");
    }
  }

  return (
    <section id="import" className="panel scroll-mt-20 p-5">
      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="eyebrow">Bulk</div>
          <h3 className="mt-1 text-[15px] font-semibold">Import a CSV or Excel file</h3>
          <p className="mt-1 max-w-[560px] text-[12.5px] text-ink-3">
            First row = column names. We pick up name, phone (“Mobile No”, “Phone Number”…) and email automatically; every other column is kept on the lead. Duplicates merge into the existing lead; new leads are assigned straight away. Up to 50,000 rows, 20 MB.
          </p>
        </div>
      </div>

      {canEdit && (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <Field label="Into process" className="w-60">
            <Select value={processId} onChange={(e) => setProcessId(e.target.value)}>
              {processes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <label className="flex h-9 min-w-64 cursor-pointer items-center gap-2 rounded-md border border-dashed border-rule-strong bg-paper px-3 text-[12.5px] text-ink-2 hover:border-ink-3">
            <FileUp size={15} className="text-ink-3" />
            <span className="truncate">{file ? file.name : "Choose .csv or .xlsx"}</span>
            <input ref={input} type="file" accept=".csv,.xlsx" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <button
            onClick={submit}
            disabled={!file || !processId || stage !== "idle"}
            className="h-9 rounded-md bg-ink px-4 text-[12.5px] font-semibold text-sheet hover:bg-ink-2 disabled:bg-ink-4"
          >
            {stage === "uploading" ? "Uploading…" : stage === "starting" ? "Starting…" : "Import"}
          </button>
        </div>
      )}
      <div className="mt-2"><ErrorNote message={error} /></div>

      <table className="mt-4 w-full text-[12.5px]">
        <thead>
          <tr className="border-y border-rule text-left text-ink-3">
            <th className="py-2 pr-3 font-medium">File</th>
            <th className="px-3 py-2 font-medium">Process</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 text-right font-medium">New</th>
            <th className="px-3 py-2 text-right font-medium">Duplicates</th>
            <th className="px-3 py-2 text-right font-medium">Failed</th>
            <th className="py-2 pl-3 text-right font-medium">When</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => {
            const doneRows = b.inserted + b.merged + b.failed;
            return (
              <tr key={b.id} className="border-b border-rule last:border-b-0">
                <td className="max-w-[220px] truncate py-2.5 pr-3 font-medium">{b.fileName}</td>
                <td className="px-3 py-2.5 text-ink-2">{b.processName}</td>
                <td className="px-3 py-2.5">
                  {b.status === "done" ? (
                    <Tag tone="moss">Done</Tag>
                  ) : b.status === "failed" ? (
                    <span title={b.errors[0]?.reason}><Tag tone="ember">Failed</Tag></span>
                  ) : (
                    <span className="font-mono text-[12px] text-ink-2 tnum">{b.total ? `${doneRows.toLocaleString("en-IN")} / ${b.total.toLocaleString("en-IN")}` : "Queued…"}</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right font-mono font-semibold tnum">{b.inserted}</td>
                <td className="px-3 py-2.5 text-right font-mono tnum text-ink-2">{b.merged}</td>
                <td className="px-3 py-2.5 text-right font-mono tnum">
                  {b.failed ? (
                    <a href={errorCsv(b)} download={`${(b.fileName ?? "import").replace(/\.\w+$/, "")}-errors.csv`} className="inline-flex items-center gap-1 text-ember-ink hover:underline">
                      {b.failed} <Download size={12} />
                    </a>
                  ) : (
                    <span className="text-ink-4">0</span>
                  )}
                </td>
                <td className="py-2.5 pl-3 text-right text-ink-3">{new Date(b.createdAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone })}</td>
              </tr>
            );
          })}
          {rows.length === 0 && <tr><td colSpan={7} className="py-6 text-center text-[12.5px] text-ink-3">No imports yet.</td></tr>}
        </tbody>
      </table>
      {rows.some((b) => b.failed > b.errors.length) && <p className="mt-2 text-[11.5px] text-ink-4">The error file lists the first 200 failed rows.</p>}
    </section>
  );
}
