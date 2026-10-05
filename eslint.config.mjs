import nextConfig from "eslint-config-next";

const config = [
  ...nextConfig,
  { ignores: ["Docs/**", ".next/**", "node_modules/**"] },
  {
    // SQL injection guard (SECURITY.md §2): values go into queries only as
    // Drizzle parameters. sql.raw() / sql.unsafe paste text into SQL — banned
    // everywhere (migrations live in drizzle/*.sql, not here).
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["tests/**", "scripts/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='sql'][property.name=/^(raw|unsafe)$/]",
          message: "sql.raw/sql.unsafe paste text into SQL (injection risk). Pass values as ${param}, or build with sql`…` fragments.",
        },
      ],
    },
  },
  {
    // RULE.md §1.4: only lib/db and lib/platform-admin may reach the raw
    // connection. Everyone else goes through withTenant(), which switches to
    // the app_rls role so Postgres row-level security applies.
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["lib/db/**", "lib/platform-admin/**", "scripts/**", "tests/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/db/client",
              message: "Raw database access bypasses row-level security. Use withTenant() from @/lib/db/tenant (RULE.md §1).",
            },
            {
              name: "pg",
              message: "Use withTenant() from @/lib/db/tenant (RULE.md §1).",
            },
            {
              name: "@/lib/platform-admin/db",
              message: "Cross-tenant access is reserved for lib/platform-admin. Use withTenant() (RULE.md §1).",
            },
          ],
        },
      ],
    },
  },
];

export default config;
