/**
 * What the docs say of the interests step's first answer and its 24 hours (#41, ADR-0078 decision
 * 4, 7-8 (2) and 7-23; owner decision 2026-10-21 (3rd) answer 1), held to what the service does
 * (`OnboardingService.writeInterests`, whose answers onboarding.controller.test.ts and
 * public-items-sanctioned.test.ts test): within 24 hours of the nickname step the step's answer is
 * the first choice that a writing or an account restriction lets through; past them its picks are
 * MY 설정's change (refused under a restriction only) and its skip still answers the step, asked of
 * the onboarding alone (`assertOnboarded`) — not through `assertPublicItemOnboarding`, which every
 * other write of the step goes through. Static: it reads files, no database.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

const README = read('README.md');
const GUARDS = read('docs/GUARDS.md');
const DECISIONS = read('docs/DECISIONS.md');
const SERVICE = read('apps/api/src/onboarding/onboarding.service.ts');
const CONTROLLER = read('apps/api/src/onboarding/onboarding.controller.ts');

/** The text from `start` (included) to `end` (excluded) in `text`; throws when either is missing. */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  if (from === -1 || to === -1) throw new Error(`no "${start}" … "${end}" in the text`);
  return text.slice(from, to);
}

/** ADR-0078, to the next ADR or the end of docs/DECISIONS.md. */
const ADR = (() => {
  const start = DECISIONS.indexOf('\n## ADR-0078 ');
  const end = DECISIONS.indexOf('\n## ADR-', start + 1);
  return DECISIONS.slice(start, end === -1 ? undefined : end);
})();

/** ADR-0078 decision 7's item `n` (`7-n`), one line. */
function decision7(n: number): string {
  const section = between(ADR, '**7. 구현의 선택.**', '**8. 시험.**');
  const item = section.split('\n').find((line) => line.startsWith(`${n}. `));
  if (item === undefined) throw new Error(`ADR-0078 has no decision 7-${n}`);
  return item;
}

/** The JSDoc right above `anchor` in `source`, its lines joined with single spaces. */
function docAbove(source: string, anchor: string): string {
  const at = source.indexOf(anchor);
  if (at === -1) throw new Error(`no "${anchor}" in the source`);
  const doc = source.slice(source.lastIndexOf('/**', at), source.lastIndexOf('*/', at));
  return doc.replace(/\s*\n\s*\*\s?/g, ' ');
}

describe('the interests step’s first answer in the docs (ADR-0078, 3rd answer 1)', () => {
  it('says in README what the 24 hours decide wherever it names them: the first choice a restriction lets through, and past them MY 설정’s change and a skip that still answers the step', () => {
    const lines = README.split('\n').filter((line) => line.includes('닉네임 단계 뒤 24시간'));
    // The onboarding's bullet under the local services and the `/onboarding` row.
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toContain(
        '작성 제한·계정 제한 중에도 받는 첫 선택은 닉네임 단계 뒤 24시간 안의 답뿐',
      );
      expect(line).toContain('그 뒤의 고르기는 MY 설정의 바꾸기');
      // Under a writing restriction (#185, ADR-0082) a late pick is refused with its end, that
      // 건너뛰기 stays open (owner decision 2026-10-23 answer 9) and the way to 조치·신고 내역 (owner
      // decision 2026-10-22 evening); with none it is saved and answers the step.
      expect(line).toContain(
        "작성 제한 #185는 끝나는 때와 '건너뛰기는 할 수 있습니다.'(오너 결정 2026-10-23 답 9), 조치·신고 내역 링크로",
      );
      expect(line).not.toContain('이의 안내로');
      expect(line).toContain('제한이 없으면');
      expect(line).toContain('저장되고 단계를 답');
      expect(line).not.toContain('#185·#139 전에는');
      expect(line).toContain('건너뛰기는 그대로 단계를 답');
      expect(line).toContain('3차 답 1');
    }
    // The first wording named a deadline for the step's answer and nothing it changed, so a late
    // pick read as refused or dropped; the server saves it and answers the step.
    expect(README).not.toContain('그 단계의 첫 답으로 본다');
    expect(README).not.toContain('그 단계의 첫 답은 닉네임 단계 뒤 24시간 안에만');
  });

  it('turns down in ADR-0078 7-23 no timestamp that its (3) counts the 24 hours from', () => {
    const item = decision7(23);
    // (3) counts from the time the nickname step records, `nickname_confirmed_at`.
    expect(between(item, '(3) 서버의 기한', '고르지 않은 길')).toContain(
      '닉네임 단계(`nickname_confirmed_at`) 뒤 24시간',
    );
    const notChosen = item.slice(item.indexOf('고르지 않은 길'));
    // What was turned down is the nickname step's writing the interests step's own time too.
    expect(notChosen).toContain(
      '닉네임 단계가 관심 카테고리 단계의 시각(`interests_answered_at`)도 함께 남기는 것',
    );
    expect(notChosen).not.toContain('닉네임 단계가 시각을 남기는 것');
    expect(notChosen).not.toContain('nickname_confirmed_at');
  });

  it('names the check of the skip past the 24 hours, `assertOnboarded`, wherever the step route’s onboarding check is named', () => {
    // The service: the skip past the window asks the onboarding alone, every other write of the
    // step goes through the public items' two checks.
    const lateSkip = between(SERVICE, 'if (lateSkip) {', '} else {');
    expect(lateSkip).toContain('await assertOnboarded(tx, userId)');
    expect(lateSkip).not.toContain('assertPublicItem');
    expect(between(SERVICE, '} else {\n        let edit', '\n      }\n')).toContain(
      'await assertPublicItemOnboarding(tx, userId, edit)',
    );

    // ADR-0078 7-8 boundary (2): the unanswered step's empty list is `first` within the window
    // only.
    const boundary = between(decision7(8), ' (2) ', ' (3) ');
    expect(boundary).toContain('닉네임 단계 뒤 24시간 안이면 `first`');
    expect(boundary).toContain('그 뒤의 건너뛰기는 공개 항목의 새 값이 아니라 `assertOnboarded`만');
    expect(boundary).not.toContain('그 단계의 답(`first`, 7-10)');

    // docs/GUARDS.md, the new route's step 4.
    const step4 = GUARDS.split('\n').find((line) => line.startsWith('4. 온보딩을 마친 계정만'));
    expect(step4).toContain(
      '(`assertPublicItemOnboarding`, 24시간이 지난 단계의 건너뛰기는 공개 항목의 새 값이 아니라 `assertOnboarded`)',
    );

    // The route's own doc.
    const doc = docAbove(CONTROLLER, "@Post('onboarding/interests')");
    expect(doc).toContain('(`assertPublicItemOnboarding`)');
    expect(doc).toContain('for the skip past those hours');
    expect(doc).toContain('`assertOnboarded` alone');
  });
});
