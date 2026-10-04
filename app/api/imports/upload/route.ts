/**
 * POST /api/imports/upload — issues a short-lived token so the browser can
 * upload a CSV/Excel file straight to the PRIVATE Blob store (no 4.5 MB
 * function body limit). Only roles that may create import sources get one,
 * and only for a path under imports/<their tenant id>/.
 */
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { requireSession } from "@/lib/auth/session";
import { requirePermission } from "@/lib/auth/rbac";
import { badRequest, handle, json } from "@/lib/http/errors";
import { tenantPrefix } from "@/lib/storage/blob";

const MAX_BYTES = 20 * 1024 * 1024;

export const POST = handle(async (req: Request) => {
  const ctx = await requireSession(req);
  requirePermission(ctx, "leads", "I"); // I = import (DESIGN.md §7)
  const body = (await req.json()) as HandleUploadBody;
  const result = await handleUpload({
    request: req,
    body,
    onBeforeGenerateToken: async (pathname) => {
      if (!pathname.startsWith(tenantPrefix(ctx.tenantId, "imports")) || !/\.(csv|xlsx)$/i.test(pathname)) {
        throw badRequest("Upload a .csv or .xlsx file");
      }
      return {
        allowedContentTypes: [
          "text/csv",
          "application/vnd.ms-excel", // Windows reports .csv as this
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/octet-stream",
        ],
        maximumSizeInBytes: MAX_BYTES,
        addRandomSuffix: true,
        validUntil: Date.now() + 10 * 60_000,
      };
    },
    // The import is started explicitly by the startImport action, so no callback is needed.
  });
  return json(result);
});
