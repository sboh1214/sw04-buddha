import { Button } from '@chakra-ui/react';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { MY_CLOSURE_PATH } from '@/lib/account-closure';
import { SettingsSection } from './section';

/**
 * The way to 탈퇴 (#140, ADR-0086), the last card of MY 설정: a link to the confirmation screen,
 * where the Coin left and what refuses a closure now are read and the member types '탈퇴' (ADR-0069
 * decision 4 #140 «마지막 확인»). Nothing is closed from here, and nothing personal is read, so the
 * card is drawn by the server like the page around it.
 */
export function ClosureSection() {
  return (
    <SettingsSection title={copy.closureTitle} hint={copy.closureHint} testId="settings-closure">
      <Button asChild size="sm" variant="outline" colorPalette="no" alignSelf="flex-start">
        <NextLink href={MY_CLOSURE_PATH} data-testid="settings-closure-open">
          {copy.closureOpen}
        </NextLink>
      </Button>
    </SettingsSection>
  );
}
