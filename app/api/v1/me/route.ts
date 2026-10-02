/** GET /api/v1/me — who this request acts as (user, role, workspace, auth method, key scope). API.md §3.10. */
import { json } from "@/lib/http/errors";
import { v1 } from "@/lib/api/v1";

export const GET = v1(async (_req, ctx) =>
  json({ userId: ctx.actor.userId, name: ctx.actor.name, role: ctx.actor.role, workspace: { id: ctx.tenantId, slug: ctx.tenantSlug, name: ctx.tenantName, timezone: ctx.timezone }, via: ctx.via, scope: ctx.scope }),
);
