-- #170 release settings: the stored status and value of each item RELEASE_SETTINGS (@buddha/shared)
-- registers, and the index the change log reads admin_actions through. Hand-edited after
-- `drizzle-kit generate` at the end only (marked below); the snapshot is as generated.
--
-- No row is written here: a registered key without a row is `undecided`. Values arrive only
-- through an admin's change on the admin screen, never through a migration or the seed, so every
-- item starts `undecided` after a dev setup or a reset (owner decision 2026-10-13~14, #170).
CREATE TYPE "public"."release_setting_status" AS ENUM('undecided', 'proposal', 'test', 'approved');--> statement-breakpoint
CREATE TABLE "release_settings" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value" jsonb,
	"status" "release_setting_status" NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "release_settings_value_status_check" CHECK (("release_settings"."status" = 'undecided') = ("release_settings"."value" IS NULL) AND jsonb_typeof("release_settings"."value") IS DISTINCT FROM 'null')
);
--> statement-breakpoint
ALTER TABLE "release_settings" ADD CONSTRAINT "release_settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_actions_type_created_at_id_idx" ON "admin_actions" USING btree ("type","created_at" desc,"id" desc);--> statement-breakpoint
-- Hand-edited: a setting is never deleted (going back to `undecided` is itself a recorded change),
-- so buddha_app keeps SELECT/INSERT/UPDATE of the default privileges in
-- docker/postgres/init/01-roles.sql and loses DELETE.
REVOKE DELETE ON TABLE "release_settings" FROM buddha_app;--> statement-breakpoint
-- Hand-edited: a value cannot change without its record. Checked at COMMIT (deferred), so the
-- order of the two INSERTs inside the transaction does not matter; a transaction that writes
-- release_settings without the matching admin_actions row (type, the key both as target and as
-- the payload `key` the change log shows, actor, instant, the new status and value as payload
-- `after`, the state it replaced as payload `before` — the old row's status and value for an
-- UPDATE, the implicit undecided state with no value for an INSERT, as the API records them —
-- and a payload `reason` the API's reason schema takes: a string of 1 to
-- RELEASE_SETTING_REASON_MAX_LENGTH (500) characters once trimmed, trimmed as JavaScript does
-- and counted in code points as zod does) fails as a whole. So the change log cannot misreport a transition, and every record a
-- write used reads as releaseSettingChangePayloadSchema (@buddha/shared) expects: the change log
-- fails on a record it cannot read. An UPDATE must keep the key: renaming a row would, like the
-- DELETE revoked above, leave its registered key undecided and split its history. It must also
-- move updated_at forward: every record a write already used is no later than the row's
-- instant, so none can be replayed to put an earlier state back unrecorded (the API makes each
-- instant of a key later than the last). admin_actions is append-only (0001), so the row it
-- finds cannot be edited afterwards. Runs as the invoker: buddha_app may SELECT admin_actions.
-- TRUNCATE (wipe.ts, owner only) fires no row trigger.
CREATE FUNCTION release_settings_require_change_record() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  -- A key with no row is undecided; the record of its first write says so.
  replaced jsonb := '{"status": "undecided", "value": null}'::jsonb;
  -- What JavaScript's String.prototype.trim strips (its white space and line terminators), as
  -- the API's reason schema trims (z.string().trim()) before it counts.
  js_trimmed constant text := E'\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005'
    || E'\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
BEGIN
  IF TG_OP = 'UPDATE' THEN
    replaced := jsonb_build_object('status', OLD.status::text, 'value', OLD.value);
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.key <> OLD.key THEN
    RAISE EXCEPTION 'release setting % cannot be renamed to %: a key is never changed or removed',
      OLD.key, NEW.key
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'release setting % was written at %, not after its last change at %',
      NEW.key, NEW.updated_at, OLD.updated_at
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM admin_actions a
           CROSS JOIN LATERAL (
             SELECT btrim(a.payload ->> 'reason', js_trimmed) AS trimmed
           ) reason
     WHERE a.type = 'release_setting_change'
       AND a.created_at = NEW.updated_at
       AND a.target_type = 'release_setting'
       AND a.target_id = NEW.key
       -- As JSON: a string, so a key that spells a JSON literal (`true`) is not met by one.
       AND a.payload -> 'key' = to_jsonb(NEW.key::text)
       AND a.admin_id = NEW.updated_by
       AND a.payload -> 'after' = jsonb_build_object('status', NEW.status::text, 'value', NEW.value)
       AND a.payload -> 'before' = replaced
       AND jsonb_typeof(a.payload -> 'reason') = 'string'
       -- char_length counts code points, as zod's min and max do on a string.
       AND char_length(reason.trimmed) BETWEEN 1 AND 500
  ) THEN
    RAISE EXCEPTION 'release setting % was written without its release_setting_change record', NEW.key
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER release_settings_change_recorded
  AFTER INSERT OR UPDATE ON "release_settings"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION release_settings_require_change_record();
