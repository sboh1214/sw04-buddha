-- #60 item 8: the time zone a member picked in MY 설정 for reading times (ADR-0061, ADR-0063).
-- NULL means "follow the browser", which is every existing row, so no backfill. As generated;
-- only this comment was added. buddha_app keeps the default privileges on profiles (the column is
-- written with UPDATE like the nickname).
ALTER TABLE "profiles" ADD COLUMN "time_zone" varchar(64);
