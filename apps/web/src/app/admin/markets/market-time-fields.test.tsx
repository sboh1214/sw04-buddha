import { DEFAULT_JUDGEMENT_TIME_ZONE } from '@buddha/shared';
import { useForm } from 'react-hook-form';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { EMPTY_MARKET_FORM, type MarketFormValues } from '@/lib/market-form';
import { supportedTimeZones, timeZoneLabel } from '@/lib/time-zone';
import { byTagName, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import {
  JudgementTimeZoneSelect,
  MarketTimeFields,
  judgementTimeZoneOptions,
} from './market-time-fields';

interface DrawOptions {
  disabled?: boolean;
  fixed?: boolean;
  leadCloseGapMinutes?: number | null;
}

/** The group inside a form holding `values`, as the market form mounts it. */
function Fields({ values, options }: { values: MarketFormValues; options: DrawOptions }) {
  const form = useForm<MarketFormValues>({ defaultValues: values });
  return (
    <MarketTimeFields
      form={form}
      disabled={options.disabled ?? false}
      fixed={options.fixed}
      leadCloseGapMinutes={options.leadCloseGapMinutes}
    />
  );
}

const draw = (options: DrawOptions = {}, values: Partial<MarketFormValues> = {}) =>
  renderWithQueries(<Fields values={{ ...EMPTY_MARKET_FORM, ...values }} options={options} />);

/** The zone select alone, as the browser draws it once mounted. */
function Select({ values }: { values: MarketFormValues }) {
  const form = useForm<MarketFormValues>({ defaultValues: values });
  return <JudgementTimeZoneSelect form={form} />;
}

const drawSelect = (values: Partial<MarketFormValues> = {}) =>
  renderWithQueries(<Select values={{ ...EMPTY_MARKET_FORM, ...values }} />);

/** The time inputs, by test id, in the order they are drawn. */
const INPUTS = [
  'market-scheduled-open-at',
  'market-close-at',
  'market-scheduled-announcement-at',
  'market-scheduled-judgement-at',
];

/**
 * The market form's 시각 as drawn (#22, ADR-0098): one input per time item in OPEN_ITEMS order,
 * then the judgement time zone, the hints the form cannot check, and the open market's locks. What
 * the inputs hold on save is `marketFormSchema`'s (lib/market-form.test.ts).
 */
describe('MarketTimeFields', () => {
  it('draws a KST input per time in the open-items order, labelled with the item names', () => {
    const html = draw();
    expect(testIdsStartingWith(html, 'market-').filter((id) => INPUTS.includes(id))).toEqual(
      INPUTS,
    );
    for (const id of INPUTS) expect(byTestId(html, id)?.attributes.type, id).toBe('datetime-local');
    for (const label of [
      copy.adminMarketTimes,
      copy.adminMarketScheduledOpenAt,
      copy.adminMarketCloseAt,
      copy.adminMarketScheduledAnnouncementAt,
      copy.adminMarketScheduledJudgementAt,
      copy.adminMarketJudgementTimeZone,
    ]) {
      expect(html, label).toContain(label);
    }
    // Admin screens read and enter KST (ADR-0093 decision 3 '#22 시간대').
    for (const label of [
      copy.adminMarketScheduledOpenAt,
      copy.adminMarketCloseAt,
      copy.adminMarketScheduledAnnouncementAt,
      copy.adminMarketScheduledJudgementAt,
    ]) {
      expect(label).toContain('(KST)');
    }
  });

  it('says what the form cannot check in the hints (#172 items 12–14)', () => {
    const html = draw();
    // 없음 is a blank announcement; the sports and elections principle; no early open.
    expect(copy.adminMarketScheduledAnnouncementAtHint).toContain('없음');
    expect(copy.adminMarketCloseAtHint).toContain('경기는 시작 전');
    expect(copy.adminMarketCloseAtHint).toContain('선거는 투표 종료 전');
    expect(copy.adminMarketScheduledOpenAtHint).toContain('앞당기세요');
    for (const hint of [
      copy.adminMarketTimesHint,
      copy.adminMarketScheduledOpenAtHint,
      copy.adminMarketCloseAtHint,
      copy.adminMarketScheduledAnnouncementAtHint,
      copy.adminMarketScheduledJudgementAtHint,
      copy.adminMarketJudgementTimeZoneHint,
    ]) {
      expect(html, hint).toContain(hint);
    }
    // A late judgement is 판정 지연, never NO (#173 item 11).
    expect(copy.adminMarketScheduledJudgementAtHint).toContain('판정 지연');
    expect(copy.adminMarketScheduledJudgementAtHint).not.toMatch(/NO/);
  });

  it('draws the zone select only in the browser: the server names no zone (ADR-0063)', () => {
    // The server's render (this one) has the placeholder; the list is the browser's.
    expect(byTestId(draw(), 'market-judgement-time-zone')).toBeUndefined();
  });

  it('locks the scheduled open and judgement on an open market, and only those (C5)', () => {
    const open = draw({ fixed: true });
    expect(byTestId(open, 'market-scheduled-open-at')?.attributes).toHaveProperty('disabled');
    expect(byTestId(open, 'market-scheduled-judgement-at')?.attributes).toHaveProperty('disabled');
    expect(byTestId(open, 'market-close-at')?.attributes).not.toHaveProperty('disabled');
    expect(byTestId(open, 'market-scheduled-announcement-at')?.attributes).not.toHaveProperty(
      'disabled',
    );
    expect(open).toContain(copy.adminMarketTimeFixedHint);
    // A draft locks none.
    const draft = draw();
    for (const id of INPUTS) {
      expect(byTestId(draft, id)?.attributes, id).not.toHaveProperty('disabled');
    }
    expect(draft).not.toContain(copy.adminMarketTimeFixedHint);
  });

  it('shows the gap the edited market is held to under the announcement, or 미정', () => {
    // 시장 만들기 knows no market's gap.
    expect(byTestId(draw(), 'market-lead-close-gap')).toBeUndefined();
    expect(byTestId(draw({ leadCloseGapMinutes: 60 }), 'market-lead-close-gap')?.text).toBe(
      `${copy.adminMarketLeadCloseGap}: 60${copy.adminMarketLeadCloseGapMinutes}`,
    );
    expect(byTestId(draw({ leadCloseGapMinutes: null }), 'market-lead-close-gap')?.text).toBe(
      `${copy.adminMarketLeadCloseGap}: ${copy.adminMarketLeadCloseGapUndecided}`,
    );
  });

  it('is off as a whole when the market is locked', () => {
    expect(byTestId(draw({ disabled: true }), 'market-times')?.attributes).toHaveProperty(
      'disabled',
    );
  });
});

describe('JudgementTimeZoneSelect', () => {
  it("offers MY 설정's zones by IANA and Korean name, without its follow-the-browser row", () => {
    const options = byTagName(drawSelect(), 'option');
    const values = options.map((option) => option.attributes.value);
    expect(values).not.toContain('');
    expect(values).toContain(DEFAULT_JUDGEMENT_TIME_ZONE);
    expect(values).toContain('America/New_York');
    // Every zone this engine lists, each once, sorted as MY 설정 sorts them.
    expect(values).toEqual(
      [...new Set([...supportedTimeZones(), DEFAULT_JUDGEMENT_TIME_ZONE])].sort(),
    );
    const seoul = options.find((option) => option.attributes.value === DEFAULT_JUDGEMENT_TIME_ZONE);
    expect(seoul?.text).toBe(timeZoneLabel(DEFAULT_JUDGEMENT_TIME_ZONE));
    expect(options.map((option) => option.text).join('\n')).not.toContain(
      copy.timeZoneFollowBrowser,
    );
  });

  it("keeps a stored zone this browser does not list, so the select shows the market's own", () => {
    const values = byTagName(drawSelect({ judgementTimeZone: 'US/Eastern' }), 'option').map(
      (option) => option.attributes.value,
    );
    expect(values).toContain('US/Eastern');
  });
});

describe('judgementTimeZoneOptions', () => {
  const at = new Date('2026-10-31T00:00:00.000Z');

  it('lists the zones sorted, each once, with the default and a held one added', () => {
    expect(
      judgementTimeZoneOptions(['UTC', 'America/New_York'], '', at).map(({ value }) => value),
    ).toEqual(['America/New_York', 'Asia/Seoul', 'UTC']);
    expect(
      judgementTimeZoneOptions(['Asia/Seoul', 'UTC'], 'ROK', at).map(({ value }) => value),
    ).toEqual(['Asia/Seoul', 'ROK', 'UTC']);
    // A browser without `Intl.supportedValuesOf` still offers the default to confirm.
    expect(judgementTimeZoneOptions([], '', at)).toEqual([
      { value: 'Asia/Seoul', label: timeZoneLabel('Asia/Seoul', at) },
    ]);
  });
});
