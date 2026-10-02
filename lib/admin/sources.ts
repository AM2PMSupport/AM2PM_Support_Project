/**
 * Lead sources — Setup (T1.23). Each source gets a webhook URL and a secret
 * key shown ONCE; only its SHA-256 is stored (RULE.md §5.2).
 */
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { importSources, processes } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { publicBaseUrl } from "@/lib/config/env";
import { randomToken, sha256Hex } from "@/lib/crypto";
import { requirePermission } from "@/lib/auth/rbac";
import type { SessionContext } from "@/lib/auth/session";
import { writeAudit } from "@/lib/audit";
import { notFound } from "@/lib/http/errors";

export const SourceInput = z.object({
  kind: z.enum(["web_form", "meta_ads", "google_ads", "indiamart", "justdial", "csv", "sheet", "api"]),
  processId: z.uuid(),
  /** "source_field=crm_field" lines, e.g. "full_name=name". */
  fieldMap: z.record(z.string(), z.string()).default({}),
  /** For "sheet" sources: a published-to-web CSV URL (T1.27). */
  sheetUrl: z.url().optional(),
});

export function webhookUrl(tenantSlug: string, sourceId: string): string {
  return `${publicBaseUrl()}/api/hooks/${tenantSlug}/${sourceId}`;
}

export async function listSources(ctx: SessionContext) {
  requirePermission(ctx, "import_sources", "V");
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ source: importSources, processName: processes.name })
      .from(importSources)
      .innerJoin(processes, eq(processes.id, importSources.processId))
      .orderBy(asc(processes.name));
    return rows.map((r) => ({ ...r.source, secretHash: undefined, processName: r.processName, url: webhookUrl(ctx.tenantSlug, r.source.id) }));
  });
}

export async function createSource(ctx: SessionContext, input: z.infer<typeof SourceInput>): Promise<{ id: string; key: string; url: string }> {
  requirePermission(ctx, "import_sources", "C");
  const key = randomToken(24);
  const id = await withTenant(ctx, async (tx) => {
    const [s] = await tx
      .insert(importSources)
      .values({ kind: input.kind, processId: input.processId, fieldMap: { ...input.fieldMap, ...(input.sheetUrl ? { __sheet_url: input.sheetUrl } : {}) }, secretHash: sha256Hex(key) })
      .returning({ id: importSources.id });
    await writeAudit(tx, ctx, { action: "source.created", entity: "import_source", entityId: s!.id, after: { kind: input.kind } });
    return s!.id;
  });
  return { id, key, url: webhookUrl(ctx.tenantSlug, id) };
}

export async function rotateSourceKey(ctx: SessionContext, id: string): Promise<{ key: string }> {
  requirePermission(ctx, "import_sources", "E");
  const key = randomToken(24);
  await withTenant(ctx, async (tx) => {
    const [s] = await tx.update(importSources).set({ secretHash: sha256Hex(key) }).where(eq(importSources.id, id)).returning({ id: importSources.id });
    if (!s) throw notFound();
    await writeAudit(tx, ctx, { action: "source.key_rotated", entity: "import_source", entityId: id });
  });
  return { key };
}

export async function setSourceStatus(ctx: SessionContext, id: string, status: "active" | "paused") {
  requirePermission(ctx, "import_sources", "E");
  return withTenant(ctx, async (tx) => {
    await tx.update(importSources).set({ status }).where(eq(importSources.id, id));
    await writeAudit(tx, ctx, { action: `source.${status}`, entity: "import_source", entityId: id });
  });
}
