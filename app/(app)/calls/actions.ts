"use server";

/** Calls screen: "Sync now" pulls today's provider call report (lib/telephony/sync.ts). */
import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { syncCalls } from "@/lib/telephony/sync";
import { log } from "@/lib/log";

export async function syncCallsAction(): Promise<{ ok: true; rows: number; failed: number } | { ok: false; error: string }> {
  const ctx = await getSession();
  if (!ctx) return { ok: false, error: "Your session has ended. Sign in again." };
  if (!can(ctx.actor.role, "config", "V")) return { ok: false, error: "Only supervisors and admins can sync calls" };
  try {
    const r = await syncCalls(ctx);
    if (!r) return { ok: false, error: "Telephony isn't connected for this workspace" };
    revalidatePath("/calls");
    return { ok: true, rows: r.rows, failed: r.failed };
  } catch (err) {
    log.error("manual call sync failed", { tenant: ctx.tenantSlug, err });
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : "Sync failed" };
  }
}
