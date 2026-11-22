import * as z from 'zod';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_PARAM_KEY_PATTERN,
  NOTIFICATION_TARGET_KINDS,
  NOTIFICATION_TYPE_PATTERN,
  type NotificationDefinition,
  type NotificationType,
} from '../notifications.js';
import {
  findExcludedIdentifier,
  findExcludedText,
  type ExcludedIdentifierHit,
  type ExcludedTextHit,
} from './excluded.js';

/**
 * The notification types, registered for the excluded-feature check (#113). The product's list
 * is NOTIFICATION_DEFINITIONS (notifications.ts, #53, ADR-0157), and this registry is keyed by it
 * exactly as REALTIME_EVENT_REGISTRY is by the event types: a type defined without its entry here,
 * or an entry left behind for a removed type, fails to compile. Each entry holds every text a
 * person reads in the type — its title and body as the web's renderer words them, placeholders as
 * written — and why it exists. N05 §4 leaves score, ranking, Forecast-edit and paid-Coin purchase
 * notifications out of the initial product, and guards/notifications.test.ts fails on a type that
 * names any excluded feature (EXCLUDED_FEATURES), as a name or in its text. #53 shipped no type
 * (52-20); #134 registers the 거래 three (ADR-0158), #54 the 시장 five (ADR-0159, the wording of
 * 54-1 — owner's answer of 2026-11-22), #188 the 판정·정산 six (ADR-0160, the wording of 188-1 —
 * owner's answer of 2026-11-22). The web's renderer words a type from its
 * copy (`NOTIFICATION_RENDERERS[type].copy`), whose entries equal `text` here, in order
 * (apps/web lib/notifications.test.ts): whole sentences with single-brace placeholders the web
 * fills, and the words it fills some of them with. docs/GUARDS.md has the registration rule.
 */
export interface NotificationTypeText {
  /** Every text a person reads in it: the title and the body, placeholders as written. */
  readonly text: readonly string[];
  /** What it tells, and the plan section and owner answer it comes from. */
  readonly reason: string;
}

