/**
 * A count of things in flight under each key, up to a maximum per key (ADR-0073): `take` gives a
 * place back as a `release` (idempotent), or null when the key holds its maximum already. A key
 * holding nothing is forgotten, so the map holds only the keys with something in flight.
 *
 * One of them: each account's uploads in flight (image-body.ts, owner decision 2026-10-21
 * answer 4 — three).
 */
export class InFlightPerKey {
  private readonly counts = new Map<string, number>();

  constructor(private readonly max: number) {}

  /** What is in flight under `key` now. */
  of(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** The keys with something in flight. */
  get size(): number {
    return this.counts.size;
  }

  take(key: string): (() => void) | null {
    const held = this.of(key);
    if (held >= this.max) return null;
    this.counts.set(key, held + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = this.of(key) - 1;
      if (left > 0) this.counts.set(key, left);
      else this.counts.delete(key);
    };
  }
}
