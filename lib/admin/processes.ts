/**
 * Processes (campaigns) and their dispositions — Setup (T1.17, T1.18).
 *
 * Creating a process also creates its default dispositions, ported from
 * crmv7's Config dropdown, each with a category that drives automation
 * (DESIGN.md §2.3). Codes are immutable; labels can change.
 */
import { and, asc, count, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { dispositions, leads, processes, userProcesses, type AssignmentMethod } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { requirePermission } from "@/lib/auth/rbac";
import type { SessionContext } from "@/lib/auth/session";
import { writeAudit } from "@/lib/audit";
import { conflict, notFound } from "@/lib/http/errors";
import { isUniqueViolation } from "@/lib/db/tenant";

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");

export const ProcessInput = z.object({
  name: z.string().trim().min(2).max(80),
  stages: z.array(z.string().trim().min(1).max(30)).min(2).max(12),
  wonStage: z.string().trim().min(1),
  method: z.enum(["equal", "percentage", "ratio", "number", "load", "skill"]),
  workingDays: z.array(z.number().int().min(0).max(6)).max(7),
  start: HHMM,
  end: HHMM,
  slaMinutes: z.number().int().min(1).max(1440),
  recycleHours: z.number().int().min(1).max(720).nullable(),
  dedupeField: z.string().trim().min(1).max(40),
  reEnquiryDays: z.number().int().min(1).max(365).nullable(),
  status: z.enum(["active", "paused", "closed"]).default("active"),
});
export type ProcessInput = z.infer<typeof ProcessInput>;

/** crmv7 defaults, with categories. */
export const DEFAULT_DISPOSITIONS = [
  { code: "INTERESTED", label: "Interested", category: "positive" as const },
  { code: "CALL_BACK", label: "Call back", category: "callback" as const },
  { code: "NO_ANSWER", label: "No answer", category: "neutral" as const },
  { code: "BUSY", label: "Busy", category: "neutral" as const },
  { code: "NOT_INTERESTED", label: "Not interested", category: "negative" as const },
  { code: "WRONG_NUMBER", label: "Wrong number", category: "negative" as const },
  { code: "CONVERTED", label: "Converted", category: "converted" as const },
  { code: "DNC", label: "Do not call", category: "dnc" as const },
];

function toRow(input: ProcessInput) {
  if (!input.stages.includes(input.wonStage)) throw conflict("The won stage must be one of the stages", "bad_won_stage");
  if (input.start >= input.end) throw conflict("Working hours must end after they start", "bad_hours");
  return {
    name: input.name,
    stages: input.stages,
    wonStage: input.wonStage,
    assignment: {
      method: input.method as AssignmentMethod,
      sticky: false,
      slaMinutes: input.slaMinutes,
      recycleHours: input.recycleHours ?? undefined,
      workingHours: input.workingDays.length ? { days: input.workingDays, start: input.start, end: input.end } : undefined,
    },
    dedupeField: input.dedupeField,
    reEnquiryDays: input.reEnquiryDays,
    status: input.status,
  };
}

export async function listProcesses(ctx: SessionContext) {
  requirePermission(ctx, "config", "V");
  return withTenant(ctx, async (tx) => {
    const rows = await tx.select().from(processes).orderBy(asc(processes.name));
    const agents = await tx.select({ processId: userProcesses.processId, n: count() }).from(userProcesses).groupBy(userProcesses.processId);
    const open = await tx
      .select({ processId: leads.processId, n: count() })
      .from(leads)
      .where(and(eq(leads.status, "open"), eq(leads.isActive, true)))
      .groupBy(leads.processId);
    return rows.map((p) => ({
      ...p,
      agents: agents.find((a) => a.processId === p.id)?.n ?? 0,
      open: open.find((o) => o.processId === p.id)?.n ?? 0,
    }));
  });
}

export async function createProcess(ctx: SessionContext, input: ProcessInput) {
  requirePermission(ctx, "config", "C");
  const row = toRow(input);
  try {
    return await withTenant(ctx, async (tx) => {
      const [p] = await tx.insert(processes).values(row).returning();
      await tx.insert(dispositions).values(DEFAULT_DISPOSITIONS.map((d, i) => ({ ...d, processId: p!.id, sortOrder: i })));
      await writeAudit(tx, ctx, { action: "process.created", entity: "process", entityId: p!.id, after: { name: p!.name } });
      return p!;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("A process with this name already exists");
    throw err;
  }
}

export async function updateProcess(ctx: SessionContext, id: string, input: ProcessInput) {
  requirePermission(ctx, "config", "E");
  const row = toRow(input);
  return withTenant(ctx, async (tx) => {
    const [before] = await tx.select().from(processes).where(eq(processes.id, id));
    if (!before) throw notFound("Process not found");
    const [p] = await tx.update(processes).set(row).where(eq(processes.id, id)).returning();
    await writeAudit(tx, ctx, { action: "process.updated", entity: "process", entityId: id, before: { name: before.name, assignment: before.assignment }, after: { name: p!.name, assignment: p!.assignment } });
    return p!;
  });
}

// ------------------------------------------------------------------ dispositions

export const DispositionInput = z.object({
  processId: z.uuid().nullable(),
  label: z.string().trim().min(1).max(40),
  category: z.enum(["positive", "negative", "neutral", "callback", "dnc", "converted"]),
});

export async function listDispositions(ctx: SessionContext, processId: string | null) {
  requirePermission(ctx, "config", "V");
  return withTenant(ctx, (tx) =>
    tx
      .select()
      .from(dispositions)
      .where(processId ? or(eq(dispositions.processId, processId), isNull(dispositions.processId)) : isNull(dispositions.processId))
      .orderBy(asc(dispositions.sortOrder), asc(dispositions.label)),
  );
}

export async function createDisposition(ctx: SessionContext, input: z.infer<typeof DispositionInput>) {
  requirePermission(ctx, "config", "C");
  const code = input.label.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
  try {
    return await withTenant(ctx, async (tx) => {
      const [{ n }] = (await tx.select({ n: sql<number>`coalesce(max(${dispositions.sortOrder}), 0) + 1` }).from(dispositions)) as [{ n: number }];
      const [d] = await tx.insert(dispositions).values({ code, label: input.label, category: input.category, processId: input.processId, sortOrder: n }).returning();
      await writeAudit(tx, ctx, { action: "disposition.created", entity: "disposition", entityId: d!.id, after: { code, label: input.label } });
      return d!;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("That outcome already exists for this process");
    throw err;
  }
}

export async function setDispositionActive(ctx: SessionContext, id: string, isActive: boolean) {
  requirePermission(ctx, "config", "E");
  return withTenant(ctx, async (tx) => {
    const [d] = await tx.update(dispositions).set({ isActive }).where(eq(dispositions.id, id)).returning();
    if (!d) throw notFound();
    await writeAudit(tx, ctx, { action: isActive ? "disposition.enabled" : "disposition.disabled", entity: "disposition", entityId: id });
    return d;
  });
}
