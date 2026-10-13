import { type RealtimeEventType } from '../realtime.js';

/**
 * Every realtime event type and the channel it may travel on (#113), with why: `market` is the
 * public `market:<id>` room any visitor subscribes to, `user` the owner-only `user:<id>` room the
 * handshake session joins. Keyed by RealtimeEventType, so an event type added without a line
 * here fails to compile, and a line left behind for a removed one does too.
 *
 * guards/realtime-events.test.ts holds the rest: the channel named here is the family the gateway
 * parses the event with (`marketRealtimeEventSchema`, `userRealtimeEventSchema`), a market-channel
 * schema has no field of PRIVATE_DATA and no excluded feature's or probability's name, and no
 * user-channel event parses as a market-channel one. The gateway's own suite and the API's private-data suite
 * (apps/api/src/surface) publish them for real. docs/GUARDS.md has the steps for a new type.
 */
export interface RealtimeEventEntry {
  readonly channel: 'market' | 'user';
  readonly reason: string;
}

export const REALTIME_EVENT_REGISTRY = {
  'market:tick': {
    channel: 'market',
    reason: '체결 뒤 시장가격·거래량·참여자 수(N02 §5): 시장 상세와 같은 공개 집계',
  },
  'market:trade': {
    channel: 'market',
    reason: '최근 체결 한 건: 계정·주문 없이 익명으로만(N01 §5)',
  },
  'market:status': {
    channel: 'market',
    reason: '시장 상태 전환과 판정 결과(N03): 시장 상세에 공개된 상태',
  },
  'user:balance': {
    channel: 'user',
    reason: '본인 잔액(N04 §2 본인 전용)',
  },
  'user:position': {
    channel: 'user',
    reason: '본인 보유 계약과 손익(N04 §2 본인 전용)',
  },
} as const satisfies Record<RealtimeEventType, RealtimeEventEntry>;
