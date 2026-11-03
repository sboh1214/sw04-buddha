'use client';

import { Text } from '@chakra-ui/react';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
} from 'react';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { SEOUL_TIME_ZONE, formatInTimeZone } from '@/lib/datetime';
import {
  type HeldTimeZone,
  browserTimeZone,
  displayTimeZone,
  holdTimeZone,
  judgementLineZone,
  settledTimeZone,
  timeZoneLabel,
  timeZoneSettled,
} from '@/lib/time-zone';
import { useSession } from '@/lib/use-session';

/**
 * The zone every member-screen time is read in (ADR-0061 #60-8, ADR-0063): the one picked in
 * MY 설정, or the browser's when none is picked or nobody is signed in.
 *
 * THE RULE this file exists for: the server's render and the FIRST client render use Seoul,
 * whoever is visiting. The detail page's HTML is the same bytes for every visitor (AC 2, ADR-0031:
 * no cookie reaches the server fetch, and `dehydratePublic` drops every private root), so the
 * server cannot know the visitor's zone, and a first client render that used it would differ
 * from the HTML on every time it printed — a hydration mismatch, which React answers by
 * re-rendering from the root (use-session.ts says what that costs). So the browser's zone is a
 * `useSyncExternalStore` whose SERVER snapshot is `null`: React reads that snapshot on the server
 * and again for the hydrating render, and the real one only from the render after — the
 * moment the times switch. A client-side navigation mounts nothing new here (the provider sits
 * at the root), and a component mounted later reads the zone already in effect.
 *
 * The profile's zone comes from `useMe`, which is private and never server-rendered; the session
 * itself is held pending until hydration (use-session.ts), so it cannot arrive early either. Seoul
 * holds until `useMe` first stops pending — the session known and, for a member, `/me` answered —
 * so the times switch ONCE, straight to the zone that applies, rather than to the browser's zone
 * first and then to the member's pick two round trips later (`settledTimeZone`). Once settled the
 * zone is HELD while `useMe` is pending again (`holdTimeZone`): better-auth re-enters pending on
 * every session refetch of a signed-out tab, the focus refetch on each return to it included, and
 * Seoul there would flip every time on screen to KST and back. Only another viewer — a sign-in, a
 * sign-out, an account switch — starts over from Seoul (`displayTimeZone`). The browser store
 * never changes, so `subscribe` has nothing to do: a browser whose OS zone changes mid-visit is
 * read again on the next load.
 */

const TimeZoneContext = createContext<string>(SEOUL_TIME_ZONE);

/**
 * Whether the zone in effect is the viewer's own (`timeZoneSettled`) rather than Seoul standing in
 * for it: false on the server, in the hydrating render, until the profile is known, and under
 * `KstTimeZone` — so the judgement zone's second line (`DateTimeText`, #22, ADR-0098) is never in
 * the server's HTML, never drawn by the server's ICU, and never on an admin screen.
 */
const TimeZoneSettledContext = createContext<boolean>(false);

const noopSubscribe = () => () => undefined;
const beforeHydration = (): string | null => null;
const hydrated = () => true;
const notHydrated = () => false;

/**
 * Root provider (components/ui/provider.tsx): Seoul until the tab has hydrated AND the profile is
 * known (`useMe` no longer pending), then the effective zone, held through later refetches.
 */
export function TimeZoneProvider({ children }: { children: ReactNode }) {
  const browser = useSyncExternalStore<string | null>(
    noopSubscribe,
    browserTimeZone,
    beforeHydration,
  );
  const { data: session } = useSession();
  const viewer = session?.user.id ?? null;
  const { data: me, isPending } = useMe();
  const settled = settledTimeZone({ browser, viewer, profilePending: isPending, me });
  const [last, setLast] = useState<HeldTimeZone | null>(null);
  const held = holdTimeZone(last, viewer, settled);
  // Stored while rendering (react.dev, "Storing information from previous renders"), not in an
  // effect: `react-hooks/set-state-in-effect` is an error here, and an effect would commit once
  // more. The scope below already reads `held`; the state only carries it to the next render, and
  // React re-runs this component with it before any child renders. `holdTimeZone` answers
  // `last` itself when nothing changed, which is what stops the re-run.
  if (held !== last) setLast(held);
  return (
    <TimeZoneScope zone={displayTimeZone(held, viewer)} settled={timeZoneSettled(held, viewer)}>
      {children}
    </TimeZoneScope>
  );
}

/**
 * The zone everything inside reads times in, and whether it is the viewer's own (`settled`) —
 * what TimeZoneProvider and KstTimeZone hand down, and what a test renders a settled zone with
 * (the server's render never settles).
 */
