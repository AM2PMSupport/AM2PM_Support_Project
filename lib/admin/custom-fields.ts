/**
 * Custom fields — Setup (T1.19). Definitions here; values live in the
 * `custom` JSONB of leads/contacts and are validated on write by
 * `validateCustom()` (DESIGN.md §2.1). Keys are immutable once created.
 */
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { customFieldDefinitions, type CustomFieldDefinition } from "@/lib/db/schema";
import { isUniqueViolation, withTenant } from "@/lib/db/tenant";
import { requirePermission } from "@/lib/auth/rbac";
import type { SessionContext } from "@/lib/auth/session";
import { writeAudit } from "@/lib/audit";
import { conflict, notFound } from "@/lib/http/errors";

export const FieldInput = z.object({
  entity: z.enum(["lead", "contact"]).default("lead"),
  processId: z.uuid().nullable(),
  label: z.string().trim().min(1).max(40),
  type: z.enum(["text", "number", "dropdown", "multiselect", "date", "boolean", "phone", "email"]),
  options: z.array(z.string().trim().min(1).max(40)).max(50).default([]),
  required: z.boolean().default(false),
});

export function keyFromLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "field";
}

export async function listFields(ctx: SessionContext, processId?: string | null) {
  requirePermission(ctx, "config", "V");
  return withTenant(ctx, (tx) =>
    tx
      .select()
      .from(customFieldDefinitions)
      .where(processId ? or(eq(customFieldDefinitions.processId, processId), isNull(customFieldDefinitions.processId)) : undefined)
      .orderBy(asc(customFieldDefinitions.sortOrder), asc(customFieldDefinitions.label)),
  );
}

export async function createField(ctx: SessionContext, input: z.infer<typeof FieldInput>) {
  requirePermission(ctx, "config", "C");
  if ((input.type === "dropdown" || input.type === "multiselect") && input.options.length < 2) {
    throw conflict("Dropdowns need at least two options", "need_options");
  }
  try {
    return await withTenant(ctx, async (tx) => {
      const [f] = await tx.insert(customFieldDefinitions).values({ ...input, key: keyFromLabel(input.label) }).returning();
      await writeAudit(tx, ctx, { action: "custom_field.created", entity: "custom_field", entityId: f!.id, after: { key: f!.key, type: f!.type } });
      return f!;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("A field with this name already exists here");
    throw err;
  }
}

export async function setFieldActive(ctx: SessionContext, id: string, isActive: boolean) {
  requirePermission(ctx, "config", "E");
  return withTenant(ctx, async (tx) => {
    const [f] = await tx.update(customFieldDefinitions).set({ isActive }).where(and(eq(customFieldDefinitions.id, id))).returning();
    if (!f) throw notFound();
    return f;
  });
}

/**
 * Validate and coerce custom values against definitions. Unknown keys are
 * kept (imports may carry extra columns); known keys must match their type.
 * Returns { value, errors } — callers decide whether errors block the write.
 */
export function validateCustom(defs: CustomFieldDefinition[], input: Record<string, unknown>): { value: Record<string, unknown>; errors: string[] } {
  const value: Record<string, unknown> = { ...input };
  const errors: string[] = [];
  for (const d of defs.filter((x) => x.isActive)) {
    const v = input[d.key];
    const empty = v === undefined || v === null || v === "";
    if (empty) {
      if (d.required) errors.push(`${d.label} is required`);
      continue;
    }
    switch (d.type) {
      case "number": {
        const n = Number(String(v).replace(/[,₹\s]/g, ""));
        if (Number.isFinite(n)) value[d.key] = n;
        else errors.push(`${d.label} must be a number`);
        break;
      }
      case "boolean":
        value[d.key] = /^(true|yes|y|1)$/i.test(String(v));
        break;
      case "dropdown":
        if (!d.options.includes(String(v))) errors.push(`${d.label} must be one of: ${d.options.join(", ")}`);
        break;
      case "multiselect": {
        const arr = Array.isArray(v) ? v.map(String) : String(v).split(",").map((s) => s.trim());
        if (arr.some((x) => !d.options.includes(x))) errors.push(`${d.label} has an unknown option`);
        else value[d.key] = arr;
        break;
      }
      case "date":
        if (Number.isNaN(Date.parse(String(v)))) errors.push(`${d.label} must be a date`);
        break;
      case "email":
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v))) errors.push(`${d.label} must be an email`);
        break;
      default:
        value[d.key] = String(v).slice(0, 500);
    }
  }
  return { value, errors };
}
