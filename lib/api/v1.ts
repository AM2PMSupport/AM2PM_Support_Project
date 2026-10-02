/**
 * Route wrapper for /api/v1/*: who is calling (session or API key), write
 * scope for mutations, standard error shape. Handlers stay one call into
 * lib/* — the SAME functions the screens and GraphQL use.
 */
import { handle } from "@/lib/http/errors";
import { apiContext, requireWrite, type ApiContext } from "@/lib/api/context";

type Params = Record<string, string>;

export function v1<P extends Params = Params>(fn: (req: Request, ctx: ApiContext, params: P) => Promise<Response>, opts: { write?: boolean } = {}) {
  return handle(async (req: Request, arg: { params: Promise<P> }) => {
    const ctx = await apiContext(req);
    if (opts.write) requireWrite(ctx);
    return fn(req, ctx, (await arg?.params) ?? ({} as P));
  });
}
