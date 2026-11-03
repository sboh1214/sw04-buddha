import { describe, expect, it } from 'vitest';
import {
  MARKET_TAGS_MAX,
  TAG_NAME_MAX,
  marketTagsSchema,
  normalizeTagName,
  tagKey,
  tagNameSchema,
} from './tags.js';

describe('tag names (#17, ADR-0093 decision 2 #172 item 2)', () => {
  it('trims, NFC-normalises and collapses inner whitespace', () => {
    expect(normalizeTagName('  금리   인하 ')).toBe('금리 인하');
    expect(normalizeTagName('가')).toBe('가');
    expect(tagNameSchema.parse(' AI\t반도체 ')).toBe('AI 반도체');
  });

  it('makes names that differ only in case or surrounding spaces one tag', () => {
    expect(tagKey(' AI ')).toBe(tagKey('ai'));
    expect(tagKey('S&P500')).toBe('s&p500');
    expect(tagKey('금리')).not.toBe(tagKey('금리 인하'));
  });

  it('takes Korean, letters, digits and -_.&+· inside, and refuses the rest', () => {
    for (const name of ['AI', 'S&P500', 'K-팝', '2026 지방선거', 'C++', 'Web3.0', '한·미', '가']) {
      expect(tagNameSchema.safeParse(name).success, name).toBe(true);
    }
    for (const name of [
      '',
      '   ',
      '#AI',
      'AI,반도체',
      '-AI',
      'AI-',
      '이모지😀',
      'a/b',
      'x'.repeat(TAG_NAME_MAX + 1),
    ]) {
      expect(tagNameSchema.safeParse(name).success, name).toBe(false);
    }
    expect(tagNameSchema.safeParse('x'.repeat(TAG_NAME_MAX)).success).toBe(true);
  });
});

describe('a market’s tags', () => {
  it('may be empty (a draft) and at most MARKET_TAGS_MAX', () => {
    expect(marketTagsSchema.parse([])).toEqual([]);
    const five = ['a1', 'a2', 'a3', 'a4', 'a5'];
    expect(five).toHaveLength(MARKET_TAGS_MAX);
    expect(marketTagsSchema.parse(five)).toEqual(five);
    expect(marketTagsSchema.safeParse([...five, 'a6']).success).toBe(false);
  });

  it('refuses a second spelling of one tag, naming its index', () => {
    const result = marketTagsSchema.safeParse(['AI', '반도체', ' ai ']);
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: [2], message: 'duplicate tag' }),
    ]);
  });
});