export const NOTIFICATION_TYPE_REGISTRY = {
  order_filled: {
    // 134-3: the last two sentences when the notice does not hold every fill of the order.
    text: [
      '{market} {contract} 주문 {state} · {qty}계약 · 평균 {price}',
      '{market} {contract} 주문 {state} · 체결 {count}회 · 누적 {qty}계약 · 평균 {price}',
      '{market} {contract} 주문 {state} · 이번 {qty}계약 · 평균 {price} (주문 {orderQty}계약 중 {orderFilledQty}계약 체결)',
      '{market} {contract} 주문 {state} · 체결 {count}회 · 이번 {qty}계약 · 평균 {price} (주문 {orderQty}계약 중 {orderFilledQty}계약 체결)',
      '부분 체결',
      '전량 체결',
      'YES',
      'NO',
      '매수',
      '매도',
    ],
    reason:
      '대기하던 내 주문에 나중에 생긴 체결(부분·전량) — 같은 주문의 체결은 읽기 전까지 한 알림에 합치고 횟수·누적 수량·평균 가격을 싣는다. 읽은 뒤의 체결은 새 알림이고, 알림의 수량이 주문의 누적 체결과 다르면 주문 전체(주문 수량 중 체결 수량)를 함께 보인다. N05 §4, ADR-0158, 52-2·52-6, 134-1·134-2·134-3',
  },
  orders_cancelled: {
    text: [
      '{market} 일시 중단으로 대기 주문 {count}건 취소',
      '{reason}으로 대기 주문 {count}건 취소(시장 {markets}곳)',
      '관리자 권한',
      '계정 제한',
    ],
    reason:
      '내가 하지 않은 대기 주문의 일괄 취소(일시 중단·관리자 권한·계정 제한) — 사건마다 한 건. N05 §4, ADR-0158, 52-3·52-4',
  },
  orders_expired: {
    text: [
      '{market} 거래 마감으로 대기 주문 {count}건 만료',
      '{market} 시장 취소로 대기 주문 {count}건 만료',
    ],
    reason:
      '거래 마감·시장 취소로 끝난 대기 주문 — 회원·시장마다 한 건. N05 §4, ADR-0158, 52-4·52-5',
  },
  market_closed: {
    text: ['{market} 거래 마감', '{market} 거래 조기 마감'],
    reason:
      '관심·보유 시장의 거래 마감(예정 마감, 일시 중단 중에 맞은 예정 마감, 조기 마감) — 그 순간에 한 건. N05 §4, ADR-0159, 52-1·52-8',
  },
  market_paused: {
    // The three pause labels fill `{reason}` (the 공개 판정 기록's, 52-9).
    text: [
      '{market} 거래 일시 중단 · 사유: {reason}',
      '사건 선공개(조기 결과)',
      '담보·원장 장애',
      '실질 기준 변경',
    ],
    reason:
      '관심·보유 시장의 전체 거래 일시 중단(시스템의 원장 장애 중단 포함)과 공개 사유 라벨. N05 §4, N03 §3, ADR-0159, 52-1·52-9',
  },
  market_resumed: {
    text: [
      '{market} 거래 재개 · 중단 사유: {reason}',
      '사건 선공개(조기 결과)',
      '담보·원장 장애',
      '실질 기준 변경',
    ],
    reason: '일시 중단된 관심·보유 시장의 거래 재개 — 중단 알림과 같은 대상. ADR-0159, 52-9',
  },
  market_cancelled: {
    text: ['{market} 시장 취소'],
    reason: '사용자 체결 없이 취소되거나 개장 전에 취소된 관심 시장. ADR-0159, 52-5',
  },
  market_rules_supplemented: {
    // 'v' fills `{version}` with the version's number ('v3', the detail's version history name).
    text: ['{market} 규칙 보충 {version} · 사유: {reason}', 'v'],
    reason:
      '개장 뒤 판정 항목·거래 마감이 바뀐 규칙 보충 — 버전과 공개 사유. N05 §4, N03 §4, ADR-0159, 52-10',
  },
  // #188 (ADR-0160, 188-1). The second line of a timed notice is '판정 기준 시간대 <time>' when the
  // market's zone differs from the member's (the detail's rule, 52-15); the result labels fill
  // `{result}` and the decision labels `{decision}`.
  market_judgement_delayed: {
    text: ['{market} 판정 지연 · 다음 검토 {nextReview} · 사유: {reason}', '판정 기준 시간대'],
    reason:
      '관심·보유 시장의 판정 지연 기록(처음과, 사유나 다음 검토 시각이 바뀐 기록) — 공개 지연 사유와 다음 검토 시각. N05 §4, N03 §4, ADR-0160, 52-1·52-11·52-15·188-5',
  },
  market_provisional_result: {
    text: [
      '{market} 잠정 결과: {result} · 이의 기한 {deadline}',
      'YES',
      'NO',
      '무효',
      '판정 기준 시간대',
    ],
    reason:
      '관심·보유 시장의 잠정 결과(YES·NO·무효)와 이의 기한. N05 §4, N03 §5, ADR-0160, 52-1·52-12·52-13·52-15',
  },
  market_judgement_corrected: {
    text: [
      '{market} 판정 정정 · 잠정 결과: {result} · 새 이의 기한 {deadline}',
      'YES',
      'NO',
      '무효',
      '판정 기준 시간대',
    ],
    reason:
      '지급 전 판정 정정 — 정정된 잠정 결과와 새 이의 기한, 같은 관심·보유 대상. N03 §7, ADR-0160, 52-12·52-14',
  },
  market_dispute_decided: {
    text: ['{market} 판정 이의 {decision} · 사유: {reason}', '기각', '수용'],
    reason:
      '내가 낸 판정 이의의 기각·수용과 공개 처리 사유 — 제출자에게. N03 §5, ADR-0160, 52-14·188-3',
  },
  market_dispute_closed_by_correction: {
    text: ['{market} 판정 이의 정정으로 종결 · 새 이의 기한 {deadline}', '판정 기준 시간대'],
    reason: '정정으로 종결된 내 판정 이의와 새 이의 기한 — 제출자에게. N03 §7, ADR-0160, 52-14',
  },
  market_settled: {
    // The second sentence for a watcher who held nothing at the payout (`payoutCoin` null).
    text: [
      '{market} 결과 확정: {result} · 지급 완료 · 내 지급액 {payout}',
      '{market} 결과 확정: {result} · 지급 완료',
      'YES',
      'NO',
      '무효',
    ],
    reason:
      '관심·보유 시장의 최종 정산 — 지급이 끝난 때 확정 결과와 지급 완료를 나눠 적고 보유자에게는 자기 지급액(0 포함, 손익 없음). 무효 지급은 환불이 아니다. N05 §4, N03 §5·§6, ADR-0160, 52-1·52-12·52-15',
  },
} as const satisfies Record<NotificationType, NotificationTypeText>;

