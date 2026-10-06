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

/** Field types (Setup → Lead layout palette). Advanced types (lookup, formula, upload…) come later. */
export const FIELD_TYPES = ["text", "textarea", "number", "decimal", "currency", "percent", "dropdown", "radio", "multiselect", "date", "datetime", "boolean", "phone", "email", "url", "user"] as const;
const WITH_OPTIONS = new Set(["dropdown", "radio", "multiselect"]);

export const FieldInput = z.object({
  entity: z.enum(["lead", "contact"]).default("lead"),
  processId: z.uuid().nullable(),
  label: z.string().trim().min(1).max(40),
  type: z.enum(FIELD_TYPES),
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
  if (WITH_OPTIONS.has(input.type) && input.options.length < 2) {
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

/** Edit a custom field: label, options (pick lists), required. The key and type never change (values depend on them). */
export const FieldEdit = z.object({
  label: z.string().trim().min(1).max(40),
  options: z.array(z.string().trim().min(1).max(40)).max(50).default([]),
  required: z.boolean().default(false),
});

export async function updateField(ctx: SessionContext, id: string, raw: z.input<typeof FieldEdit>) {
  requirePermission(ctx, "config", "E");
  const input = FieldEdit.parse(raw);
  return withTenant(ctx, async (tx) => {
    const [before] = await tx.select().from(customFieldDefinitions).where(eq(customFieldDefinitions.id, id));
    if (!before) throw notFound();
    if (WITH_OPTIONS.has(before.type) && input.options.length < 2) throw conflict("Pick lists need at least two options", "need_options");
    const [f] = await tx
      .update(customFieldDefinitions)
      .set({ label: input.label, options: WITH_OPTIONS.has(before.type) ? input.options : [], required: input.required })
      .where(eq(customFieldDefinitions.id, id))
      .returning();
    await writeAudit(tx, ctx, { action: "custom_field.updated", entity: "custom_field", entityId: id, before: { label: before.label, options: before.options, required: before.required }, after: { label: f!.label, options: f!.options, required: f!.required } });
    return f!;
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
      case "number":
      case "decimal":
      case "currency":
      case "percent": {
        const n = Number(String(v).replace(/[,₹%\s]/g, ""));
        if (Number.isFinite(n)) value[d.key] = n;
        else errors.push(`${d.label} must be a number`);
        break;
      }
      case "boolean":
        value[d.key] = /^(true|yes|y|1)$/i.test(String(v));
        break;
      case "dropdown":
      case "radio":
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
      case "datetime": {
        const t = Date.parse(String(v));
        if (Number.isNaN(t)) errors.push(`${d.label} must be a date and time`);
        else value[d.key] = new Date(t).toISOString();
        break;
      }
      case "url": {
        const u = /^https?:\/\//i.test(String(v).trim()) ? String(v).trim() : `https://${String(v).trim()}`;
        try {
          new URL(u);
          value[d.key] = u.slice(0, 500);
        } catch {
          errors.push(`${d.label} must be a web address`);
        }
        break;
      }
      case "user":
        // A person in this workspace (their user id); the screens show the name.
        if (!/^[0-9a-f-]{36}$/i.test(String(v))) errors.push(`${d.label} must be a person`);
        break;
      case "textarea":
        value[d.key] = String(v).slice(0, 5000);
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
