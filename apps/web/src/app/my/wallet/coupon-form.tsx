'use client';

import { Button, Card, Field, HStack, Input, Text } from '@chakra-ui/react';
import {
  COUPON_CODE_MAX_LENGTH,
  couponCodeSchema,
  formatCoin,
  parseCoinAmount,
} from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { isCouponRejection, useRedeemCoupon } from '@/hooks/use-wallet';
import { isApiError, isForAnotherAccount } from '@/lib/api';
import { isUnavailable } from '@/lib/payments';

/** The same code rules the API enforces; the message is the only thing localised here. */
const schema = z.object({ code: couponCodeSchema.catch('') }).refine((v) => v.code.length > 0, {
  message: copy.errCouponCode,
  path: ['code'],
});
type FormValues = z.infer<typeof schema>;

/**
 * Redeeming an admin-issued coupon (ADR-0026): Coin arrives as a BONUS ledger entry. Not drawn
 * while paid Coin is closed (PAID_COIN_SALES_ENABLED, ADR-0049; app/my/wallet/page.tsx).
 *
 * A redemption names the account the wallet was drawn for — the balance card's `Me`, read here
 * from the same `['me']` — never the session's (`useRedeemCoupon`, ADR-0091): in the render
 * between the session naming another account and SessionCacheGuard's reset the wallet still shows
 * A's balance, and a code sent as B's would be spent for B with B's cookie. The server refuses it
 * as another account's. The field and 등록 wait for that account (`GET /me`), so nothing is typed
 * before it is known, and the fields are keyed by it: `['me']` can also turn from A to B in place,
 * before the session does and so with no reset of SessionCacheGuard's (a window-focus refetch of
 * `GET /me` answered with B's cookie ahead of better-auth's session refetch, a realtime
 * resnapshot — ADR-0090 결정 4-2). Unkeyed, the code typed on A's wallet would stay with 등록 on,
 * now naming B — B's `Me` — with B's cookie: a one-use coupon spent for B. Keyed, the field starts
 * again empty for B.
 */
export function CouponForm() {
  const accountId = useMe().data?.id;
  return (
    <Card.Root data-testid="coupon-form">
      <Card.Header>
        <Text fontWeight="semibold">{copy.couponTitle}</Text>
      </Card.Header>
      <Card.Body>
        <CouponFields key={accountId ?? ''} accountId={accountId} />
      </Card.Body>
    </Card.Root>
  );
}

/** The code field and 등록, for the account the wallet was drawn for (none until it is known). */
function CouponFields({ accountId }: { accountId: string | undefined }) {
  const redeem = useRedeemCoupon();
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { code: '' } });

  const submit = handleSubmit(async ({ code }) => {
    // Unreachable while 등록 waits for the account.
    if (accountId === undefined) return;
    try {
      // The account the wallet was drawn for rides along (`expectedAccountId`, A-M2-9).
      const result = await redeem.mutateAsync({ code, expectedAccountId: accountId });
      toaster.create({
        type: 'success',
        title: copy.couponRedeemed,
        description: formatCoin(parseCoinAmount(result.amountCoin)),
      });
      reset({ code: '' });
    } catch (error) {
      // Only the two answers that are actually about the code the user typed belong under the
      // field. A 500, a missing balance row, a session that died with the tab open or an
      // unreachable API would otherwise call a perfectly good code invalid and send the user
      // looking for another one, when retrying is the only thing that could work.
      if (isForAnotherAccount(error)) {
        // The session was switched in another tab: nothing was redeemed; the guard refetches.
        toaster.create({ type: 'error', title: copy.sessionChanged });
      } else if (isApiError(error, 'DUPLICATE_REQUEST')) {
        setError('code', { message: copy.errCouponAlreadyUsed });
      } else if (isCouponRejection(error)) {
        setError('code', { message: copy.errCouponInvalid });
      } else if (isUnavailable(error)) {
        // The route is closed (ADR-0049): said without naming the feature.
        toaster.create({ type: 'error', title: copy.unavailable });
      } else {
        toaster.create({ type: 'error', title: copy.errUnknown });
      }
    }
  });

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <Field.Root invalid={!!errors.code} disabled={accountId === undefined}>
        <Field.Label>{copy.couponCode}</Field.Label>
        <HStack w="full" align="start">
          <Input
            autoComplete="off"
            autoCapitalize="characters"
            maxLength={COUPON_CODE_MAX_LENGTH}
            placeholder={copy.couponPlaceholder}
            data-testid="coupon-code"
            {...register('code')}
          />
          <Button
            type="submit"
            loading={isSubmitting}
            disabled={accountId === undefined}
            data-testid="coupon-submit"
          >
            {copy.couponSubmit}
          </Button>
        </HStack>
        <Field.HelperText>{copy.couponHint}</Field.HelperText>
        <Field.ErrorText>{errors.code?.message}</Field.ErrorText>
      </Field.Root>
    </form>
  );
}
