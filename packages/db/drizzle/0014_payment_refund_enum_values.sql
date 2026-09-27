-- SmartroPay (ADR-0042): the statuses a real PG needs and the two ledger types of an admin
-- refund. `cancelled` = approved by the PG but net-cancelled before any P was credited;
-- `refunding` = P clawed back, PG cancel not yet confirmed; `refunded` = both done.
-- PAYMENT_CANCEL takes a charge's P back (-amount_p, ref payment); PAYMENT_CANCEL_REVERSAL puts
-- it back when the PG refuses the cancel.
--
-- Enum values ONLY, and in a migration of their own on purpose: drizzle-orm runs every pending
-- migration in ONE transaction, and Postgres refuses to use a value added by `ALTER TYPE ... ADD
-- VALUE` before that transaction commits (55P04 "unsafe use of new value"). So nothing in this
-- batch — this file, 0015 or any later file applied in the same run — may name these values in
-- a default, CHECK, index predicate or UPDATE; the application uses them once the run commits.
ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'PAYMENT_CANCEL';--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'PAYMENT_CANCEL_REVERSAL';--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'refunding';--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'refunded';