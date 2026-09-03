'use client';

import { Button, Card, Field, HStack, Input, Stack, Text } from '@chakra-ui/react';
import { CHARGE_MAX_P, CHARGE_MIN_P, CHARGE_PRESETS_P, formatP } from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useCharge } from '@/hooks/use-wallet';
import { isApiError } from '@/lib/api';

/**
 * The amount is typed as digits and validated against the same bounds the API enforces
 * (PLAN 17 Q3): it stays a string all the way to the request, because P is a bigint.
 */
const schema = z.object({
  amountP: z
    .string()
    .trim()
    .regex(/^\d+$/, copy.errChargeInteger)
    .refine((value) => {
      const amount = BigInt(value);
      return amount >= CHARGE_MIN_P && amount <= CHARGE_MAX_P;
    }, copy.errChargeRange),
});
type FormValues = z.infer<typeof schema>;

export function ChargeForm() {
  const charge = useCharge();
  const {
    register,
    handleSubmit,
    setValue,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { amountP: '' } });

  const submit = handleSubmit(async ({ amountP }) => {
    try {
      const result = await charge.mutateAsync(BigInt(amountP));
      toaster.create({
        type: 'success',
        title: copy.chargeDone,
        description: formatP(BigInt(result.balance.availableP)),
      });
      reset({ amountP: '' });
    } catch (error) {
      toaster.create({
        type: 'error',
        title: isApiError(error, 'VALIDATION_ERROR') ? copy.errChargeRange : copy.chargeFailed,
      });
    }
  });

  return (
    <Card.Root data-testid="charge-form">
      <Card.Header>
        <Text fontWeight="semibold">{copy.chargeTitle}</Text>
      </Card.Header>
      <Card.Body>
        <form onSubmit={(e) => void submit(e)} noValidate>
          <Stack gap="4">
            <HStack gap="2" flexWrap="wrap">
              {CHARGE_PRESETS_P.map((preset) => (
                <Button
                  key={preset.toString()}
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid={`charge-preset-${preset.toString()}`}
                  onClick={() =>
                    setValue('amountP', preset.toString(), {
                      shouldValidate: true,
                      shouldDirty: true,
                    })
                  }
                >
                  {formatP(preset)}
                </Button>
              ))}
            </HStack>
            <Field.Root invalid={!!errors.amountP} required>
              <Field.Label>{copy.chargeAmount}</Field.Label>
              <Input
                inputMode="numeric"
                autoComplete="off"
                placeholder={copy.chargeCustom}
                data-testid="charge-amount"
                {...register('amountP')}
              />
              <Field.HelperText>
                {formatP(CHARGE_MIN_P)} ~ {formatP(CHARGE_MAX_P)}
              </Field.HelperText>
              <Field.ErrorText>{errors.amountP?.message}</Field.ErrorText>
            </Field.Root>
            <Button
              type="submit"
              alignSelf="flex-start"
              loading={isSubmitting}
              data-testid="charge-submit"
            >
              {copy.chargeSubmit}
            </Button>
          </Stack>
        </form>
      </Card.Body>
    </Card.Root>
  );
}
