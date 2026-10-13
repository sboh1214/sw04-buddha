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
-- release_settings without the matching admin_actions row (type, key, actor, instant and the new
-- status and value as payload `after`) fails as a whole. An UPDATE must also move updated_at
-- forward: every record a write already used is no later than the row's instant, so none can be
-- replayed to put an earlier state back unrecorded (the API makes each instant of a key later
-- than the last). admin_actions is append-only (0001), so the row it finds cannot be edited
-- afterwards. Runs as the invoker: buddha_app may SELECT admin_actions. TRUNCATE (wipe.ts, owner
-- only) fires no row trigger.
CREATE FUNCTION release_settings_require_change_record() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'release setting % was written at %, not after its last change at %',
      NEW.key, NEW.updated_at, OLD.updated_at
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM admin_actions a
     WHERE a.type = 'release_setting_change'
       AND a.created_at = NEW.updated_at
       AND a.target_type = 'release_setting'
       AND a.target_id = NEW.key
       AND a.admin_id = NEW.updated_by
       AND a.payload -> 'after' = jsonb_build_object('status', NEW.status::text, 'value', NEW.value)
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
