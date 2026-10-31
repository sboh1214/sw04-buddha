import { type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { SEOUL_TIME_ZONE, formatInTimeZone } from '@/lib/datetime';
import { timeZoneLabel } from '@/lib/time-zone';
import { byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { DateTimeText, KstTimeZone, TimeZoneNameText, TimeZoneScope } from './time-zone-provider';

const ISO = '2026-11-29T15:00:00.000Z';
const NEW_YORK = 'America/New_York';
const ROW = 'row';

const settledIn = (zone: string, node: ReactNode) => (
  <TimeZoneScope zone={zone} settled>
    {node}
  </TimeZoneScope>
);

/** The two lines' elements a render drew, by their test ids. */
const lines = (html: string) => testIdsStartingWith(html, `${ROW}-`);

/**
 * `DateTimeText`'s second line (#22, ADR-0098; ADR-0061 decision 1 item 8, ADR-0093 decision 3
 * '#22 시간대'): a market time read in its 판정 기준 시간대 too, only once the zone is settled and
 * only when the two zones differ by name — never in the server's HTML (ADR-0063) or on an admin
 * screen. Rendered to static markup, which is what the server and the first client render draw.
 */
describe('DateTimeText', () => {
  it('draws the one KST line outside a provider, as the server does, whatever the zone judged in', () => {
    const html = renderWithQueries(
      <DateTimeText iso={ISO} judgementTimeZone={NEW_YORK} testId={ROW} />,
    );
    expect(lines(html)).toEqual([`${ROW}-viewer-zone`]);
    expect(byTestId(html, `${ROW}-viewer-zone`)?.text).toBe(formatInTimeZone(ISO, SEOUL_TIME_ZONE));
    // No marker and no label: nothing in the server's HTML the server's ICU decided.
    expect(html).not.toContain('(GMT');
    expect(html).not.toContain(copy.rulesJudgementZoneLine);
  });

  it('is the bare text without a test id, as every time outside the rules is', () => {
    expect(renderWithQueries(<DateTimeText iso={ISO} />)).toBe(
      formatInTimeZone(ISO, SEOUL_TIME_ZONE),
    );
    expect(renderWithQueries(settledIn(NEW_YORK, <DateTimeText iso={ISO} />))).toBe(
      formatInTimeZone(ISO, NEW_YORK),
    );
  });

  it('adds the judgement zone, labelled, once settled in another zone', () => {
    const html = renderWithQueries(
      settledIn(
        NEW_YORK,
        <DateTimeText iso={ISO} judgementTimeZone={SEOUL_TIME_ZONE} testId={ROW} />,
      ),
    );
    expect(lines(html)).toEqual([`${ROW}-viewer-zone`, `${ROW}-judgement-zone`]);
    expect(byTestId(html, `${ROW}-viewer-zone`)?.text).toBe(formatInTimeZone(ISO, NEW_YORK));
    // Seoul carries no marker, so the label says which zone the line is in.
    expect(byTestId(html, `${ROW}-judgement-zone`)?.text).toBe(
      `${copy.rulesJudgementZoneLine} ${formatInTimeZone(ISO, SEOUL_TIME_ZONE)}`,
    );
    // Without a test id the lines are drawn all the same.
    const bare = renderWithQueries(
      settledIn(NEW_YORK, <DateTimeText iso={ISO} judgementTimeZone={SEOUL_TIME_ZONE} />),
    );
    expect(bare).toContain(
      `${copy.rulesJudgementZoneLine} ${formatInTimeZone(ISO, SEOUL_TIME_ZONE)}`,
    );
  });

  it('adds none for the same zone under another name, no zone, or one the engine cannot read', () => {
    for (const zone of [SEOUL_TIME_ZONE, 'ROK', null, undefined, 'Mars/Olympus_Mons']) {
      const html = renderWithQueries(
        settledIn(
          SEOUL_TIME_ZONE,
          <DateTimeText iso={ISO} judgementTimeZone={zone} testId={ROW} />,
        ),
      );
      expect(lines(html), String(zone)).toEqual([`${ROW}-viewer-zone`]);
    }
    // Same offset, another zone: Tokyo is not Seoul (ADR-0063), so it reads twice, marked.
    const tokyo = renderWithQueries(
      settledIn(
        SEOUL_TIME_ZONE,
        <DateTimeText iso={ISO} judgementTimeZone="Asia/Tokyo" testId={ROW} />,
      ),
    );
    expect(byTestId(tokyo, `${ROW}-judgement-zone`)?.text).toBe(
      `${copy.rulesJudgementZoneLine} ${formatInTimeZone(ISO, 'Asia/Tokyo')}`,
    );
  });

  it('adds none while unsettled, nor under the admin layout, which holds KST alone', () => {
    const unsettled = renderWithQueries(
      <TimeZoneScope zone={NEW_YORK} settled={false}>
        <DateTimeText iso={ISO} judgementTimeZone={SEOUL_TIME_ZONE} testId={ROW} />
      </TimeZoneScope>,
    );
    expect(lines(unsettled)).toEqual([`${ROW}-viewer-zone`]);
    // Even inside a settled provider: the admin layout wraps its pages, preview included.
    const admin = renderWithQueries(
      settledIn(
        NEW_YORK,
        <KstTimeZone>
          <DateTimeText iso={ISO} judgementTimeZone={NEW_YORK} testId={ROW} />
        </KstTimeZone>,
      ),
    );
    expect(lines(admin)).toEqual([`${ROW}-viewer-zone`]);
    expect(byTestId(admin, `${ROW}-viewer-zone`)?.text).toBe(
      formatInTimeZone(ISO, SEOUL_TIME_ZONE),
    );
    expect(admin).not.toContain('(GMT');
  });
});

describe('TimeZoneNameText', () => {
  it("holds the IANA name in the server's HTML; the Korean name follows hydration", () => {
    // Static markup is the server's render, and the hydrating render reads the same snapshot.
    expect(renderWithQueries(<TimeZoneNameText zone={NEW_YORK} />)).toBe(NEW_YORK);
    expect(renderWithQueries(<TimeZoneNameText zone="ROK" />)).toBe('ROK');
    // What it switches to: the settings select's label (`America/New_York — 미 동부 시간`).
    expect(timeZoneLabel(NEW_YORK).startsWith(`${NEW_YORK} — `)).toBe(true);
  });
});
