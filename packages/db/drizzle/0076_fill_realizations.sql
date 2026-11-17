-- #124: what a member seller realised on each trade fill, and a person's settlements by time.
-- Generated schema followed by hand-written guards and a backfill of the fills there already.
-- Additive: a new table, an index and rows of the new table only. No existing row is changed.
CREATE TABLE "fill_realizations" (
	"fill_id" bigint PRIMARY KEY NOT NULL,
	"proceeds_coin" bigint NOT NULL,
	"cost_released_coin" bigint NOT NULL,
	"realized_pnl_coin" bigint NOT NULL,
	CONSTRAINT "fill_realizations_proceeds_coin_check" CHECK ("fill_realizations"."proceeds_coin" >= 0),
	CONSTRAINT "fill_realizations_cost_released_coin_check" CHECK ("fill_realizations"."cost_released_coin" >= 0),
	CONSTRAINT "fill_realizations_realized_pnl_coin_check" CHECK ("fill_realizations"."realized_pnl_coin" = "fill_realizations"."proceeds_coin" - "fill_realizations"."cost_released_coin")
);
--> statement-breakpoint
ALTER TABLE "fill_realizations" ADD CONSTRAINT "fill_realizations_fill_id_fills_id_fk" FOREIGN KEY ("fill_id") REFERENCES "public"."fills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "position_settlements_user_id_settled_at_idx" ON "position_settlements" USING btree ("user_id","settled_at" desc,"market_id" desc);
--> statement-breakpoint
-- Hand-edited from here. A record is bound to its fill when it is written: a trade fill (a pair
-- mint sells nothing), its net proceeds the fill's amount less its fee, and a member on the
-- selling side — the incoming owner of a sell, the resting owner of a buy. The 운영 마켓메이커's
-- sales are not recorded: its pair burns move cost and realised P&L without a fill, so its rows
-- would not add up to its position. Read by primary key; a fill never changes
-- (`fills_keep_record`, 0062).
CREATE FUNCTION fill_realizations_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  f fills%ROWTYPE;
BEGIN
  SELECT * INTO f FROM fills WHERE id = NEW.fill_id;
  IF f.id IS NULL OR f.kind <> 'trade'
     OR NEW.proceeds_coin <> f.amount_coin - f.fee_coin
     OR (CASE WHEN f.side = 'sell' THEN f.incoming_account_type ELSE f.resting_account_type END)
        <> 'member' THEN
    RAISE EXCEPTION 'a fill realization records a member''s sale on a trade fill, net of its fee'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER fill_realizations_check
  BEFORE INSERT ON "fill_realizations"
  FOR EACH ROW EXECUTE FUNCTION fill_realizations_check();--> statement-breakpoint
-- A record is a permanent fact like its fill, whoever writes; buddha_app loses both privileges
-- below. Emptying the table (the reset) fires no row trigger.
CREATE FUNCTION fill_realizations_keep_record() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'fill realization % is a permanent record and takes no %', OLD.fill_id, TG_OP
    USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
END;
$$;--> statement-breakpoint
CREATE TRIGGER fill_realizations_keep_record
  BEFORE UPDATE OR DELETE ON "fill_realizations"
  FOR EACH ROW EXECUTE FUNCTION fill_realizations_keep_record();--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE "fill_realizations" FROM buddha_app;--> statement-breakpoint
-- Backfill (ADR-0135 결과 4, ADR-0143 결정 10), the last statement. Every fill is read as two
-- events, one per side, and a member's events are replayed per position (owner, market, contract)
-- in fill id order — one intake's fills share an instant, their ids do not — from nothing held:
-- a buy adds its quantity and what it paid (a pair mint's resting side holds the other contract
-- at the payout less the price), a sale releases cost with the half-up rounding of
-- packages/shared accounting.ts (`applySell`) and realises its proceeds less that cost. At a
-- position's last event the replay is held against the books, and only a position whose
-- quantity, cost and realised P&L all agree gets its sales written:
--   not settled            positions.qty, cost_basis_coin, realized_pnl_coin
--   settled, with a record position_settlements.qty, cost_basis_coin, realized_pnl_before_coin
--   settled, no record     0, 0, positions.realized_pnl_coin
-- Left without a record (the screen shows '—'): every sale of a position that disagrees, that
-- sells more than the replay holds or that has no row; a sale by an account that is no member;
-- and everything when the fills outnumber the bound below, so that the statement stays seconds
-- long under the migrator's 30-second statement timeout while intakes wait on the new foreign
-- key's lock. It raises nothing: a deploy is never stopped here, and what was left out is read
-- afterwards with the query of docs/OPERATIONS.md. A fill already recorded is kept as it is
-- (ON CONFLICT), so the same body may be run again by a later migration. The expected values
-- come from the same query as the events, so both are one snapshot.
DO $$
DECLARE
  ev record;
  held bigint := 0;
  basis bigint := 0;
  gained bigint := 0;
  freed bigint;
  sound boolean := true;
  sold_fills bigint[] := '{}';
  sold_proceeds bigint[] := '{}';
  sold_costs bigint[] := '{}';
  want_held bigint;
  want_basis bigint;
  want_gained bigint;
