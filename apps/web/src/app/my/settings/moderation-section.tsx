import { Button } from '@chakra-ui/react';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { MY_MODERATION_PATH } from '@/lib/moderation';
import { SettingsSection } from './section';

/**
 * The way to 조치·신고 내역 (#50, ADR-0081; ADR-0069 decision 4 #50: «MY 아래 별도 화면(MY 탭은
 * 더하지 않고 MY 설정에서 연결)»): the actions operators took on the member and the results of the
 * member's reports. A link only — nothing personal is read here, so the card is drawn by the
 * server like the page around it.
 */
export function ModerationSection() {
  return (
    <SettingsSection
      title={copy.myModeration}
      hint={copy.myModerationHint}
      testId="settings-moderation"
    >
      <Button asChild size="sm" variant="outline" alignSelf="flex-start">
        <NextLink href={MY_MODERATION_PATH} data-testid="settings-moderation-open">
          {copy.myModerationOpen}
        </NextLink>
      </Button>
    </SettingsSection>
  );
}
