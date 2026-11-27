import { copy } from '../src/copy';
import { E2E_CONSENT_VERSIONS } from './consent-versions';
import { expect, expectNoSideScroll, test } from './helpers';

/**
 * The three legal documents as #137 revised them (ADR-0176): each opens from the footer with its
 * 시행일 under the title and the versions that took effect after the 부칙, and each version is a
 * page of its own (`/terms/<시행일>`, owner answer 137-2c) — a date no version has is not found.
 * The terms and the privacy item are agreed to at the version their 시행일 names (#57-5), so the
 * consent step's versions are the dates these pages show.
 */

const DOCUMENTS = [
  { kind: 'terms', title: copy.legalTermsTitle, consent: E2E_CONSENT_VERSIONS.terms },
  { kind: 'privacy', title: copy.legalPrivacyTitle, consent: E2E_CONSENT_VERSIONS.privacy },
  { kind: 'refund', title: copy.legalRefundTitle, consent: undefined },
] as const;

/** `2026-11-28` as the documents write it: `2026년 11월 28일`. */
function dateText(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return `${String(year)}년 ${String(month)}월 ${String(day)}일`;
}

test.describe('약관·방침·환불정책과 판 목록 (#137)', () => {
  for (const { kind, title, consent } of DOCUMENTS) {
    test(`${title}: 시행일과 시행한 판, 판마다의 주소`, async ({ page }) => {
      await page.goto('/');
      await page.getByTestId('site-footer').getByTestId(`footer-link-${kind}`).click();
      await expect(page).toHaveURL(`/${kind}`);
      const document = page.getByTestId(`legal-${kind}`);
      await expect(document.getByRole('heading', { level: 2, name: title })).toBeVisible();

      // The 시행일 under the title, as the consent records name it.
      const effective = document.getByTestId(`legal-${kind}-effective-date`);
      await expect(effective).toHaveText(
        new RegExp(
          `^${copy.legalEffectiveDate.replace('{date}', '\\d{4}년 \\d{1,2}월 \\d{1,2}일')}$`,
        ),
      );
      if (consent !== undefined) {
        await expect(effective).toHaveText(
          copy.legalEffectiveDate.replace('{date}', dateText(consent)),
        );
      }
      await expect(document.getByTestId(`legal-${kind}-past-version`)).toHaveCount(0);

      // The versions after the 부칙: one so far, the current one, not a link on its own page.
      const versions = document.getByTestId(`legal-${kind}-versions`);
      await expect(versions.getByRole('heading', { name: copy.legalVersions })).toBeVisible();
      const items = versions.getByRole('listitem');
      await expect(items).toHaveCount(1);
      await expect(items.first()).toContainText(copy.legalVersionCurrent);
      await expect(items.first().getByRole('link')).toHaveCount(0);
      await expectNoSideScroll(page);

      // The same version at its own address.
      const shown = (await effective.textContent()) ?? '';
      const [, year, month, day] = /(\d{4})년 (\d{1,2})월 (\d{1,2})일/.exec(shown) ?? [];
      const date = `${year!}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`;
      const response = await page.goto(`/${kind}/${date}`);
      expect(response?.status()).toBe(200);
      await expect(page.getByTestId(`legal-${kind}-effective-date`)).toHaveText(shown);
      await expect(page.getByTestId(`legal-${kind}-versions`).getByRole('listitem')).toHaveCount(1);

      // The drafts never took effect: no page.
      const draft = await page.goto(`/${kind}/draft-2026-10-18`);
      expect(draft?.status()).toBe(404);
    });
  }
});
