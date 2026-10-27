'use client';

import { Alert, Button, Field, HStack, Input, Link, Stack, Text } from '@chakra-ui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import NextLink from 'next/link';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { RealNameField } from '@/components/auth/real-name-field';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import {
  useConfirmPhoneVerification,
  useRequestVerificationCode,
} from '@/hooks/use-phone-verification';
import {
  codeRequestFailure,
  confirmFailure,
  formatCountdown,
  secondsLeft,
  verificationCodeFormSchema,
  verificationDetailsSchema,
  type VerificationCodeValues,
  type VerificationDetailsValues,
  type VerificationNotice,
} from '@/lib/phone-verification';

/** A span the server answered in seconds, and when that answer arrived (`performance.now()`). */
interface Span {
  seconds: number;
  from: number;
}

/** The countdowns move once a second, as the market countdown does (countdown-badge.tsx). */
const TICK_MS = 1000;

/**
 * The browser's monotonic clock. Read only in timer callbacks and in the submit handlers, after
 * an answer arrived — never in a render. A function of its own because the submit handlers are
 * built during the render (`handleSubmit(…)`), and the React Compiler's purity check reads a
 * clock called inside them as one called by the render itself.
 */
function monotonicNow(): number {
  return performance.now();
}

/**
 * Seconds left of the code's validity and of the resend wait, ticking once a second while
 * either runs. The browser is only asked for a DURATION (`performance.now()`, monotonic), and
 * the spans are the server's relative answers, so a wrong wall clock moves neither. The clock is
 * read in the timer callbacks and the submit handlers, never during a render, and `setClock` is
 * never called synchronously in the effect body (`react-hooks/set-state-in-effect`). Before the
 * first tick the clock is older than the span's start, which `secondsLeft` reads as "nothing has
 * elapsed yet".
 */
