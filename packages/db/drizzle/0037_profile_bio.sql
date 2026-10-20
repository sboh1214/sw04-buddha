-- #41 공개 프로필 (ADR-0069 decision 3 #37-3·#37-9, decision 7; ADR-0078): the profile's 소개 —
-- plain text of at most 160 characters, line breaks kept, never a link — or NULL while the member
-- wrote none, which is every existing row, so no backfill. A blank one is stored as NULL (the
-- CHECK, as a post's title). As generated; only this comment was added. buddha_app keeps the
-- default privileges on profiles (the column is written with UPDATE like the nickname and the
-- time zone).
ALTER TABLE "profiles" ADD COLUMN "bio" varchar(160);--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_bio_check" CHECK ("profiles"."bio" IS NULL OR btrim("profiles"."bio") <> '');