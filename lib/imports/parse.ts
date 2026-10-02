/**
 * Spreadsheet parsing for imports (T1.26) and the Google Sheet pull (T1.27).
 *
 * CSV (papaparse) or Excel .xlsx (first sheet, read-excel-file). The first
 * row is the header; each later row becomes `{ header: cellText }`, which
 * normaliseLead() maps (field map, else header guesses like "Mobile No").
 * Pure: no database, no network.
 */
import Papa from "papaparse";
import { readSheet } from "read-excel-file/node";

export const MAX_IMPORT_ROWS = 50_000;

export interface ParsedSheet {
  headers: string[];
  rows: Record<string, string>[];
}

export function isExcel(fileName: string): boolean {
  return /\.xlsx$/i.test(fileName);
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  // Excel stores long phone numbers as numbers: 9876543210 → "9876543210", never "9.87e9".
  if (typeof v === "number") return Number.isInteger(v) ? v.toFixed(0) : String(v);
  return String(v).trim();
}

function toRecords(table: unknown[][]): ParsedSheet {
  const [head = [], ...body] = table;
  // Blank or repeated headers get a column name so no data is dropped.
  const seen = new Map<string, number>();
  const headers = head.map((h, i) => {
    const base = cellText(h) || `column_${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base}_${n}` : base;
  });
  const rows: Record<string, string>[] = [];
  for (const r of body) {
    const rec: Record<string, string> = {};
    let any = false;
    headers.forEach((h, i) => {
      const v = cellText(r[i]);
      if (v) any = true;
      rec[h] = v;
    });
    if (any) rows.push(rec);
  }
  return { headers, rows };
}

export function parseCsv(text: string): ParsedSheet {
  // Strip a UTF-8 BOM (Excel "CSV UTF-8" exports start with one).
  const res = Papa.parse<string[]>(text.replace(/^﻿/, ""), { skipEmptyLines: "greedy" });
  return toRecords(res.data);
}

export async function parseSpreadsheet(data: Buffer, fileName: string): Promise<ParsedSheet> {
  const sheet = isExcel(fileName) ? toRecords((await readSheet(data)) as unknown[][]) : parseCsv(data.toString("utf8"));
  if (sheet.rows.length > MAX_IMPORT_ROWS) {
    throw new Error(`File has ${sheet.rows.length} rows; the limit is ${MAX_IMPORT_ROWS.toLocaleString("en-IN")} per import — split it`);
  }
  return sheet;
}
