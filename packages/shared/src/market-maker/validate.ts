/** RangeError unless `value` is a safe integer of at least `min`. Shared by the market maker. */
export function assertWhole(name: string, value: number, min: number): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new RangeError(
      `${name} must be an integer of at least ${String(min)}, got ${String(value)}`,
    );
  }
}