export function TimeZoneScope({
  zone,
  settled,
  children,
}: {
  zone: string;
  settled: boolean;
  children: ReactNode;
}) {
  return (
    <TimeZoneContext.Provider value={zone}>
      <TimeZoneSettledContext.Provider value={settled}>{children}</TimeZoneSettledContext.Provider>
    </TimeZoneContext.Provider>
  );
}

/**
 * Seoul for everything inside, whatever the member picked: the admin layout wraps its pages in
 * this (ADR-0061 #60-8: 관리자 화면은 표시와 입력 모두 한국 시간이다). It reaches what the admin
 * screens borrow from the member screens — the preview's card and rules — while the admin's own
 * lists keep calling `formatKst` directly. Never settled, so the preview's rules draw no judgement
 * zone line (ADR-0093 decision 3 '#22 시간대': admin screens are KST alone).
 */
export function KstTimeZone({ children }: { children: ReactNode }) {
  return (
    <TimeZoneScope zone={SEOUL_TIME_ZONE} settled={false}>
      {children}
    </TimeZoneScope>
  );
}

/** The zone in effect here: Seoul outside any provider, on the server and in an admin page. */
export function useDisplayTimeZone(): string {
  return useContext(TimeZoneContext);
}

/**
 * `formatInTimeZone` bound to the zone in effect: what a member screen formats an absolute time
 * with. Remaining time ('마감 3일 2시간') is not an absolute time and does not go through here
 * (ADR-0061 #60-7).
 */
export function useFormatDateTime(): (iso: string) => string {
  const zone = useDisplayTimeZone();
  return useCallback((iso: string) => formatInTimeZone(iso, zone), [zone]);
}

export interface DateTimeTextProps {
  iso: string;
  /**
   * A market's 판정 기준 시간대 (#22, ADR-0098), for the rules' times: when it is another zone than
   * the one in effect, a second line under the time reads it in that zone too (ADR-0061 decision 1
   * item 8, ADR-0093 decision 3 '#22 시간대': 둘이 다를 때만 둘 다). Only once the zone is settled
   * (`TimeZoneSettledContext`): the server's HTML and the first client render hold the one KST
   * line, as every other time (ADR-0063), and an admin screen never draws the second.
   */
  judgementTimeZone?: string | null;
  /**
   * The row's test id: the viewer's line is `<testId>-viewer-zone` and the second one
   * `<testId>-judgement-zone`, so a test reads each line by its element. Without it, the bare text.
   */
  testId?: string;
}

/**
 * One absolute time as text, for a component that has no directive and must stay renderable by
 * a server component (rules-section.tsx): the hooks live here, the caller passes the instant —
 * and, for a market's rules, the zone it is judged in (`judgementTimeZone`). The second line is
 * labelled (`rulesJudgementZoneLine`): a Seoul time carries no marker, so beside a marked viewer's
 * line it would not say which zone it is in. Its zone is told apart by name (`judgementLineZone`).
 */
export function DateTimeText({ iso, judgementTimeZone, testId }: DateTimeTextProps) {
  const zone = useDisplayTimeZone();
  const settled = useContext(TimeZoneSettledContext);
  const viewer = formatInTimeZone(iso, zone);
  const second = settled ? judgementLineZone(zone, judgementTimeZone) : null;
  return (
    <>
      {testId === undefined ? viewer : <span data-testid={`${testId}-viewer-zone`}>{viewer}</span>}
      {second !== null && (
        <Text
          as="span"
          display="block"
          color="fg.muted"
          data-testid={testId === undefined ? undefined : `${testId}-judgement-zone`}
        >
          {copy.rulesJudgementZoneLine} {formatInTimeZone(iso, second)}
        </Text>
      )}
    </>
  );
}

/**
 * A zone's name as the settings select labels it (`timeZoneLabel`: `America/New_York — 미 동부
 * 시간`), for a component that must stay renderable by a server component (rules-section.tsx, the
 * 판정 기준 시간대 row, #22). The Korean name is the ICU's that renders it, so the server's HTML and
 * the hydrating render hold the IANA name alone — every visitor's bytes the same, no mismatch
 * between the server's ICU and the browser's (ADR-0063) — and the label follows after hydration.
 */
export function TimeZoneNameText({ zone }: { zone: string }) {
  const afterHydration = useSyncExternalStore(noopSubscribe, hydrated, notHydrated);
  return <>{afterHydration ? timeZoneLabel(zone) : zone}</>;
}
