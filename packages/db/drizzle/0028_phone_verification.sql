-- #183 본인확인 (ADR-0069 decision 1 #57-1·#57-3, ADR-0070): phone_verifications holds the accounts
-- that proved a mobile number with an SMS code — one per account, one account per number (the
-- UNIQUE), the digits only (the CHECK) — with the real name given beside it; phone_verification_codes
-- holds each code sent (an HMAC of it, never the digits), which the fixed send limits count.
-- user_contacts (ADR-0043: the real name and number nobody verified, several accounts per number)
-- is dropped with its rows: the verified number replaces it, and D4 carries nothing over — every
-- account, the seeded admins included, verifies at its next sign-in. buddha_app keeps the default
-- privileges of docker/postgres/init/01-roles.sql on both tables. As generated, with this comment
-- added by hand; the snapshot is as generated.
CREATE TABLE "phone_verification_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"phone" varchar(11) NOT NULL,
	"real_name" varchar(30) NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"sent_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"consumed_at" timestamp (3) with time zone,
	CONSTRAINT "phone_verification_codes_attempts_check" CHECK ("phone_verification_codes"."attempts" >= 0),
	CONSTRAINT "phone_verification_codes_expiry_check" CHECK ("phone_verification_codes"."expires_at" > "phone_verification_codes"."sent_at")
);
--> statement-breakpoint
CREATE TABLE "phone_verifications" (
	"user_id" text PRIMARY KEY NOT NULL,
	"phone" varchar(11) NOT NULL,
	"real_name" varchar(30) NOT NULL,
	"verified_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_verifications_phone_unique" UNIQUE("phone"),
	CONSTRAINT "phone_verifications_phone_check" CHECK ("phone_verifications"."phone" ~ '^01[016789][0-9]{7,8}$')
);
--> statement-breakpoint
DROP TABLE "user_contacts" CASCADE;--> statement-breakpoint
ALTER TABLE "phone_verification_codes" ADD CONSTRAINT "phone_verification_codes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_verifications" ADD CONSTRAINT "phone_verifications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "phone_verification_codes_user_id_sent_at_id_idx" ON "phone_verification_codes" USING btree ("user_id","sent_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "phone_verification_codes_phone_sent_at_idx" ON "phone_verification_codes" USING btree ("phone","sent_at");--> statement-breakpoint
CREATE INDEX "phone_verification_codes_sent_at_idx" ON "phone_verification_codes" USING btree ("sent_at");