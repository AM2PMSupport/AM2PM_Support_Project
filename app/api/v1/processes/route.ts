/** GET /api/v1/processes — processes with stages and active outcomes (ids needed for create / outcome) (§3.15). */
import { json } from "@/lib/http/errors";
import { v1 } from "@/lib/api/v1";
import { listDispositions, listProcesses } from "@/lib/admin/processes";

export const GET = v1(async (_req, ctx) => {
  const procs = await listProcesses(ctx);
  const items = await Promise.all(
    procs.map(async (p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      stages: p.stages,
      wonStage: p.wonStage,
      outcomes: (await listDispositions(ctx, p.id)).filter((d) => d.isActive).map((d) => ({ id: d.id, code: d.code, label: d.label, category: d.category })),
    })),
  );
  return json({ items });
});
