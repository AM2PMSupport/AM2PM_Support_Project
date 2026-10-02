/**
 * API.md must describe the API that actually exists (CLAUDE.md: "update API.md
 * in the same change"). This test fails when:
 *   - an app/api route file exists whose path isn't documented in API.md, or
 *     one of its exported HTTP methods isn't documented for that path;
 *   - the GraphQL schema in API.md §6.2 differs from lib/graphql/schema.ts.
 * Fix by documenting the endpoint (request, response, errors) — not by
 * loosening this test.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { typeDefs } from "@/lib/graphql/schema";

const doc = readFileSync("API.md", "utf8");

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? routeFiles(p) : f === "route.ts" ? [p] : [];
  });
}

/** app/api/v1/leads/[id]/route.ts → regex for "/api/v1/leads/{anything}" */
function pathPattern(file: string): { label: string; re: RegExp } {
  const parts = relative("app", file).replace(/\/route\.ts$/, "").split("/");
  const label = "/" + parts.join("/");
  const src = parts.map((seg) => (/^\[.+\]$/.test(seg) ? "\\{[^}/]+\\}" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/");
  return { label, re: new RegExp(`/${src}(?![\\w/{])`) };
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

describe("API.md documents every route", () => {
  for (const file of routeFiles("app/api")) {
    const { label, re } = pathPattern(file);
    const src = readFileSync(file, "utf8");
    const exported = METHODS.filter((m) => new RegExp(`export (const|async function) ${m}\\b|export \\{[^}]*\\bas ${m}\\b`).test(src));
    it(`${label} (${exported.join(", ")})`, () => {
      const lines = doc.split("\n").filter((l) => re.test(l));
      expect(lines.length, `${label} is not documented in API.md`).toBeGreaterThan(0);
      for (const m of exported) {
        expect(lines.some((l) => new RegExp(`\\b${m}\\b`).test(l)), `${m} ${label} is not documented in API.md`).toBe(true);
      }
    });
  }
});

describe("API.md §6.2 GraphQL schema", () => {
  it("matches lib/graphql/schema.ts exactly", () => {
    const block = /### 6\.2[^\n]*\n+```graphql\n([\s\S]*?)\n```/.exec(doc)?.[1];
    expect(block, "API.md §6.2 graphql block missing").toBeDefined();
    const norm = (t: string) => t.trim().split("\n").map((l) => l.trimEnd()).join("\n");
    expect(norm(block!)).toBe(norm(typeDefs));
  });
});
