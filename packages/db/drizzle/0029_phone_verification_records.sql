-- #183 본인확인 기록 (owner decisions 2026-10-18, ADR-0070): phone_verification_codes keeps the
-- client address each code was requested from (NULL when the request names no client: loopback, or
-- a proxy RATE_LIMIT_UNCOUNTED_PEERS lists), so the per-address daily limit counts it, and the rows
-- are no longer purged after 24 hours — they are the account's 본인확인 기록, deleted by #184's
-- retention job. The index serves that limit; the service-wide limit reads the sent_at index 0028
-- made. As generated, with this comment added by hand; the snapshot is as generated.
ALTER TABLE "phone_verification_codes" ADD COLUMN "client_ip" "inet";--> statement-breakpoint
CREATE INDEX "phone_verification_codes_client_ip_sent_at_idx" ON "phone_verification_codes" USING btree ("client_ip","sent_at");
