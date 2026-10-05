"use server";

/**
 * Server actions for Setup. Each one: signed-in session → Zod validation →
 * lib/admin function (which checks permission, runs under RLS and writes the
 * audit log) → revalidate. Errors come back as plain, user-safe messages.
 * Secrets (new passwords, source keys, webhook URLs) are returned ONCE.
 */
import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import { getSession, type SessionContext } from "@/lib/auth/session";
import { limitPerson } from "@/lib/http/rate-limit";
import { ApiError } from "@/lib/http/errors";
import { log } from "@/lib/log";
import { ProcessInput, createProcess, updateProcess, DispositionInput, createDisposition, setDispositionActive } from "@/lib/admin/processes";
import { UserInput, createUser, updateUser, resetUserPassword } from "@/lib/admin/users";
import { FieldInput, createField, setFieldActive } from "@/lib/admin/custom-fields";
import { SourceInput, createSource, rotateSourceKey, setSourceStatus } from "@/lib/admin/sources";
import { WorkspaceInput, createWorkspace, setWorkspaceStatus } from "@/lib/platform-admin/workspaces";
import { StartImportInput, startImport, listImports } from "@/lib/imports/run";
import { CompanyInput, updateCompany } from "@/lib/admin/company";
import { createApiKey, revokeApiKey } from "@/lib/admin/api-keys";
import { removeSampleData } from "@/lib/admin/sample-data";
import { setRolePermissions } from "@/lib/admin/roles";
import { cookies } from "next/headers";
import { membershipsOf } from "@/lib/platform-admin/auth";
import { sessionCookieOptions, sessionToken } from "@/lib/auth/cookie";
import { CredentialsInput, DidInput, saveCallerDesk, rotateWebhookSecret, addDid, removeDid, testAgentPhone } from "@/lib/admin/telephony";

export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

async function run<T>(fn: (ctx: SessionContext) => Promise<T>): Promise<ActionResult<T>> {
  const ctx = await getSession();
  if (!ctx) return { ok: false, error: "Your session has ended. Sign in again." };
  try {
    await limitPerson(ctx);
    const data = await fn(ctx);
    revalidatePath("/admin");
    return { ok: true, data };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    if (err instanceof ZodError) {
      const i = err.issues[0];
      return { ok: false, error: `${i?.path.join(".") || "Input"}: ${i?.message ?? "invalid"}` };
    }
    log.error("setup action failed", { err });
    return { ok: false, error: "Something went wrong. Try again." };
  }
}

const Id = z.uuid();

// Processes & outcomes
export const createProcessAction = async (input: unknown) => run((ctx) => createProcess(ctx, ProcessInput.parse(input)).then(() => undefined));
export const updateProcessAction = async (id: unknown, input: unknown) => run((ctx) => updateProcess(ctx, Id.parse(id), ProcessInput.parse(input)).then(() => undefined));
export const createDispositionAction = async (input: unknown) => run((ctx) => createDisposition(ctx, DispositionInput.parse(input)).then(() => undefined));
export const toggleDispositionAction = async (id: unknown, active: unknown) => run((ctx) => setDispositionActive(ctx, Id.parse(id), z.boolean().parse(active)).then(() => undefined));

// Roles & permissions (Super Admin only; enforced in lib/admin/roles.ts)
// Setup → Roles Save: every changed cell at once (validated in lib/admin/roles.ts).
export const saveRolePermissionsAction = async (cells: unknown) => run((ctx) => setRolePermissions(ctx, cells).then(() => undefined));

// Team
export const createUserAction = async (input: unknown) => run((ctx) => createUser(ctx, UserInput.parse(input)));
export const updateUserAction = async (id: unknown, input: unknown) => run((ctx) => updateUser(ctx, Id.parse(id), UserInput.parse(input)));
export const resetPasswordAction = async (id: unknown) => run((ctx) => resetUserPassword(ctx, Id.parse(id)));
export const testPhoneAction = async (id: unknown) => run((ctx) => testAgentPhone(ctx, Id.parse(id)));

// Custom fields
export const createFieldAction = async (input: unknown) => run((ctx) => createField(ctx, FieldInput.parse(input)).then(() => undefined));
export const toggleFieldAction = async (id: unknown, active: unknown) => run((ctx) => setFieldActive(ctx, Id.parse(id), z.boolean().parse(active)).then(() => undefined));

// Lead sources
export const createSourceAction = async (input: unknown) => run((ctx) => createSource(ctx, SourceInput.parse(input)));
export const rotateSourceKeyAction = async (id: unknown) => run((ctx) => rotateSourceKey(ctx, Id.parse(id)));
export const setSourceStatusAction = async (id: unknown, status: unknown) =>
  run((ctx) => setSourceStatus(ctx, Id.parse(id), z.enum(["active", "paused"]).parse(status)).then(() => undefined));

// Telephony
export const saveCallerDeskAction = async (input: unknown) => run((ctx) => saveCallerDesk(ctx, CredentialsInput.parse(input)));
export const rotateWebhookAction = async () => run((ctx) => rotateWebhookSecret(ctx));
export const addDidAction = async (input: unknown) => run((ctx) => addDid(ctx, DidInput.parse(input)).then(() => undefined));
export const removeDidAction = async (id: unknown) => run((ctx) => removeDid(ctx, Id.parse(id)).then(() => undefined));

// Workspaces (Super Admin)
export const createWorkspaceAction = async (input: unknown) => run((ctx) => createWorkspace(ctx, WorkspaceInput.parse(input)).then(() => undefined));
export const setWorkspaceStatusAction = async (id: unknown, status: unknown) =>
  run((ctx) => setWorkspaceStatus(ctx, Id.parse(id), z.enum(["active", "trial", "suspended", "closed"]).parse(status)).then(() => undefined));

// ── Imports (T1.26) ──────────────────────────────────────────────────────────
export async function startImportAction(input: z.input<typeof StartImportInput>) {
  return run((ctx) => startImport(ctx, StartImportInput.parse(input)));
}

export async function importsAction() {
  return run(async (ctx) =>
    (await listImports(ctx)).map((b) => ({ ...b, createdAt: b.createdAt.toISOString() })),
  );
}

// ── Company settings ─────────────────────────────────────────────────────────
export async function updateCompanyAction(input: z.input<typeof CompanyInput>) {
  return run(async (ctx) => {
    await updateCompany(ctx, CompanyInput.parse(input));
    // Name and timezone live in the session cookie: re-issue it so they apply now.
    const m = (await membershipsOf(ctx.accountId)).find((x) => x.tenantId === ctx.tenantId);
    if (m) (await cookies()).set({ ...sessionCookieOptions, value: sessionToken(ctx.accountId, m) });
    revalidatePath("/", "layout");
  });
}

// ── Remove sample data ───────────────────────────────────────────────────────
export async function removeSampleDataAction(confirm: string) {
  return run(async (ctx) => {
    if (confirm !== "REMOVE") throw new ApiError(400, "confirm", "Type REMOVE to confirm");
    return removeSampleData(ctx);
  });
}

// ── API keys (REST + GraphQL) ────────────────────────────────────────────────
export async function createApiKeyAction(input: { name: string; scope: "read" | "write" }) {
  return run((ctx) => createApiKey(ctx, input));
}
export async function revokeApiKeyAction(id: string) {
  return run((ctx) => revokeApiKey(ctx, z.uuid().parse(id)));
}
