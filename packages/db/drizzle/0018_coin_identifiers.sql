-- #192: stored names follow the currency the product calls Coin (owner decision D20). Every
-- `<name>_p` column becomes `<name>_coin`, and the CHECK constraints and the index named after
-- one follow it. Custom migration (drizzle-kit generate --custom --name coin_identifiers):
-- drizzle-kit asks interactively whether a column that vanished was renamed, and it answers a
-- renamed CHECK or index with a DROP and a CREATE, so these statements are written by hand and
-- meta/0018_snapshot.json is the TS schema as `drizzle-kit generate` serialises it.
--
-- 1. RENAME keeps every row. Postgres stores CHECK and index expressions against the column, not
--    its name, so `charge_packages_price_within_face_value_check` (which keeps its name) and the
--    renamed ones read the new columns without being rebuilt. The data is neither moved nor kept
--    readable under the old names (D4): JSONB payload keys already written (admin_actions,
--    market_events, audit_failures) stay as they are, and only what is written from now on uses
--    the *Coin keys. The release that is still serving while deploy/deploy.sh migrates queries
--    the old names until it is replaced.
-- 2. create_profile_for_user() names its columns in a plpgsql body, which RENAME COLUMN does not
--    touch: left alone, the 0004 body would fail every sign-up. It is re-created with the new
--    names and nothing else changed — the '예측가_' nickname and the 10,000 bonus are 0004's
--    (keep SIGNUP_BONUS_COIN in @buddha/shared in step with the literal).
ALTER TABLE "balances" RENAME COLUMN "available_p" TO "available_coin";--> statement-breakpoint
ALTER TABLE "balances" RENAME COLUMN "locked_p" TO "locked_coin";--> statement-breakpoint
ALTER TABLE "balances" RENAME CONSTRAINT "balances_available_p_check" TO "balances_available_coin_check";--> statement-breakpoint
ALTER TABLE "balances" RENAME CONSTRAINT "balances_locked_p_check" TO "balances_locked_coin_check";--> statement-breakpoint
ALTER TABLE "ledger_entries" RENAME COLUMN "amount_p" TO "amount_coin";--> statement-breakpoint
ALTER TABLE "ledger_entries" RENAME COLUMN "balance_after_p" TO "balance_after_coin";--> statement-breakpoint
ALTER TABLE "fills" RENAME COLUMN "amount_p" TO "amount_coin";--> statement-breakpoint
ALTER TABLE "fills" RENAME COLUMN "fee_p" TO "fee_coin";--> statement-breakpoint
ALTER TABLE "fills" RENAME CONSTRAINT "fills_amount_p_check" TO "fills_amount_coin_check";--> statement-breakpoint
ALTER TABLE "fills" RENAME CONSTRAINT "fills_fee_p_check" TO "fills_fee_coin_check";--> statement-breakpoint
ALTER TABLE "markets" RENAME COLUMN "volume_p" TO "volume_coin";--> statement-breakpoint
ALTER TABLE "markets" RENAME CONSTRAINT "markets_volume_p_check" TO "markets_volume_coin_check";--> statement-breakpoint
ALTER INDEX "markets_status_volume_p_id_idx" RENAME TO "markets_status_volume_coin_id_idx";--> statement-breakpoint
ALTER TABLE "positions" RENAME COLUMN "cost_basis_p" TO "cost_basis_coin";--> statement-breakpoint
ALTER TABLE "positions" RENAME COLUMN "realized_pnl_p" TO "realized_pnl_coin";--> statement-breakpoint
ALTER TABLE "positions" RENAME CONSTRAINT "positions_cost_basis_p_check" TO "positions_cost_basis_coin_check";--> statement-breakpoint
ALTER TABLE "payments" RENAME COLUMN "amount_p" TO "amount_coin";--> statement-breakpoint
ALTER TABLE "payments" RENAME CONSTRAINT "payments_amount_p_check" TO "payments_amount_coin_check";--> statement-breakpoint
ALTER TABLE "charge_packages" RENAME COLUMN "amount_p" TO "amount_coin";--> statement-breakpoint
ALTER TABLE "charge_packages" RENAME CONSTRAINT "charge_packages_amount_p_check" TO "charge_packages_amount_coin_check";--> statement-breakpoint
ALTER TABLE "coupons" RENAME COLUMN "amount_p" TO "amount_coin";--> statement-breakpoint
ALTER TABLE "coupons" RENAME CONSTRAINT "coupons_amount_p_check" TO "coupons_amount_coin_check";--> statement-breakpoint
ALTER TABLE "coupon_redemptions" RENAME COLUMN "amount_p" TO "amount_coin";--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_profile_for_user() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  -- 32 unambiguous upper-case letters and digits (no 0/O/1/I): 32^4 = 1,048,576 suffixes.
  alphabet CONSTANT text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  bonus_coin CONSTANT bigint := 10000;
  suffix text;
  i integer;
  attempt integer := 0;
BEGIN
  LOOP
    attempt := attempt + 1;
    suffix := '';
    FOR i IN 1..4 LOOP
      suffix := suffix || substr(alphabet, 1 + floor(random() * 32)::integer, 1);
    END LOOP;
    BEGIN
      INSERT INTO profiles (user_id, nickname) VALUES (NEW.id, '예측가_' || suffix);
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF attempt >= 10 THEN RAISE; END IF;
    END;
  END LOOP;
  INSERT INTO balances (user_id, available_coin) VALUES (NEW.id, bonus_coin);
  INSERT INTO ledger_entries (user_id, type, amount_coin, balance_after_coin, memo)
  VALUES (NEW.id, 'BONUS', bonus_coin, bonus_coin, '가입 보너스');
  RETURN NEW;
END;
$$;
