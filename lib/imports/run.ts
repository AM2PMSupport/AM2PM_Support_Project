/**
 * CSV / Excel import (T1.26, PRD FR-8).
 *
 *   browser ──(private Blob client upload, imports/<tenantId>/…)──► Blob
 *   startImport()  → import_batches row (queued) → QStash "import-batch" offset 0
 *   runImportChunk → read file → rows[offset, offset+500) → normalise →
 *                    createOrMergeLead (dedupe) → assign inline → counters
 *                    → next chunk queued, or done + file deleted
 *
 * One QStash message per 500 rows (not per lead) keeps imports inside the
 * free 1,000 messages/day. A redelivered chunk is skipped when the batch's
 * counters already cover it. Only the first 200 row errors are kept; they
 * are the downloadable error file.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { importBatches, processes, users } from "@/lib/db/schema";
import { withTenant, withTenantRead } from "@/lib/db/tenant";
import { requirePermission } from "@/lib/auth/rbac";
import type { SessionContext } from "@/lib/auth/session";
import type { TenantContext } from "@/lib/tenancy/context";
import { writeAudit } from "@/lib/audit";
import { badRequest, notFound } from "@/lib/http/errors";
import { enqueue } from "@/lib/queue/qstash";
import { normaliseLead } from "@/lib/leads/normalise";
import { createOrMergeLead } from "@/lib/leads/create";
import { assignLead } from "@/lib/assignment/assign";
import { parseSpreadsheet } from "@/lib/imports/parse";
import { deletePrivateBlob, readPrivateBlob, tenantPrefix } from "@/lib/storage/blob";
import { log } from "@/lib/log";

export const CHUNK = 500;
const MAX_ERRORS = 200;

export const StartImportInput = z.object({
  processId: z.uuid(),
  pathname: z.string().min(1).max(500),
  fileName: z.string().min(1).max(200),
});

export async function startImport(ctx: SessionContext, input: z.infer<typeof StartImportInput>): Promise<{ batchId: string }> {
  requirePermission(ctx, "import_sources", "C");
  if (!input.pathname.startsWith(tenantPrefix(ctx.tenantId, "imports"))) throw badRequest("File is not in this workspace's upload area");
  if (!/\.(csv|xlsx)$/i.test(input.fileName)) throw badRequest("Upload a .csv or .xlsx file");

  const batchId = await withTenant(ctx, async (tx) => {
    const [p] = await tx.select({ id: processes.id }).from(processes).where(eq(processes.id, input.processId));
    if (!p) throw notFound("Process not found");
    const [b] = await tx
      .insert(importBatches)
      .values({ processId: p.id, fileName: input.fileName, fileKey: input.pathname, createdBy: ctx.actor.userId })
      .returning({ id: importBatches.id });
    await writeAudit(tx, ctx, { action: "import.started", entity: "import_batch", entityId: b!.id, after: { fileName: input.fileName, processId: p.id } });
    return b!.id;
  });
  try {
    await enqueue("import-batch", { tenantId: ctx.tenantId, batchId, offset: 0 }, { deduplicationId: `import:${batchId}:0` });
  } catch (err) {
    await withTenant(ctx, (tx) =>
      tx.update(importBatches).set({ status: "failed", errors: [{ row: 0, reason: "could not start the import — try again" }], updatedAt: new Date() }).where(eq(importBatches.id, batchId)),
    );
    throw err;
  }
  return { batchId };
}

export async function listImports(ctx: SessionContext, limit = 10) {
  requirePermission(ctx, "import_sources", "V");
  return withTenantRead(ctx, (tx) =>
    tx
      .select({
        id: importBatches.id,
        fileName: importBatches.fileName,
        processName: processes.name,
        status: importBatches.status,
        total: importBatches.total,
        inserted: importBatches.inserted,
        merged: importBatches.merged,
        failed: importBatches.failed,
        errors: importBatches.errors,
        by: users.name,
        createdAt: importBatches.createdAt,
      })
      .from(importBatches)
      .innerJoin(processes, eq(processes.id, importBatches.processId))
      .leftJoin(users, eq(users.id, importBatches.createdBy))
      .orderBy(desc(importBatches.createdAt))
      .limit(limit),
  );
}

type Fail = { row: number; reason: string };

/** Process one chunk. Never throws for bad data (that is a row error), only for infrastructure faults (QStash retries). */
export async function runImportChunk(ctx: TenantContext, batchId: string, offset: number): Promise<{ done: boolean }> {
  const [batch] = await withTenant(ctx, (tx) =>
    tx
      .select({ b: importBatches, p: { id: processes.id, stages: processes.stages, dedupeField: processes.dedupeField } })
      .from(importBatches)
      .innerJoin(processes, eq(processes.id, importBatches.processId))
      .where(eq(importBatches.id, batchId)),
  );
  if (!batch || batch.b.status === "done" || batch.b.status === "failed") return { done: true };
  const b = batch.b;
  // Redelivered chunk: the counters already include it.
  if (offset > 0 && b.inserted + b.merged + b.failed > offset) return { done: false };

  let rows: Record<string, string>[];
  try {
    rows = (await parseSpreadsheet(await readPrivateBlob(b.fileKey!), b.fileName ?? "file.csv")).rows;
  } catch (err) {
    const reason = err instanceof Error ? err.message : "could not read the file";
    await withTenant(ctx, (tx) => tx.update(importBatches).set({ status: "failed", errors: [{ row: 0, reason }], updatedAt: new Date() }).where(eq(importBatches.id, batchId)));
    log.warn("import failed to parse", { tenant: ctx.tenantSlug, batchId, reason });
    return { done: true };
  }

  if (offset === 0) {
    await withTenant(ctx, (tx) => tx.update(importBatches).set({ status: "running", total: rows.length, updatedAt: new Date() }).where(eq(importBatches.id, batchId)));
  }

  let inserted = 0;
  let merged = 0;
  const fails: Fail[] = [];
  const slice = rows.slice(offset, offset + CHUNK);
  for (const [i, raw] of slice.entries()) {
    const rowNo = offset + i + 2; // spreadsheet row number (row 1 is the header)
    const n = normaliseLead(raw);
    if (!n.ok) {
      fails.push({ row: rowNo, reason: n.reason });
      continue;
    }
    try {
      const res = await createOrMergeLead(ctx, batch.p, n.lead, { kind: "csv", batchId }, { queueAssign: false });
      if (res.outcome === "created") {
        inserted++;
        await assignLead(ctx, res.leadId).catch((err) => log.warn("import assign deferred to sweeper", { batchId, err }));
      } else merged++;
    } catch (err) {
      log.error("import row failed", { tenant: ctx.tenantSlug, batchId, row: rowNo, err });
      fails.push({ row: rowNo, reason: "could not save (try again)" });
    }
  }

  const next = offset + CHUNK;
  const done = next >= rows.length;
  await withTenant(ctx, (tx) =>
    tx
      .update(importBatches)
      .set({
        inserted: sql`${importBatches.inserted} + ${inserted}`,
        merged: sql`${importBatches.merged} + ${merged}`,
        failed: sql`${importBatches.failed} + ${fails.length}`,
        // Keep the first MAX_ERRORS row errors across chunks.
        errors: sql`(select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(${importBatches.errors} || ${JSON.stringify(fails)}::jsonb) e limit ${MAX_ERRORS}) x)`,
        status: done ? "done" : "running",
        updatedAt: new Date(),
      })
      .where(and(eq(importBatches.id, batchId))),
  );

  if (done) {
    // The data now lives in the leads table; don't keep a second copy of the PII.
    await deletePrivateBlob(b.fileKey!).catch((err) => log.warn("import file delete failed", { batchId, err }));
  } else {
    await enqueue("import-batch", { tenantId: ctx.tenantId, batchId, offset: next }, { deduplicationId: `import:${batchId}:${next}` });
  }
  return { done };
}
