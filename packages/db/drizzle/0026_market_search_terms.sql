-- #15 최근 검색 (ADR-0066): the recent list's source, one row per (account, term) naming the
-- term's newest search, so `GET /me/search-history` reads the first 10 entries of an index
-- instead of every search the account ever made (DISTINCT ON over market_searches, which a
-- scripted client could make as long as it liked — no retention limit, the owner). Generated
-- down to the index; hand-edited after it only (marked below). The snapshot is as generated.
CREATE TABLE "market_search_terms" (
	"user_id" text NOT NULL,
	"query" varchar(100) NOT NULL,
	"search_id" uuid NOT NULL,
	"searched_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "market_search_terms_user_id_query_pk" PRIMARY KEY("user_id","query")
);
--> statement-breakpoint
ALTER TABLE "market_search_terms" ADD CONSTRAINT "market_search_terms_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_search_terms" ADD CONSTRAINT "market_search_terms_search_id_market_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."market_searches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_search_terms_user_id_searched_at_search_id_idx" ON "market_search_terms" USING btree ("user_id","searched_at" desc,"search_id" desc);--> statement-breakpoint
-- Hand-edited: a recorded search is never changed in place (the API inserts and deletes rows,
-- nothing updates one), so buddha_app loses UPDATE on market_searches. That is what lets the two
-- triggers below keep market_search_terms exact from inserts and deletes alone.
REVOKE UPDATE ON TABLE "market_searches" FROM buddha_app;--> statement-breakpoint
-- Hand-edited: a new search upserts its term. A newer search (by searched_at, then id — the order
-- `DISTINCT ON (query) ... ORDER BY searched_at DESC, id DESC` picks by) moves the term to it; an
-- older one, which only a test factory or a script writes, leaves it. Runs as the inserting role
-- (buddha_app, SECURITY INVOKER), which holds the default DML on market_search_terms.
CREATE FUNCTION market_searches_keep_term() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "market_search_terms" ("user_id", "query", "search_id", "searched_at")
  VALUES (NEW."user_id", NEW."query", NEW."id", NEW."searched_at")
  ON CONFLICT ("user_id", "query") DO UPDATE
    SET "search_id" = EXCLUDED."search_id", "searched_at" = EXCLUDED."searched_at"
    WHERE (EXCLUDED."searched_at", EXCLUDED."search_id")
        > ("market_search_terms"."searched_at", "market_search_terms"."search_id");
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER market_searches_keep_term
  AFTER INSERT ON "market_searches"
  FOR EACH ROW EXECUTE FUNCTION market_searches_keep_term();--> statement-breakpoint
-- Hand-edited: a term whose newest search was deleted points at the newest one it has left, and
-- goes when it has none. The API only ever deletes every search of a term or of an account, so
-- what it leaves is nothing; this keeps any other delete exact too. The `search_id` FK already
-- CASCADEs the term row away with its search; the DELETE here does the same in case it runs
-- first, so the result does not hang on the order the two fire in.
CREATE FUNCTION market_searches_restore_terms() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "market_search_terms" AS t USING gone WHERE t."search_id" = gone."id";
  INSERT INTO "market_search_terms" ("user_id", "query", "search_id", "searched_at")
  SELECT DISTINCT ON (s."user_id", s."query") s."user_id", s."query", s."id", s."searched_at"
  FROM "market_searches" AS s
  JOIN (SELECT DISTINCT "user_id", "query" FROM gone) AS g USING ("user_id", "query")
  ORDER BY s."user_id", s."query", s."searched_at" DESC, s."id" DESC
  ON CONFLICT ("user_id", "query") DO NOTHING;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER market_searches_restore_terms
  AFTER DELETE ON "market_searches"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION market_searches_restore_terms();--> statement-breakpoint
-- Hand-edited: the searches migration 0025 already recorded, each term at its newest.
INSERT INTO "market_search_terms" ("user_id", "query", "search_id", "searched_at")
SELECT DISTINCT ON ("user_id", "query") "user_id", "query", "id", "searched_at"
FROM "market_searches"
ORDER BY "user_id", "query", "searched_at" DESC, "id" DESC;