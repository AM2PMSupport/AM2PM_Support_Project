-- Extensions for fast search (DESIGN.md §2.5). Must run before 0003, which
-- creates indexes that use them. Both are supported on Neon.
--
-- pg_trgm   — trigram indexes: fast ILIKE '%…%' on names, emails and phone
--             digits (partial matches such as "Rah" or the last 4 digits).
-- btree_gin — lets a GIN index start with tenant_id (a plain uuid column), so
--             search indexes stay tenant-first like every other index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gin;