BEGIN
  IF (SELECT count(*) FROM fills) > 20000 THEN
    RETURN;
  END IF;
  FOR ev IN
    SELECT e.owner_id, f.market_id, e.contract, f.id AS fill_id, e.sells, f.qty::bigint AS qty,
           e.coin,
           row_number() OVER w AS seq,
           count(*) OVER (PARTITION BY e.owner_id, f.market_id, e.contract) AS total,
           p.user_id IS NOT NULL AS has_position, p.settled,
           p.qty::bigint AS position_qty, p.cost_basis_coin AS position_cost,
           p.realized_pnl_coin AS position_pnl,
           s.user_id IS NOT NULL AS has_record,
           s.qty::bigint AS record_qty, s.cost_basis_coin AS record_cost,
           s.realized_pnl_before_coin AS record_pnl
    FROM fills f
    CROSS JOIN LATERAL (VALUES
      (f.incoming_owner_id, f.incoming_account_type, f.outcome,
       f.kind = 'trade' AND f.side = 'sell',
       CASE WHEN f.kind = 'trade' AND f.side = 'sell' THEN f.amount_coin - f.fee_coin
            ELSE f.amount_coin END),
      (f.resting_owner_id, f.resting_account_type,
       CASE WHEN f.kind = 'trade' THEN f.outcome
            WHEN f.outcome = 'YES' THEN 'NO'::outcome ELSE 'YES'::outcome END,
       f.kind = 'trade' AND f.side = 'buy',
       CASE WHEN f.kind = 'pair_mint' THEN (100 - f.price_coin)::bigint * f.qty
            WHEN f.side = 'buy' THEN f.amount_coin - f.fee_coin
            ELSE f.amount_coin END)
    ) AS e(owner_id, account_type, contract, sells, coin)
    LEFT JOIN positions p
      ON p.user_id = e.owner_id AND p.market_id = f.market_id AND p.outcome = e.contract
    LEFT JOIN position_settlements s
      ON s.user_id = e.owner_id AND s.market_id = f.market_id AND s.outcome = e.contract
    WHERE e.account_type = 'member'
    WINDOW w AS (PARTITION BY e.owner_id, f.market_id, e.contract ORDER BY f.id)
    ORDER BY e.owner_id, f.market_id, e.contract, f.id
  LOOP
    IF ev.seq = 1 THEN
      held := 0;
      basis := 0;
      gained := 0;
      sound := true;
      sold_fills := '{}';
      sold_proceeds := '{}';
      sold_costs := '{}';
    END IF;
    IF sound THEN
      IF ev.sells THEN
        IF ev.qty > held THEN
          sound := false;
        ELSE
          freed := (basis * ev.qty::bigint + held / 2) / held;
          held := held - ev.qty;
          basis := basis - freed;
          gained := gained + ev.coin - freed;
          sold_fills := sold_fills || ev.fill_id::bigint;
          sold_proceeds := sold_proceeds || ev.coin::bigint;
          sold_costs := sold_costs || freed;
        END IF;
      ELSE
        held := held + ev.qty;
        basis := basis + ev.coin;
      END IF;
    END IF;
    IF ev.seq = ev.total AND sound AND ev.has_position AND cardinality(sold_fills) > 0 THEN
      IF ev.has_record THEN
        want_held := ev.record_qty;
        want_basis := ev.record_cost;
        want_gained := ev.record_pnl;
      ELSIF ev.settled THEN
        want_held := 0;
        want_basis := 0;
        want_gained := ev.position_pnl;
      ELSE
        want_held := ev.position_qty;
        want_basis := ev.position_cost;
        want_gained := ev.position_pnl;
      END IF;
      IF held = want_held AND basis = want_basis AND gained = want_gained THEN
        INSERT INTO fill_realizations
          (fill_id, proceeds_coin, cost_released_coin, realized_pnl_coin)
        SELECT r.sold_fill, r.proceeds, r.cost, r.proceeds - r.cost
        FROM unnest(sold_fills, sold_proceeds, sold_costs) AS r(sold_fill, proceeds, cost)
        ON CONFLICT (fill_id) DO NOTHING;
      END IF;
    END IF;
  END LOOP;
END;
$$;
