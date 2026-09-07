// Test-only, loaded into the seed CLI with a second `--import` (see seed.test.ts). Shifts the
// CHILD's own clock by SEED_TEST_CLOCK_SHIFT_MS so a case can tell which clock a seeded value
// came from: after ADR-0027 the market row's `open_at` and its open tick follow Postgres and
// do not move, while better-auth's `user.created_at` deliberately follows the runner and does.
//
// Only the zero-argument forms shift. `new Date(seed.closeAt)` parses the absolute cutoffs the
// suite asserts byte for byte, and `class extends Date` keeps `Date.parse`/`Date.UTC` by static
// inheritance and keeps `value instanceof Date` true for the driver's parameter serialisation.
const shiftMs = Number(process.env.SEED_TEST_CLOCK_SHIFT_MS ?? '0');
const RealDate = Date;

class ShiftedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + shiftMs);
    else super(...args);
  }

  static now() {
    return RealDate.now() + shiftMs;
  }
}

globalThis.Date = ShiftedDate;