function useCountdowns(code: Span | null, resend: Span | null) {
  const [clock, setClock] = useState(0);
  const left = (span: Span | null) =>
    span === null ? 0 : secondsLeft(span.seconds, clock - span.from);
  const codeLeft = left(code);
  const resendLeft = left(resend);
  const running = codeLeft > 0 || resendLeft > 0;

  useEffect(() => {
    if (!running) return;
    const tick = () => {
      setClock(monotonicNow());
    };
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, TICK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [running]);

  return { codeLeft, resendLeft };
}

/** A notice above the forms: its look, its words and whether it is read out as an alert. */
type Notice = VerificationNotice;

/** The open code input: what the step knows of the code it confirms. */
interface CodeEntry {
  /**
   * The code's validity as this screen's send was answered, or null when the step has no answer
   * that says it — a code sent before a reload or in another tab, by a send whose answer never
   * arrived, or by one whose provider's answer was lost (SMS_SEND_UNCONFIRMED). No countdown
   * then: the server says whether the code still holds.
   */
  span: Span | null;
  /**
   * The name and the number are locked: this screen sent (or may have sent) the code with them,
   * and the confirmation records what the code was sent with. A code this screen did not ask for
   * leaves them open — it may have gone to another number than the one typed here.
   */
  locked: boolean;
  /**
   * What the notice says for as long as this code is tried, or null. A text that may have come
   * (SMS_SEND_UNCONFIRMED, or a send whose answer never arrived) stays said through every entry
   * refused under the input — a wrong code, an older one — so a member whose text never came still
   * reads that they can ask again later.
   */
  standing: Notice | null;
}

/**
 * 본인확인 (#183, ADR-0070) on one screen (ADR-0069 decision 1 #57-3): the real name and the
 * number, 인증번호 받기, then the six digits the text carried and 본인확인 완료.
 *
 * - Once a code is sent the name and the number are read-only: the confirmation verifies the
 *   number and records the name the code was SENT with, so an edit after sending would be an
 *   edit the server never sees. 실명·번호 다시 입력 opens both again (the code already sent is
 *   simply not used); 인증번호 다시 받기 sends a new code to the same number, which replaces the
 *   old one.
 * - Two countdowns, both from the server's answer: the code's validity (3 minutes, less what the
 *   server spent before answering) under the code input, and the resend wait (60 seconds) on the
 *   send button, which stays disabled until it is over. A refusal for the resend wait sets the
 *   same countdown from its `retryAfterSeconds`.
 * - A code this screen did not send can still be confirmed: the server checks the account's
 *   newest code whichever screen asked for it. 이미 받은 인증번호 입력 opens the code input for a
 *   code sent before a reload or in another tab; a refusal for the resend wait opens it by
 *   itself, since it says a code went out under a minute ago. Such a code has no countdown, and
 *   the name and the number stay open.
 * - A send whose answer was lost may have texted the code, and the server keeps it (owner
 *   decisions 2026-10-18): the provider's answer (SMS_SEND_UNCONFIRMED) or the API's own (the
 *   network dropped, a gateway's 5xx without the API's envelope, a timeout). The step says the
 *   text may have come — a warning, apart from the information of a sent code — opens the code
 *   input with the name and the number locked as for a sent code, and counts the send button
 *   down for the resend interval — but not the validity, which no answer gave. That notice stays
 *   while the code is tried: a refusal under the input (an older code typed because the new text
 *   never came) does not take away the line that says to ask again later.
 * - An older code typed after a resend is refused under the input (`superseded`) without
 *   spending an entry; only the newest confirms. After a resend whose outcome is unknown it is
 *   most likely the last text that came, and is answered so: type the last text's code, and ask
 *   again later if no new text comes (owner decision 2026-10-18, third round). Whether this
 *   screen's last send is such a send belongs to the screen, not to one opening of the code input
 *   (`lastSendUncertain`): the server checks the account's newest code however the input was
 *   opened, so the answer holds through 실명·번호 다시 입력 → 이미 받은 인증번호 입력 and through
 *   a send that sent nothing (a certain failure, a limit) until a send succeeds. A reload or
 *   another tab does not know it, and answers as after a resend that was sent — and so does this
 *   screen once a refusal for the resend wait tells it another tab has sent since (ADR-0070 7-32).
 * - What each refusal means is lib/phone-verification.ts's (`codeRequestFailure`,
 *   `confirmFailure`); what is said goes above the forms (`verification-notice`), except what
 *   belongs to one input — a wrong code with the entries it has left, an older code — which goes
 *   under it. The number another account verified goes under the number, which takes the focus,
 *   and in the notice too, whose `role=alert` reads it out (a message mounted under a field is
 *   not). The notices that open the code input — a text that may have come (a warning), a code
 *   sent under a minute ago (information) — are not errors but `role=alert` too: the cursor moves
 *   with them.
 * - A confirmation writes the record into `['me']` before it settles
 *   (`useConfirmPhoneVerification`), and the form above this step navigates on from there.
 */
export function VerificationStep() {
  const request = useRequestVerificationCode();
  const confirm = useConfirmPhoneVerification();
  // The code input, while a code may still be confirmed: opened by a send, by 이미 받은 인증번호
  // 입력 or by a resend-wait refusal; closed once the code can verify nothing.
  const [entry, setEntry] = useState<CodeEntry | null>(null);
  // How long the send button waits: the resend interval of the last send, or of a refusal.
  const [resend, setResend] = useState<Span | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Whether the account's newest code, as far as this screen knows, came from a send whose
  // outcome is unknown (the `maybe-sent` of `codeRequestFailure`) — so an older code typed now is
  // most likely the last text that came, not one a new text replaced (`confirmFailure`'s
  // `lastSendUncertain`, owner decision 2026-10-18, third round). Set by that send and cleared by
  // a send that succeeds, and by a refusal for the resend wait: the send button waits that minute
  // out after this screen's own sends, so such a refusal says a send this screen did not see
  // (another tab) made the newest code, whose outcome it does not know — as after a reload.
  // Nothing else changes the newest code, so nothing else touches it — not a send refused before
  // anything went (SMS_SEND_FAILED, a limit, a field), not 실명·번호 다시 입력, not the input
  // opened again by 이미 받은 인증번호 입력. A reload forgets it.
  const [lastSendUncertain, setLastSendUncertain] = useState(false);
  const { codeLeft, resendLeft } = useCountdowns(entry?.span ?? null, resend);
  const locked = entry?.locked === true;

  const details = useForm<VerificationDetailsValues>({
    resolver: zodResolver(verificationDetailsSchema),
    defaultValues: { realName: '', phone: '' },
  });
  const codeForm = useForm<VerificationCodeValues>({
    resolver: zodResolver(verificationCodeFormSchema),
    defaultValues: { code: '' },
  });

  // An opened code input — a new code, or one already received — takes the cursor.
  const { setFocus } = codeForm;
  useEffect(() => {
    if (entry !== null) setFocus('code');
  }, [entry, setFocus]);

  /** Opens the code input for a code this screen did not send. */
  const openForWaitingCode = () => {
    setEntry({ span: null, locked: false, standing: null });
    codeForm.reset({ code: '' });
  };

  /**
   * Closes the code input once its code can verify nothing. The cursor goes to the number rather
   * than to the page: the input that held it is gone, and Enter there asks for a new code.
   */
  const closeCode = () => {
    setEntry(null);
    codeForm.reset({ code: '' });
    details.setFocus('phone');
  };

  const onSend = details.handleSubmit(async (values) => {
    // The account the screen shows rides along (`expectedAccountId`, A-PG-24). Unreachable
    // while the button honours `ready`.
    const accountId = request.accountId;
    if (accountId === undefined) return;
    setNotice(null);
    try {
      const sent = await request.mutateAsync({ ...values, expectedAccountId: accountId });
      const from = monotonicNow();
      setEntry({ span: { seconds: sent.expiresInSeconds, from }, locked: true, standing: null });
      setLastSendUncertain(false);
      setResend({ seconds: sent.resendAfterSeconds, from });
      codeForm.reset({ code: '' });
      setNotice({ status: 'info', message: copy.verificationCodeSent });
    } catch (error) {
      const failure = codeRequestFailure(error);
      if (failure.kind === 'field') {
        setEntry(null);
        details.setError(failure.field, { message: failure.message });
        return;
      }
      if (failure.kind === 'maybe-sent') {
        // The text may have come: its code waits, with the name and the number it went to.
        setEntry({ span: null, locked: true, standing: failure.notice });
        setLastSendUncertain(true);
        setResend({ seconds: failure.resendAfterSeconds, from: monotonicNow() });
        codeForm.reset({ code: '' });
        setNotice(failure.notice);
        return;
      }
      if (failure.kind === 'resend-wait') {
        setResend({ seconds: failure.retryAfterSeconds, from: monotonicNow() });
        // A send of another screen is the newest code now, and this one does not know its outcome.
        setLastSendUncertain(false);
        if (entry === null) {
          // A code went out under a minute ago and this screen shows no input for it.
          openForWaitingCode();
          setNotice({ status: 'info', message: failure.codeWaitingMessage, urgent: true });
          return;
        }
      }
      // `verified`: the hook asked `['me']` again, and the form above moves on with it.
      setNotice({ status: 'error', message: failure.message });
    }
  });

  const onConfirm = codeForm.handleSubmit(async (values) => {
    const accountId = confirm.accountId;
    if (accountId === undefined) return;
    // What this code stands with stays (`CodeEntry.standing`); any other notice goes.
    setNotice(entry?.standing ?? null);
    try {
      await confirm.mutateAsync({ code: values.code, expectedAccountId: accountId });
      setNotice(null);
      toaster.create({ type: 'success', title: copy.verificationDone });
    } catch (error) {
      const failure = confirmFailure(error, { lastSendUncertain });
      switch (failure.kind) {
        case 'field':
          codeForm.setError('code', { message: failure.message }, { shouldFocus: true });
          return;
        case 'code-gone':
          // Nothing left to confirm: back to the send button, the number kept.
          setNotice({ status: 'error', message: failure.message });
          closeCode();
          return;
        case 'phone-in-use':
          setEntry(null);
          codeForm.reset({ code: '' });
          setNotice({ status: 'error', message: failure.message });
          details.setError('phone', { message: failure.message }, { shouldFocus: true });
          return;
        case 'verified':
        case 'notice':
          setNotice({ status: 'error', message: failure.message });
      }
    }
  });

  const onEdit = () => {
    setEntry(null);
    codeForm.reset({ code: '' });
    setNotice(null);
  };

  const onEnterWaitingCode = () => {
    openForWaitingCode();
    setNotice(null);
  };

  const detailErrors = details.formState.errors;
  const codeErrors = codeForm.formState.errors;
  const resendWait = resendLeft > 0 ? ` (${formatCountdown(resendLeft)})` : '';

  return (
    <Stack gap="5" data-testid="verification-step">
      {notice && (
        <Alert.Root
          status={notice.status}
          role={notice.status === 'error' || notice.urgent === true ? 'alert' : 'status'}
          data-status={notice.status}
          data-testid="verification-notice"
        >
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{notice.message}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      <form onSubmit={(e) => void onSend(e)} noValidate data-testid="verification-details-form">
        <Stack gap="4">
          <RealNameField
            registration={details.register('realName')}
            error={detailErrors.realName?.message}
            readOnly={locked}
          />
          <Field.Root invalid={!!detailErrors.phone} required readOnly={locked}>
            <Field.Label>{copy.phone}</Field.Label>
            <Input
              type="tel"
              inputMode="tel"
              autoComplete="tel-national"
              placeholder={copy.phonePlaceholder}
              maxLength={20}
              readOnly={locked}
              data-testid="verification-phone"
              {...details.register('phone')}
            />
            <Field.HelperText>{copy.phoneHint}</Field.HelperText>
            <Field.ErrorText>{detailErrors.phone?.message}</Field.ErrorText>
          </Field.Root>
          <HStack justify="flex-end" gap="2" wrap="wrap">
            {locked && (
              <Button
                type="button"
                variant="ghost"
                onClick={onEdit}
                data-testid="verification-edit"
              >
                {copy.verificationEdit}
              </Button>
            )}
            {entry === null && (
              <Button
                type="button"
                variant="ghost"
                onClick={onEnterWaitingCode}
                disabled={!confirm.ready}
                data-testid="verification-enter-code"
              >
                {copy.verificationCodeEnter}
              </Button>
            )}
            <Button
              type="submit"
              variant={locked ? 'outline' : 'solid'}
              loading={request.isPending}
              disabled={!request.ready || resendLeft > 0}
              data-testid="verification-send"
            >
              {`${locked ? copy.verificationResend : copy.verificationSend}${resendWait}`}
            </Button>
          </HStack>
        </Stack>
      </form>
      {entry !== null && (
        <form onSubmit={(e) => void onConfirm(e)} noValidate data-testid="verification-code-form">
          <Stack gap="4">
            <Field.Root invalid={!!codeErrors.code} required>
              <Field.Label>{copy.verificationCode}</Field.Label>
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                data-testid="verification-code"
                {...codeForm.register('code')}
              />
              <Field.HelperText>{copy.verificationCodeHint}</Field.HelperText>
              <Field.ErrorText>{codeErrors.code?.message}</Field.ErrorText>
            </Field.Root>
            {/* No live region: a line that changes every second would be read out every second.
                Only for a code whose send this screen was answered: of any other the server
                alone knows the age. */}
            {entry.span !== null && (
              <Text
                fontSize="sm"
                color={codeLeft > 0 ? 'fg.muted' : 'fg.error'}
                data-testid="verification-code-expiry"
              >
                {codeLeft > 0
                  ? `${copy.verificationExpiresIn} ${formatCountdown(codeLeft)}`
                  : copy.errVerificationCodeExpired}
              </Text>
            )}
            <Button
              type="submit"
              size="lg"
              loading={confirm.isPending}
              disabled={!confirm.ready}
              data-testid="verification-confirm"
            >
              {copy.verificationConfirm}
            </Button>
          </Stack>
        </form>
      )}
      <Text fontSize="sm" color="fg.muted">
        {/* A new tab: following it from a half-filled form must not throw the input away. */}
        <Link asChild colorPalette="brand" color="colorPalette.fg">
          <NextLink href="/privacy" target="_blank" rel="noopener">
            {copy.verificationPrivacyLink}
          </NextLink>
        </Link>
      </Text>
    </Stack>
  );
}
