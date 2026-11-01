'use client';

import {
  ClientOnly,
  Field,
  Fieldset,
  Input,
  NativeSelect,
  Skeleton,
  type InputProps,
} from '@chakra-ui/react';
import { DEFAULT_JUDGEMENT_TIME_ZONE } from '@buddha/shared';
import { useMemo } from 'react';
import { type UseFormReturn } from 'react-hook-form';
import { copy } from '@/copy';
import { type MarketFormValues, timeRuleDeps } from '@/lib/market-form';
import { type TimeZoneOption, supportedTimeZones, timeZoneLabel } from '@/lib/time-zone';

interface MarketTimeFieldsProps {
  form: UseFormReturn<MarketFormValues>;
  /** Every input; true unless a draft's edit or a supplement's form (design 3.4, #80). */
  disabled: boolean;
  /**
   * A market past its open — the 규칙 보충 form (#80): the scheduled open and the scheduled judgement
   * are fixed once the market has opened (#172 item 14; ADR-0093 decision 3 '#21 앞당긴 개장'), set
   * or not — no supplement may change them (the API refuses either as 'not a supplement item').
   */
  fixed?: boolean;
  /**
   * The 규칙 보충 form of a PAUSED market (#80, #172 item 14): the close is fixed while trading is
   * paused (SUPPLEMENT_CLOSE_FIXED_WHILE_PAUSED), so its input is locked with a hint that says so.
   */
  closeLocked?: boolean;
  /**
   * The 선행 마감 gap the market is held to (`AdminMarket.leadCloseGapMinutes`): its minutes, or null
   * while the release setting is undecided. The edit form shows it under the announcement time;
   * 시장 만들기 has no market to read it from and passes nothing.
   */
  leadCloseGapMinutes?: number | null;
}

/** A `datetime-local` input in KST, as narrow as its value, so the hint under it can run wide. */
const TIME_INPUT: InputProps = { type: 'datetime-local', maxW: '56' };

/**
 * 시각 (#22, ADR-0098; ADR-0093 decision 2 #172 items 11–14): the market form's group after the
 * rule items, one input per time item in OPEN_ITEMS order — 예정 개장, 거래 마감, 발표 예정 and 예정
 * 판정 시각, each a `datetime-local` in KST like every admin time (decision 3 '#22 시간대'), then 판정
 * 기준 시간대. A draft saves with any of them blank but the close; the draft's notice names what 검수
 * 제출 still needs, 시각 순서 and 선행 마감 included. The scheduled open's hint says the market opens
 * by itself at that time once approved, or at its approval when that comes later (#21, ADR-0100).
 *
 * The announcement's blank is '없음', an event with no scheduled release (#172 item 13); its hint
 * says the close must lead it by the release setting's gap, and the edit form adds the gap the
 * market is held to ('선행 마감 간격: 60분', or 미정). The hints carry the owner's rules the form
 * cannot check: a match closes before kick-off, an election before the polls close (#172 item 13).
 *
 * Past the open (`fixed`, the 규칙 보충 form since #80) the scheduled open and judgement are locked,
 * as the API holds them, and the close only moves later, up to the scheduled judgement (owner
 * answer 2026-10-31 A2) — `supplementFormSchema` says so under the input — and not at all while
 * PAUSED (`closeLocked`). A broken rule's message stands under both of its inputs; after a submit
 * a change to either re-checks both (`timeRuleDeps`).
 */
