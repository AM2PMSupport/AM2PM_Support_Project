/**
 * CSV for exports (leads, reports). Every cell is quoted, and a value that
 * starts with = + - @ gets a leading ' so a spreadsheet shows it as text
 * instead of running it as a formula (CSV injection).
 */
export const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

export const toCsv = (head: string[], rows: unknown[][]) => [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");

export const csvResponse = (body: string, filename: string) =>
  new Response(body, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store" },
  });