/** One registered type with its name: what the excluded-feature check reads. */
export interface NotificationTypeEntry extends NotificationTypeText {
  /** The type as the API and its stored rows name it. */
  readonly type: string;
}

export const NOTIFICATION_TYPES: readonly NotificationTypeEntry[] = Object.entries(
  NOTIFICATION_TYPE_REGISTRY as Readonly<Record<string, NotificationTypeText>>,
).map(([type, entry]) => ({ type, ...entry }));

export type NotificationHit = ExcludedIdentifierHit | ExcludedTextHit;

/**
 * The excluded features a notification type names. Its name is an API value, so it is held to
 * the API's tokens (paid purchase included, N05 §4); its text is screen text.
 */
export function findExcludedNotification(entry: NotificationTypeEntry): NotificationHit[] {
  return [
    ...findExcludedIdentifier(entry.type, 'api'),
    ...entry.text.flatMap((text) => findExcludedText(text)),
  ];
}

/**
 * Parameter names that would store another member's identity (ADR-0157, 52-15, ADR-0086): a type
 * that shows one — a reply's author — reads it through its target when the list is read, so a
 * closed member's '탈퇴한 사용자' and a forced nickname change show at once and nothing of theirs
 * stays in other members' inboxes.
 */
export const NOTIFICATION_IDENTITY_PARAM =
  /user|account|counterparty|publicId|nickname|author|email|phone/i;

/** The JSON Schema `type`s a flat parameter may take. */
const FLAT_JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null']);

/** Whether a field's JSON Schema takes flat values only: a primitive, a union of them, an enum. */
function isFlat(schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object') return false;
  const node = schema as Record<string, unknown>;
  for (const union of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(node[union])) return (node[union] as unknown[]).every(isFlat);
  }
  if (Array.isArray(node.enum)) {
    return node.enum.every((value) => value === null || typeof value !== 'object');
  }
  if ('const' in node) return node.const === null || typeof node.const !== 'object';
  const types = Array.isArray(node.type) ? (node.type as unknown[]) : [node.type];
  return types.length > 0 && types.every((type) => FLAT_JSON_TYPES.has(String(type)));
}

/**
 * What breaks the rules every notification definition keeps (ADR-0157 결정 2·3): a type outside
 * NOTIFICATION_TYPE_PATTERN or listed twice, a category outside the list, no target or a target
 * kind not in the union, params that are not a flat object of string, number, boolean or null
 * fields, a parameter name outside NOTIFICATION_PARAM_KEY_PATTERN or one that names another
 * account or its identity (NOTIFICATION_IDENTITY_PARAM), and a `merge` that is neither null nor a
 * function. Empty when the list keeps them all; notifications.test.ts reads it for
 * NOTIFICATION_DEFINITIONS and for planted lists.
 */
export function findNotificationDefinitionProblems(
  definitions: readonly NotificationDefinition[],
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const definition of definitions) {
    const { type } = definition;
    if (!NOTIFICATION_TYPE_PATTERN.test(type)) problems.push(`${type}: type shape`);
    if (seen.has(type)) problems.push(`${type}: listed twice`);
    seen.add(type);
    if (!(NOTIFICATION_CATEGORIES as readonly string[]).includes(definition.category)) {
      problems.push(`${type}: category ${definition.category}`);
    }
    if (definition.targets.length === 0) problems.push(`${type}: no target kind`);
    for (const kind of definition.targets) {
      if (!(NOTIFICATION_TARGET_KINDS as readonly string[]).includes(kind)) {
        problems.push(`${type}: target kind ${kind}`);
      }
    }
    if (definition.merge !== null && typeof definition.merge !== 'function') {
      problems.push(`${type}: merge`);
    }
    if (!(definition.params instanceof z.ZodObject)) {
      problems.push(`${type}: params are not an object`);
      continue;
    }
    const shape = definition.params.shape;
    for (const [key, field] of Object.entries(shape)) {
      if (!NOTIFICATION_PARAM_KEY_PATTERN.test(key)) problems.push(`${type}.${key}: name shape`);
      if (NOTIFICATION_IDENTITY_PARAM.test(key)) {
        problems.push(`${type}.${key}: names another account or its identity`);
      }
      const flat = (() => {
        try {
          return isFlat(z.toJSONSchema(field, { io: 'input', unrepresentable: 'any' }));
        } catch {
          return false;
        }
      })();
      if (!flat) problems.push(`${type}.${key}: not a flat value`);
    }
  }
  return problems;
}
