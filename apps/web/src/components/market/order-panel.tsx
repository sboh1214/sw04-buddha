'use client';

import {
  Alert,
  Box,
  Button,
  DataList,
  Field,
  HStack,
  Input,
  Link as ChakraLink,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import {
  type MarketStatusRejectReason,
  type OrderSide,
  type Outcome,
  ORDER_BUDGET_MAX_COIN,
  ORDER_QTY_MAX,
  PRICE_MAX,
  PRICE_MIN,
  formatCoin,
} from '@buddha/shared';
import NextLink from 'next/link';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { SignInPrompt } from '@/components/market/sign-in-prompt';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { formatContracts } from '@/lib/market-admin';
import { orderEntryPrice } from '@/lib/market-detail';
import { immediateFillNotice, quoteRows } from '@/lib/order-confirm';
import { bookReasonMessage } from '@/lib/order-book-view';
import {
  type FieldProblem,
  type OrderField,
  type OrderInput,
  bestPriceOf,
  blockOffersGtc,
  isBudgetInput,
  quoteRefused,
} from '@/lib/order-panel';
import {
  blockText,
  insufficientCoinLine,
  insufficientContractsLine,
  sellableLine,
} from '@/lib/order-reasons';
import { MY_MODERATION_PATH } from '@/lib/moderation';
import { OrderConfirm } from './order-confirm';
import { useOrderPanel } from './order-panel-provider';
import { OrderOutcome, RestrictedText } from './order-result';

/**
 * 주문 패널 (#66, ADR-0140): 계약 → 매수/매도 → 즉시 거래/지정가 → 수량·금액·한도가격 → 견적 →
 * 주문 확인 (N02 §6), then 확인, 접수 중 and the server's result in the same place — the column from
 * md up, the sheet below (`place`). The state is the provider's, so both places show one panel.
 *
 * Nothing personal is drawn while the session is unknown (the server's HTML and hydration) or,
 * for a member, before `me` and the restriction have answered: an admin or a restricted account
 * never gets a moment's field to type an order into (D13).
 */
export function OrderPanel({ place }: { place: 'column' | 'sheet' }) {
  const panel = useOrderPanel();
  const { state, viewer, accountKnown } = panel;
  const { step } = state;
  // Back from 확인 ('수정'): 입력 mounts again and gives the focus to 주문 확인. Decided while
  // rendering from the previous step (react.dev, "Storing information from previous renders").
  const [shownStep, setShownStep] = useState(step.name);
  const [backFromConfirm, setBackFromConfirm] = useState(false);
  // The input-closed line's id: the buttons it turns off point at it (aria-describedby).
  const closedId = useId();
  if (shownStep !== step.name) {
    setShownStep(step.name);
    setBackFromConfirm(shownStep === 'confirm' && step.name === 'editing');
  }
  // The restore's notice comes with the form, words and all, so its status role alone may not be
  // read: the column gives it the focus as the post draft's does (결정 2-19). Below md the sheet
  // opens on the restored contract and its own focus says where the reader is.
  const restoredRef = useRef<HTMLDivElement>(null);
  const restoredShown = state.restored && (step.name === 'editing' || step.name === 'signIn');
  useEffect(() => {
    if (restoredShown && place === 'column') restoredRef.current?.focus();
  }, [restoredShown, place]);
  // A member's `GET /me` that failed without ever answering (a 429 among them): said, with 다시
  // 시도, never a skeleton for good — and still no field to type into (D13).
  if (viewer === 'member' && panel.accountFailed) {
    return (
      <Stack gap="2" align="flex-start" data-testid="order-panel-failed">
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.errProfileLoad}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
        <Button size="sm" variant="outline" onClick={panel.retryAccount}>
          {copy.retry}
        </Button>
      </Stack>
    );
  }
  if (viewer === 'unknown' || !accountKnown) {
    return <Skeleton height="48" data-testid="order-panel-pending" />;
  }
  // `keep-all`: Korean breaks at spaces, never between two syllables ('지정가로', '1시간'), on
  // every line of the panel — 입력, 확인, 결과 and the read-back cards; `anywhere` still breaks a
  // token too long for the line (결정 2-23; app/charge/page.tsx's rule).
  return (
    <Stack
      as="section"
      aria-label={copy.orderPanelTitle}
      gap="4"
      wordBreak="keep-all"
      overflowWrap="anywhere"
      data-testid="order-panel"
      data-place={place}
    >
      {/* The gap's line: a notice with the weight of D13's account line, not a gray line of body
          text (결정 2-23). Its id is what the buttons it turns off point at. */}
      {panel.inputClosed !== null && (
        <Alert.Root
          id={closedId}
          status="warning"
          role="status"
          tabIndex={-1}
          outline="none"
          data-testid="order-input-closed"
        >
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{bookReasonMessage(panel.inputClosed)}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      <AccountLine id={accountLineId(place)} />
      {restoredShown && (
        <Alert.Root
          ref={restoredRef}
          status="info"
          role="status"
          tabIndex={-1}
          outline="none"
          data-testid="order-restored"
        >
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.orderRestored}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {step.name === 'editing' || step.name === 'signIn' ? (
        <OrderForm place={place} focusConfirm={backFromConfirm} closedId={closedId} />
      ) : step.name === 'confirm' ? (
        <OrderConfirm place={place} closedId={closedId} accountLineId={accountLineId(place)} />
      ) : (
        <OrderOutcome />
      )}
    </Stack>
  );
}

/** The account line's id in one place: the reason 주문 확인 is off points at it. */
function accountLineId(place: 'column' | 'sheet'): string {
  return `order-account-blocked-${place}`;
}

/**
 * D13: why 주문 확인 and the sell entry are off for an admin or a restricted account — the values
 * stay (owner answer 66-Q3). The restriction's line names its end and links to 조치·신고 내역.
 */
function AccountLine({ id }: { id: string }) {
  const { account, restrictionEndsAt } = useOrderPanel();
  const format = useFormatDateTime();
  if (account === null) return null;
  return (
    <Alert.Root
      id={id}
      status="warning"
      role="status"
      tabIndex={-1}
      outline="none"
      data-testid="order-account-blocked"
    >
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>
          {account === 'admin' ? (
            copy.orderAdmin
          ) : (
            <RestrictedText
              endsAtText={restrictionEndsAt === null ? null : format(restrictionEndsAt)}
            />
          )}
        </Alert.Description>
        {account === 'restricted' && (
          <ChakraLink asChild colorPalette="brand" color="colorPalette.fg" fontSize="sm">
            <NextLink href={MY_MODERATION_PATH}>{copy.myModeration}</NextLink>
          </ChakraLink>
        )}
      </Alert.Content>
    </Alert.Root>
  );
}

/**
 * One choice of a few, as pressed buttons (a toggle group): the words say which is chosen. A
 * button turned off points at the line that says why (`aria-describedby`): the gap's for the whole
 * group (`describedBy`), an option's own for one (D13's sell, 결정 2-23).
 */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  describedBy,
}: {
  label: string;
  value: T;
  options: {
    value: T;
    label: ReactNode;
    testId: string;
    disabled?: boolean;
    describedBy?: string;
  }[];
  onChange: (value: T) => void;
  disabled: boolean;
  /** The line that says why the group is off, while it is. */
  describedBy?: string;
}) {
  return (
    <HStack role="group" aria-label={label} gap="2">
      {options.map((option) => (
        <Button
          key={option.value}
          flex="1"
          size="sm"
          variant={value === option.value ? 'solid' : 'outline'}
          aria-pressed={value === option.value}
          disabled={disabled || option.disabled === true}
          aria-describedby={
            disabled ? describedBy : option.disabled === true ? option.describedBy : undefined
          }
          onClick={() => {
            onChange(option.value);
          }}
          data-testid={option.testId}
        >
          {option.label}
        </Button>
      ))}
    </HStack>
  );
}

/** The range line of a field: '1계약부터 1,000,000계약까지 입력할 수 있습니다.' */
function rangeText(field: OrderField): string {
  switch (field) {
    case 'qty':
      return `${formatContracts(1)}${copy.orderRangeFrom} ${formatContracts(ORDER_QTY_MAX)}${copy.orderRangeTo}`;
    case 'budget':
      return `${formatCoin(1)}${copy.orderRangeFrom} ${formatCoin(ORDER_BUDGET_MAX_COIN)}${copy.orderRangeTo}`;
    case 'limit':
      return `${formatCoin(PRICE_MIN)}${copy.orderRangeFrom} ${formatCoin(PRICE_MAX)}${copy.orderRangeTo}`;
  }
}

function problemText(field: OrderField, problem: FieldProblem | undefined): string | null {
  if (problem === undefined || problem === 'empty') return null;
  return problem === 'digits' ? copy.orderDigitsOnly : rangeText(field);
}

/** A number field: text with the numeric keyboard, never `type=number` (it eats '1,000'). */
function NumberField({
  field,
  label,
  unit,
  value,
  problem,
  disabled,
  onChange,
  testId,
}: {
  field: OrderField;
  label: string;
  unit: string;
  value: string;
  problem: FieldProblem | undefined;
  disabled: boolean;
  onChange: (text: string) => void;
  testId: string;
}) {
  const message = problemText(field, problem);
  return (
    <Field.Root invalid={message !== null} disabled={disabled}>
      <Field.Label>{label}</Field.Label>
      <HStack gap="2" w="full">
        <Input
          inputMode="numeric"
          enterKeyHint="done"
          autoComplete="off"
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          data-testid={testId}
        />
        <Text flexShrink={0} color="fg.muted" fontSize="sm">
          {unit}
        </Text>
      </HStack>
      {message !== null && <Field.ErrorText>{message}</Field.ErrorText>}
    </Field.Root>
  );
}

/**
 * A contract's button: its name and the best price the chosen direction meets (D2), or in the gap
 * the reason's short name rather than '호가 없음' (`orderEntryPrice`, 결정 2-23).
 */
function contractLabel(
  outcome: Outcome,
  side: OrderSide,
  best: number | null | undefined,
  closed: MarketStatusRejectReason | null,
) {
  return (
    <>
      {outcome === 'YES' ? copy.yes : copy.no}{' '}
      <Text as="span" fontVariantNumeric="tabular-nums" fontWeight="normal">
        {orderEntryPrice(best, closed) ?? ''}
      </Text>
      {/* The direction is the group's; the price says which side of the book it is. */}
      <Text as="span" srOnly>
        {side === 'buy' ? copy.marketBookAsks : copy.marketBookBids}
      </Text>
    </>
  );
}

/** 입력 and its quote, and for a visitor at 주문 확인 the sign-in line (D3). */
function OrderForm({
  place,
  focusConfirm,
  closedId,
}: {
  place: 'column' | 'sheet';
  focusConfirm: boolean;
  closedId: string;
}) {
  const panel = useOrderPanel();
  const { state, book, check, block, inputClosed, sellable, account } = panel;
  const { input } = state;
  const blockId = useId();
  const quoteFailedId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const blockRef = useRef<HTMLDivElement>(null);
  const signInRef = useRef<HTMLDivElement>(null);
  const signInMessageRef = useRef<HTMLParagraphElement>(null);
  const signIn = state.step.name === 'signIn';
  // 로그인 안내 replaces 주문 확인, which had the focus: the focus goes to the prompt's sentence
  // (`tabIndex=-1`) and the prompt — its 로그인 too — is scrolled into the column's or the sheet's
  // view, where at 375 it sat below the sheet's edge (결정 2-23). Only while the focus is still
  // the panel's (or nowhere): a width that crosses md mid-prompt does not take it from elsewhere.
  useEffect(() => {
    if (!signIn) return;
    const prompt = signInRef.current;
    if (prompt === null) return;
    const active = document.activeElement;
    const area =
      prompt.closest('[data-testid="order-sheet"]') ??
      prompt.closest('[data-testid="order-panel"]');
    if (active === null || active === document.body || area?.contains(active) === true) {
      signInMessageRef.current?.focus({ preventScroll: true });
    }
    prompt.scrollIntoView({ block: 'nearest' });
  }, [signIn]);
  // Back from 확인 ('수정'): the focus goes to 주문 확인 again. Where it is off — a 다시 견적 that
  // came back refused — the line that says why takes it, so the focus is never dropped (결정 2-19).
  useEffect(() => {
    if (!focusConfirm) return;
    const button = confirmRef.current;
    if (button !== null && !button.disabled) {
      button.focus();
      return;
    }
    const reason =
      blockRef.current ??
      document.getElementById(closedId) ??
      document.getElementById(accountLineId(place));
    reason?.focus();
  }, [focusConfirm, closedId, place]);
  const off = inputClosed !== null;
  const budget = isBudgetInput(input);
  const problems = check.ok ? {} : check.problems;
  const set = (patch: Partial<OrderInput>) => {
    panel.edit(patch);
  };
  const sellNone = block === 'sell_none';
  // D13: the account's line above says why (owner answer 66-Q3); no second line here.
  const accountBlock = block === 'admin' || block === 'restricted';
  // A quote read that failed is said even over older figures kept from the last answer — 주문
  // 확인's own read failing (a network error, a 429) included — and keeps 주문 확인 off until
  // 다시 견적 answers: those figures are no longer the terms' quote as it is (결정 2-13).
  const quoteFailedShown = !off && check.ok && panel.quoteFailed;
  const confirmOff =
    off ||
    block !== null ||
    check.ok !== true ||
    panel.opening ||
    quoteWaiting(panel) ||
    quoteFailedShown;
  // The lines that say why 주문 확인 is off: the gap's, the account's, the block's, the quote's.
  const offReasons = [
    off ? closedId : null,
    accountBlock ? accountLineId(place) : null,
    !off && block !== null && !accountBlock ? blockId : null,
    quoteFailedShown ? quoteFailedId : null,
  ].filter((id) => id !== null);
  return (
    <Stack gap="4">
      <Choice
        label={copy.orderContract}
        value={input.outcome}
        disabled={off}
        describedBy={closedId}
        onChange={(outcome) => {
          set({ outcome });
        }}
        options={(['YES', 'NO'] as const).map((outcome) => ({
          value: outcome,
          label: contractLabel(
            outcome,
            input.side,
            bestPriceOf(book, outcome, input.side),
            inputClosed,
          ),
          testId: `order-contract-${outcome === 'YES' ? 'yes' : 'no'}`,
        }))}
      />
      <Choice
        label={copy.orderSideGroup}
        value={input.side}
        disabled={off}
        describedBy={closedId}
        onChange={(side) => {
          set({ side });
        }}
        options={[
          { value: 'buy', label: copy.buy, testId: 'order-side-buy' },
          // D13: the sell entry is off for an account that may not order (owner answer 66-Q3),
          // and points at the account line that says why.
          {
            value: 'sell',
            label: copy.sell,
            testId: 'order-side-sell',
            disabled: account !== null,
            describedBy: accountLineId(place),
          },
        ]}
      />
      <Choice
        label={copy.orderKind}
        value={input.kind}
        disabled={off}
        describedBy={closedId}
        onChange={(kind) => {
          set({ kind });
        }}
        options={[
          { value: 'ioc', label: copy.orderKindIoc, testId: 'order-kind-ioc' },
          { value: 'gtc', label: copy.orderKindGtc, testId: 'order-kind-gtc' },
        ]}
      />
      {input.side === 'buy' && input.kind === 'ioc' && (
        <Choice
          label={copy.orderSizeGroup}
          value={input.size}
          disabled={off}
          describedBy={closedId}
          onChange={(size) => {
            set({ size });
          }}
          options={[
            { value: 'qty', label: copy.orderQty, testId: 'order-size-qty' },
            { value: 'budget', label: copy.orderBudgetInput, testId: 'order-size-budget' },
          ]}
        />
      )}
      {input.side === 'sell' && sellable !== undefined && (
        <Text fontSize="sm" color="fg.muted" data-testid="order-sellable">
          {sellableLine(sellable.unlockedQty, sellable.restingSellQty)}
        </Text>
      )}
      {budget ? (
        <NumberField
          field="budget"
          label={copy.orderBudgetInput}
          unit="Coin"
          value={input.budget}
          problem={problems.budget}
          disabled={off}
          onChange={(budgetText) => {
            set({ budget: budgetText });
          }}
          testId="order-budget"
        />
      ) : (
        <NumberField
          field="qty"
          label={copy.orderQty}
          unit={copy.unitContracts}
          value={input.qty}
          problem={problems.qty}
          // 매도 가능 0: nothing to type a quantity of (D11).
          disabled={off || sellNone}
          onChange={(qty) => {
            set({ qty });
          }}
          testId="order-qty"
        />
      )}
      {input.kind === 'gtc' && (
        <NumberField
          field="limit"
          label={copy.orderLimit}
          unit="Coin"
          value={input.limit}
          problem={problems.limit}
          disabled={off}
          onChange={(limit) => {
            set({ limit });
          }}
          testId="order-limit"
        />
      )}
      {!off && <QuoteBox failedId={quoteFailedId} />}
      {!off && block !== null && !accountBlock && (
        <Stack
          gap="2"
          role="status"
          id={blockId}
          ref={blockRef}
          tabIndex={-1}
          outline="none"
          data-testid="order-block"
          data-reason={block}
        >
          <Text fontSize="sm" color="fg.warning">
            {block === 'insufficient_contracts' && sellable !== undefined
              ? insufficientContractsLine(sellable.unlockedQty, sellable.restingSellQty)
              : blockText(block)}
          </Text>
          {blockOffersGtc(block) && (
            <Button
              size="xs"
              variant="outline"
              alignSelf="flex-start"
              onClick={() => {
                set({ kind: 'gtc', size: 'qty' });
              }}
              data-testid="order-switch-gtc"
            >
              {copy.orderSwitchToGtc}
            </Button>
          )}
        </Stack>
      )}
      {!off && panel.shortfall !== null && (
        <Text fontSize="sm" color="fg.warning" role="status" data-testid="order-shortfall">
          {insufficientCoinLine(panel.shortfall.availableCoin, panel.shortfall.needCoin)}
        </Text>
      )}
      {signIn ? (
        <Box ref={signInRef}>
          <SignInPrompt
            message={copy.orderSignIn}
            messageRef={signInMessageRef}
            data-testid="order-sign-in"
          />
        </Box>
      ) : (
        <Button
          ref={confirmRef}
          colorPalette="brand"
          disabled={confirmOff}
          loading={panel.opening}
          aria-describedby={offReasons.length > 0 ? offReasons.join(' ') : undefined}
          onClick={() => {
            void panel.openConfirm();
          }}
          data-testid="order-confirm-open"
        >
          {copy.orderConfirmOpen}
        </Button>
      )}
    </Stack>
  );
}

/** 주문 확인 waits for the quote of the terms as they are, except where the book alone decides. */
function quoteWaiting(panel: ReturnType<typeof useOrderPanel>): boolean {
  return panel.quote === undefined;
}

/**
 * The quote of the input (N01 §8): expected fill, average, payment or receipt, 최대 지출 and the
 * limit, with '현재 호가 기준 예상입니다'. Not a live region: it changes on every keystroke; the
 * lines that matter (a block, D8) are status lines of their own.
 */
function QuoteBox({ failedId }: { failedId: string }) {
  const { check, quote, quoteLoading, quoteFailed, retryQuote } = useOrderPanel();
  if (!check.ok) return null;
  // The reason 주문 확인 is off (its `aria-describedby`), with a way to ask again that needs no
  // edit: a book that does not move never reads it again by itself (결정 2-13·2-19). Shown over
  // the older figures too, when a read again failed and the last answer's are kept.
  const failed = quoteFailed ? (
    <HStack gap="3" flexWrap="wrap">
      <Text
        id={failedId}
        role="status"
        fontSize="sm"
        color="fg.muted"
        data-testid="order-quote-failed"
      >
        {copy.orderQuoteFailed}
      </Text>
      <Button size="xs" variant="outline" onClick={retryQuote} data-testid="order-quote-retry">
        {copy.orderRequote}
      </Button>
    </HStack>
  ) : null;
  if (quote === undefined) {
    if (failed !== null) return failed;
    return quoteLoading ? (
      <Skeleton height="16" data-testid="order-quote-loading" aria-label={copy.orderQuoteLoading} />
    ) : null;
  }
  // A refused quote carries the 99 or 1 it was asked with: no figure of it is shown, the block
  // line or the input-closed line says why (ADR-0140 결정 2-3·2-9).
  if (quoteRefused(check.terms, quote)) return failed;
  const quoted = { terms: check.terms, quote };
  const crossed = immediateFillNotice(quoted);
  return (
    <Box data-testid="order-quote">
      {failed !== null && <Box mb="2">{failed}</Box>}
      <DataList.Root orientation="horizontal" size="sm">
        {quoteRows(quoted).map((row) => (
          <DataList.Item key={row.id} data-testid={`order-quote-${row.id}`}>
            <DataList.ItemLabel>{row.label}</DataList.ItemLabel>
            <DataList.ItemValue fontVariantNumeric="tabular-nums">{row.value}</DataList.ItemValue>
          </DataList.Item>
        ))}
      </DataList.Root>
      {crossed !== null && (
        <Text
          mt="2"
          fontSize="sm"
          color="fg.warning"
          role="status"
          data-testid="order-immediate-notice"
        >
          {crossed}
        </Text>
      )}
      <Text mt="2" fontSize="xs" color="fg.muted">
        {copy.orderQuoteNotice}
      </Text>
    </Box>
  );
}
