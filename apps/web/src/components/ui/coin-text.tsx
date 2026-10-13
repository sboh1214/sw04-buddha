import { Text, type TextProps } from '@chakra-ui/react';
import { formatCoin } from '@buddha/shared';

/**
 * An amount of Coin as `formatCoin` writes it ('12,345 Coin'), kept on one line. The space before
 * the unit is an ordinary one (ADR-0051), so in a narrow value column 'Coin' could otherwise wrap
 * away from its number; `nowrap` holds the two together and leaves any break to the text around
 * the amount.
 */
export function CoinText({ amount, ...rest }: { amount: bigint } & Omit<TextProps, 'children'>) {
  return (
    <Text as="span" whiteSpace="nowrap" {...rest}>
      {formatCoin(amount)}
    </Text>
  );
}