export function MarketTimeFields({
  form,
  disabled,
  fixed = false,
  closeLocked = false,
  leadCloseGapMinutes,
}: MarketTimeFieldsProps) {
  const {
    register,
    formState: { errors },
  } = form;
  const gap =
    leadCloseGapMinutes === undefined
      ? undefined
      : `${copy.adminMarketLeadCloseGap}: ${
          leadCloseGapMinutes === null
            ? copy.adminMarketLeadCloseGapUndecided
            : `${String(leadCloseGapMinutes)}${copy.adminMarketLeadCloseGapMinutes}`
        }`;

  return (
    // A Field.Root's own `disabled` overrides the fieldset's in Chakra: each one below that sets
    // it (`fixed`, `closeLocked`) keeps `disabled` too, or a locked input is drawn as editable.
    <Fieldset.Root disabled={disabled} data-testid="market-times">
      <Fieldset.Legend fontWeight="semibold">{copy.adminMarketTimes}</Fieldset.Legend>
      <Fieldset.HelperText>{copy.adminMarketTimesHint}</Fieldset.HelperText>
      <Fieldset.Content gap="3" mt="2">
        <Field.Root invalid={!!errors.scheduledOpenAt} disabled={disabled || fixed}>
          <Field.Label>{copy.adminMarketScheduledOpenAt}</Field.Label>
          <Input
            {...TIME_INPUT}
            data-testid="market-scheduled-open-at"
            {...register('scheduledOpenAt', { deps: timeRuleDeps('scheduledOpenAt') })}
          />
          <Field.HelperText>
            {fixed ? copy.adminMarketTimeFixedHint : copy.adminMarketScheduledOpenAtHint}
          </Field.HelperText>
          <Field.ErrorText>{errors.scheduledOpenAt?.message}</Field.ErrorText>
        </Field.Root>

        <Field.Root invalid={!!errors.closeAt} required disabled={disabled || closeLocked}>
          <Field.Label>{copy.adminMarketCloseAt}</Field.Label>
          <Input
            {...TIME_INPUT}
            data-testid="market-close-at"
            {...register('closeAt', { deps: timeRuleDeps('closeAt') })}
          />
          <Field.HelperText>
            {closeLocked ? copy.adminMarketCloseLockedPausedHint : copy.adminMarketCloseAtHint}
          </Field.HelperText>
          <Field.ErrorText>{errors.closeAt?.message}</Field.ErrorText>
        </Field.Root>

        <Field.Root invalid={!!errors.scheduledAnnouncementAt}>
          <Field.Label>{copy.adminMarketScheduledAnnouncementAt}</Field.Label>
          <Input
            {...TIME_INPUT}
            data-testid="market-scheduled-announcement-at"
            {...register('scheduledAnnouncementAt', {
              deps: timeRuleDeps('scheduledAnnouncementAt'),
            })}
          />
          <Field.HelperText>{copy.adminMarketScheduledAnnouncementAtHint}</Field.HelperText>
          {gap !== undefined && (
            <Field.HelperText data-testid="market-lead-close-gap">{gap}</Field.HelperText>
          )}
          <Field.ErrorText>{errors.scheduledAnnouncementAt?.message}</Field.ErrorText>
        </Field.Root>

        <Field.Root invalid={!!errors.scheduledJudgementAt} disabled={disabled || fixed}>
          <Field.Label>{copy.adminMarketScheduledJudgementAt}</Field.Label>
          <Input
            {...TIME_INPUT}
            data-testid="market-scheduled-judgement-at"
            {...register('scheduledJudgementAt', { deps: timeRuleDeps('scheduledJudgementAt') })}
          />
          <Field.HelperText>
            {fixed ? copy.adminMarketTimeFixedHint : copy.adminMarketScheduledJudgementAtHint}
          </Field.HelperText>
          <Field.ErrorText>{errors.scheduledJudgementAt?.message}</Field.ErrorText>
        </Field.Root>

        <Field.Root invalid={!!errors.judgementTimeZone}>
          <Field.Label>{copy.adminMarketJudgementTimeZone}</Field.Label>
          {/* The browser's list exists only in the browser, and the server's render must not name
              a zone it might list differently (ADR-0063), as in MY 설정's select. */}
          <ClientOnly fallback={<Skeleton height="10" w="full" maxW="md" />}>
            <JudgementTimeZoneSelect form={form} />
          </ClientOnly>
          <Field.HelperText>{copy.adminMarketJudgementTimeZoneHint}</Field.HelperText>
          <Field.ErrorText>{errors.judgementTimeZone?.message}</Field.ErrorText>
        </Field.Root>
      </Fieldset.Content>
    </Fieldset.Root>
  );
}

/**
 * 판정 기준 시간대's select (#172 item 11: one zone, from the same list as the member's): every IANA
 * zone this browser knows, as MY 설정 offers them (`supportedTimeZones`, labelled `timeZoneLabel`),
 * without MY's '브라우저 시간대 따르기' row — a market's zone is never the viewer's. The form's value
 * is pre-filled (Asia/Seoul for a new market, and for a stored market with none,
 * `withJudgementTimeZonePrefilled`); a stored zone this browser does not list stays an option, so
 * the select shows the market's real zone and an untouched save does not change it.
 */
export function JudgementTimeZoneSelect({ form }: { form: UseFormReturn<MarketFormValues> }) {
  const supported = useMemo(() => supportedTimeZones(), []);
  // Only a value the list lacks changes the options: picking another listed zone keeps them.
  const value = form.watch('judgementTimeZone');
  const held = supported.includes(value) ? '' : value;
  const options = useMemo(() => judgementTimeZoneOptions(supported, held), [supported, held]);
  return (
    // `minW="0"`: a select is as wide as its longest option, which would push a phone page
    // sideways (MY 설정's select does the same).
    <NativeSelect.Root maxW="md" minW="0">
      <NativeSelect.Field
        data-testid="market-judgement-time-zone"
        {...form.register('judgementTimeZone')}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect.Field>
      <NativeSelect.Indicator />
    </NativeSelect.Root>
  );
}

/**
 * The zone select's options: `supported` (`supportedTimeZones()`), DEFAULT_JUDGEMENT_TIME_ZONE and
 * `held` — a zone the form holds that the list lacks ('' for none) — each once, sorted by IANA
 * name in code-unit order as MY 설정's are, valued by the name and labelled `timeZoneLabel`'s
 * '이름 — 한국어 이름'. No "follow the browser" row (`timeZoneOptions` has one; a market has no
 * browser).
 */
export function judgementTimeZoneOptions(
  supported: readonly string[],
  held: string,
  at: Date = new Date(),
): TimeZoneOption[] {
  const zones = new Set([...supported, DEFAULT_JUDGEMENT_TIME_ZONE]);
  if (held !== '') zones.add(held);
  return [...zones].sort().map((zone) => ({ value: zone, label: timeZoneLabel(zone, at) }));
}
