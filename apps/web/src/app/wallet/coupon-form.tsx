'use client';

import { Button, Card, Field, HStack, Input, Text } from '@chakra-ui/react';
import { COUPON_CODE_MAX_LENGTH, couponCodeSchema, formatP, parsePAmount } from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useRedeemCoupon } from '@/hooks/use-wallet';
import { isApiError } from '@/lib/api';

/** The same code rules the API enforces; the message is the only thing localised here. */
const schema = z.object({ code: couponCodeSchema.catch('') }).refine((v) => v.code.length > 0, {
  message: copy.errCouponCode,
  path: ['code'],
});
type FormValues = z.infer<typeof schema>;

/** Redeeming an admin-issued coupon (ADR-0026): P arrives as a BONUS ledger entry. */
export function CouponForm() {
  const redeem = useRedeemCoupon();
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { code: '' } });

  const submit = handleSubmit(async ({ code }) => {
    try {
      const result = await redeem.mutateAsync(code);
      toaster.create({
        type: 'success',
        title: copy.couponRedeemed,
        description: formatP(parsePAmount(result.amountP)),
      });
      reset({ code: '' });
    } catch (error) {
      setError('code', {
        message: isApiError(error, 'DUPLICATE_REQUEST')
          ? copy.errCouponAlreadyUsed
          : copy.errCouponInvalid,
      });
    }
  });

  return (
    <Card.Root data-testid="coupon-form">
      <Card.Header>
        <Text fontWeight="semibold">{copy.couponTitle}</Text>
      </Card.Header>
      <Card.Body>
        <form onSubmit={(e) => void submit(e)} noValidate>
          <Field.Root invalid={!!errors.code}>
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
              <Button type="submit" loading={isSubmitting} data-testid="coupon-submit">
                {copy.couponSubmit}
              </Button>
            </HStack>
            <Field.HelperText>{copy.couponHint}</Field.HelperText>
            <Field.ErrorText>{errors.code?.message}</Field.ErrorText>
          </Field.Root>
        </form>
      </Card.Body>
    </Card.Root>
  );
}
