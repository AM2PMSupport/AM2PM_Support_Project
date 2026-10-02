/** GET /api/v1/users — team members (id, name, role, status, availability, process ids). No phones/emails over the API (§3.15). */
import { json } from "@/lib/http/errors";
import { v1 } from "@/lib/api/v1";
import { listUsers } from "@/lib/admin/users";

export const GET = v1(async (_req, ctx) => {
  const users = await listUsers(ctx);
  return json({ items: users.map((u) => ({ id: u.id, name: u.name, role: u.role, status: u.status, isAvailable: u.isAvailable, processIds: u.processIds })) });
});
