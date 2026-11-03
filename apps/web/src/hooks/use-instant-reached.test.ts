import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The one-shot timer the member screens wait for an instant with (`useInstantReached`): a held
 * market's 이의 기한 (#175, `useDisputeOpen`) and a 판정 지연 기록's 다음 검토 시각 (#142, ADR-0106,
 * the detail's '갱신 대기'). No component renders under node with effects, so the wiring is pinned
 * in the source; the wait itself is `instantWait`'s (datetime.test.ts) and the e2e (delay.spec.ts,
 * dispute.spec.ts) watches it come on an open page.
 */
describe('useInstantReached', () => {
  const source = readFileSync(new URL('./use-instant-reached.ts', import.meta.url), 'utf8');
  const hook = source.slice(source.indexOf('export function useInstantReached('));

  it('says not come on the first render, and runs the timer in an effect from the anchor', () => {
    // The first render — the server's HTML — never reads the clock: nothing seen come yet.
    expect(hook).toContain('const [reachedAt, setReachedAt] = useState<string | null>(null);');
    expect(hook).toContain('return at !== null && reachedAt === at;');
    // The anchor's elapsed time, counted as the countdown counts it, then the wait.
    expect(hook).toContain('tickingNow(anchorAt, performance.now() - startedAt, Date.now())');
    expect(hook).toContain('const wait = instantWait(at, now);');
    expect(hook).toContain('timer = setTimeout(check, 0);');
    // `Date.now()` only inside the effect's timer callback.
    const body = hook.slice(0, hook.indexOf('useEffect(() => {\n    if (at === null)'));
    expect(body).not.toContain('Date.now()');
  });

  it('waits for each new instant afresh, and tells the caller once it comes', () => {
    // The instant seen come is the one compared: another read's instant is not come until its own
    // timer says so.
    expect(hook).toContain('setReachedAt(at);\n        reachedRef.current?.();');
    expect(hook).toContain('}, [at, anchorAt]);');
  });
});
