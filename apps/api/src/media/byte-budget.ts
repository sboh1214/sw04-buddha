/**
 * A budget of bytes held at once, process-wide (ADR-0073): `take` gives a share back as a
 * `release` (idempotent), or null when the share would pass the budget. A budget holding nothing
 * takes any one share, however large, so nothing is refused for its own size alone.
 *
 * Two of them: the image reads being sent (image-reads.ts, decision 9-36) and the upload bodies
 * being received (image-body.ts, owner decision 2026-10-21).
 */
export class ByteBudget {
  private held = 0;

  constructor(private readonly max: number) {}

  /** The bytes held now. */
  get size(): number {
    return this.held;
  }

  take(bytes: number): (() => void) | null {
    if (this.held > 0 && this.held + bytes > this.max) return null;
    this.held += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held -= bytes;
    };
  }
}
