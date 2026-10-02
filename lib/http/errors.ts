/**
 * API error shape and helpers (RULE.md §7.4).
 *
 * Every API route returns errors as `{ error: { code, message } }` with a
 * matching HTTP status. Throw `ApiError` anywhere in a request and wrap the
 * handler with `handle()` so unknown errors become a safe 500 without a stack
 * trace leaking to the client.
 */
import { ZodError, type ZodType, type z } from "zod";
import { log } from "@/lib/log";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (message: string, code = "bad_request") => new ApiError(400, code, message);
export const unauthorized = (message = "Not signed in", code = "unauthorized") => new ApiError(401, code, message);
export const forbidden = (message = "Not allowed", code = "forbidden") => new ApiError(403, code, message);
export const notFound = (message = "Not found", code = "not_found") => new ApiError(404, code, message);
export const conflict = (message: string, code = "conflict") => new ApiError(409, code, message);

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return json({ error: { code: err.code, message: err.message } }, err.status);
  }
  if (err instanceof ZodError) {
    const i = err.issues[0];
    return json({ error: { code: "invalid_input", message: `${i?.path.join(".") || "input"}: ${i?.message ?? "invalid"}` } }, 400);
  }
  log.error("unhandled error", { err });
  return json({ error: { code: "internal", message: "Something went wrong" } }, 500);
}

/** Parse a JSON request body with a Zod schema (400 on bad JSON / invalid input). */
export async function readJson<S extends ZodType>(req: Request, schema: S): Promise<z.output<S>> {
  const raw: unknown = await req.json().catch(() => {
    throw badRequest("Body must be JSON", "invalid_json");
  });
  return schema.parse(raw);
}

/** Wraps a route handler so thrown errors become the standard error shape. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      return errorResponse(err);
    }
  };
}
