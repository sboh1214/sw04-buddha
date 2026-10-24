import * as z from 'zod';
import { type ValidationIssue } from './api/errors.js';
import { cursorQuerySchema } from './api/pagination.js';
import { releaseSettingStatusSchema, type ReleaseSettingStatus } from './enums.js';
import { RETENTION_PERIOD_MAX_DAYS, type RetentionPeriod } from './retention.js';
import { START_GRANT_MAX_COIN } from './start-grant.js';

/**
 * Release settings (출시 설정, #170): the values a simulation or an operating approval settles —
 * starting grant, re-grant cadence, objection period, price-protection width, retention and the
 * like (N01 §10, NR 설계 상태). One place holds them, and the server reads a registered item from
 * there only.
 *
 * - WHAT an item is (key, name, unit, meaning, value shape) is code: a definition in
 *   RELEASE_SETTINGS below, registered by the issue that uses the value.
 * - Its VALUE and STATUS live in Postgres (`release_settings`), changed by an admin with a reason
 *   (owner decision 2026-10-13: changeable while running, every change recorded) and only so: no
 *   migration or seed writes a value, and every item starts `undecided` after a dev setup or a
 *   reset (owner decision 2026-10-13~14). A missing row is `undecided` with no value. Each change
 *   appends an `admin_actions` row (`release_setting_change`) in the same transaction, and the
 *   database refuses a write without a matching record that no earlier write used (migration
 *   0020). A change that keeps the status and value as they are is refused.
 * - A value applies to work that starts after it changed (owner decision): a consumer reads it
 *   once when its work begins and keeps that reading for the work's whole life.
 */

/** Statuses as the admin screen names them. `proposal` and `test` never read as settled. */
export const RELEASE_SETTING_STATUS_LABELS: Readonly<Record<ReleaseSettingStatus, string>> = {
  undecided: '미정',
  proposal: '설계 제안',
  test: '시험값',
  approved: '승인됨',
};

/**
 * Lower-case words joined by `_`, grouped by `.` (`grant.initial_coin`). Stored in
 * `release_settings.key` and `admin_actions.target_id`, so a key is never renamed once shipped:
 * its stored value and history would stay behind under the old one.
 */
export const RELEASE_SETTING_KEY_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
/** release_settings.key is varchar(64). */
export const RELEASE_SETTING_KEY_MAX_LENGTH = 64;

/** `ReleaseSettingChangeBody.reason`: stored in admin_actions, like a refund's reason. */
export const RELEASE_SETTING_REASON_MAX_LENGTH = 500;

/**
 * The `message` of the issue that refuses a string jsonb cannot hold. PostgreSQL refuses U+0000
 * in jsonb (SQLSTATE 22P05) and a UTF-16 surrogate with no partner, which JSON.stringify writes as
 * a `\udXXX` escape that jsonb's parser refuses (22P02). A change stores its reason and value in
 * jsonb (`admin_actions.payload`, `release_settings.value`), so either one carrying such a string
 * would fail the write as INTERNAL rather than be refused as bad input. The NUL message is the
 * one the API's global validation pipe gives, so a NUL reads the same whichever check finds it.
 */
export const JSONB_NUL_MESSAGE = 'must not contain NUL';
export const JSONB_LONE_SURROGATE_MESSAGE = 'must not contain an unpaired surrogate';

/** Why jsonb cannot hold `text` (`JSONB_NUL_MESSAGE`, `JSONB_LONE_SURROGATE_MESSAGE`), or null. */
export function jsonbTextProblem(text: string): string | null {
  if (text.includes('\u0000')) return JSONB_NUL_MESSAGE;
  // In unicode mode a pair is one code point; only a lone surrogate is of category Cs.
  if (/\p{Cs}/u.test(text)) return JSONB_LONE_SURROGATE_MESSAGE;
  return null;
}

/**
 * An issue for every string and object key inside the JSON `value` that jsonb cannot hold, with
 * paths from `path`. A key's issue names its member (`[…, key]`) and says it is the key; a member
 * that is `undefined` is skipped, as JSON drops it.
 */
export function jsonbValueIssues(
  value: unknown,
  path: readonly (string | number)[] = [],
): ValidationIssue[] {
  if (typeof value === 'string') {
    const problem = jsonbTextProblem(value);
    return problem === null ? [] : [{ path: [...path], message: problem }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => jsonbValueIssues(item, [...path, index]));
  }
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([member, item]) => {
    if (item === undefined) return [];
    const problem = jsonbTextProblem(member);
    return [
      ...(problem === null ? [] : [{ path: [...path, member], message: `key ${problem}` }]),
      ...jsonbValueIssues(item, [...path, member]),
    ];
  });
}

export const releaseSettingKeySchema = z
  .string()
  .max(RELEASE_SETTING_KEY_MAX_LENGTH)
  .regex(RELEASE_SETTING_KEY_PATTERN, 'must be lower-case words joined by _ and .');

/**
 * A JSON value, as `release_settings.value` (jsonb) holds it. Object members may be `undefined`
 * so a value schema can have optional keys; JSON drops them.
 */
export type ReleaseSettingJson =
  | string
  | number
  | boolean
  | null
  | ReleaseSettingJson[]
  | { [key: string]: ReleaseSettingJson | undefined };

/** What a value schema may produce: any JSON but a bare `null`, which means "no value". */
export type ReleaseSettingValue = Exclude<ReleaseSettingJson, null>;

/**
 * One release setting. Every text is what the admin screen shows (Korean).
 *
 * `schema` validates a value an admin enters and is applied again to the stored value on every
 * read, so it must accept its own output (no transform that changes the type) and its output must
 * be JSON — Coin amounts as decimal strings or numbers, never bigint. A string or key in its
 * output that jsonb cannot hold is refused whatever the schema says (`parseReleaseSettingChange`).
 */
export interface ReleaseSettingDefinition<T extends ReleaseSettingValue = ReleaseSettingValue> {
  readonly key: string;
  /** 이름: what the item is called (`시작 지급액`). */
  readonly label: string;
  /** 단위 (`Coin`, `시간`), or null for a value that has none (a flag, a list). */
  readonly unit: string | null;
  /** 뜻: what the value controls and which issue owns it. */
  readonly description: string;
  readonly schema: z.ZodType<T>;
}

/** Definitions by key, in the order the admin screen lists them. */
export type ReleaseSettingsRegistry = ReadonlyMap<string, ReleaseSettingDefinition>;

function assertDefinition(definition: ReleaseSettingDefinition): void {
  const { key, label, unit, description } = definition;
  if (!releaseSettingKeySchema.safeParse(key).success) {
    throw new Error(
      `release setting key '${key}' must match ${String(RELEASE_SETTING_KEY_PATTERN)}`,
    );
  }
  if (label.trim() === '' || description.trim() === '' || unit?.trim() === '') {
    throw new Error(`release setting '${key}' needs a label, a description and a non-blank unit`);
  }
}

/** Checks one definition and returns it as given; the type of its value follows `schema`. */
export function defineReleaseSetting<T extends ReleaseSettingValue>(
  definition: ReleaseSettingDefinition<T>,
): ReleaseSettingDefinition<T> {
  assertDefinition(definition);
  return definition;
}

/**
 * Builds a registry, refusing a malformed definition or a key used twice. The server reads an item
 * only through the very definition object registered here (`readReleaseSetting` checks it), so a
 * value cannot be read under a definition that is not in the registry.
 */
export function defineReleaseSettings(
  definitions: readonly ReleaseSettingDefinition[],
): ReleaseSettingsRegistry {
  const registry = new Map<string, ReleaseSettingDefinition>();
  for (const definition of definitions) {
    assertDefinition(definition);
    if (registry.has(definition.key)) {
      throw new Error(`release setting '${definition.key}' is registered twice`);
    }
    registry.set(definition.key, definition);
  }
  return registry;
}

/**
 * 시작 지급액 (#70, ADR-0071): the Coin a verified mobile number gets once (start-grant.ts). Read
 * once per grant, when it is paid, inside the paying transaction; whatever the status, a value is
 * paid (ADR-0069 decision 7) and no value leaves the grant `pending` until an admin enters one
 * (decision 4 #70). A changed value applies to the grants paid after the change; granted accounts
 * keep theirs (#57-2). An integer, 1 to START_GRANT_MAX_COIN.
 */
export const START_COIN_SETTING = defineReleaseSetting({
  key: 'grant.start_coin',
  label: '시작 지급액',
  unit: 'Coin',
  description:
    '본인확인한 휴대전화 번호마다 한 번 주는 시작 Coin의 금액(#70). 값이 있으면 상태와 상관없이 그 값으로 주고, 미정이면 지급을 기다리게 했다가 값을 넣으면 기다리던 계정에 준다. 바꾼 값은 그 뒤의 지급부터 적용하고 이미 받은 계정은 그대로다.',
  schema: z.number().int().min(1).max(START_GRANT_MAX_COIN),
});

/**
 * A retention period (#184, retention.ts): whole days, 1 to RETENTION_PERIOD_MAX_DAYS. Days, the
 * unit every count of this project's periods uses (a day is 24 hours of the database clock), so
 * one value says exactly when a record is due; a year is entered as its days.
 */
const retentionDaysSchema = z.number().int().min(1).max(RETENTION_PERIOD_MAX_DAYS);

/**
 * What every retention item's description ends with: the rules ADR-0069 decision 7 and ADR-0055 set
 * for all of them.
 */
const RETENTION_RULES =
  '상태가 승인됨일 때만 지우고, 미정·설계 제안·시험값이면 지우지 않는다(보존된다). 매일 한 번 처리하고 바꾼 값은 그 뒤의 처리부터 적용한다. 처리마다 종류·건수·시각을 운영 기록으로 남기고, 오류로 끝내지 못한 종류는 실패로 남긴다.';

/**
 * 동의 기록의 보존기간 (#184): a withdrawn account's consent records (`consent_records`, ADR-0072 —
 * the item, the version, the answer, the time, the client address and the browser), deleted once
 * this period has passed since the withdrawal. A live account's records are its standing consent:
 * never deleted.
 */
export const CONSENT_RECORDS_RETENTION_SETTING = defineReleaseSetting({
  key: 'retention.consent_records',
  label: '동의 기록 보존기간',
  unit: '일',
  description: `탈퇴한 계정의 약관 동의 기록(항목·판·동의 여부·시각·접속 주소·브라우저)을 탈퇴 시각부터 이 기간이 지나면 지운다(#184). 탈퇴하지 않은 계정의 기록은 지우지 않는다. ${RETENTION_RULES}`,
  schema: retentionDaysSchema,
});

/**
 * 본인확인 기록의 보존기간 (#184): a withdrawn account's code sends (`phone_verification_codes`,
 * ADR-0070 — the number, the real name, the code's hash, the times and the client address, kept in
 * plain text past the withdrawal by the owner's exception to #57-18), deleted once this period has
 * passed since the withdrawal. A live account keeps them.
 */
export const PHONE_VERIFICATION_RECORDS_RETENTION_SETTING = defineReleaseSetting({
  key: 'retention.phone_verification_records',
  label: '본인확인 기록 보존기간',
  unit: '일',
  description: `탈퇴한 계정의 휴대전화 본인확인 발송 기록(번호·실명·인증번호의 해시·시각·접속 주소)을 탈퇴 시각부터 이 기간이 지나면 지운다(#184). 탈퇴하지 않은 계정의 기록은 지우지 않는다. ${RETENTION_RULES}`,
  schema: retentionDaysSchema,
});

/**
 * 지운 글 원문의 보존기간 (#184): what an author deleted — a post, a 댓글 or a 대댓글 — emptied once
 * this period has passed since the deletion (since the withdrawal for a withdrawn author), with the
 * images only it used; and, with the same period (ADR-0069 decision 7), each operator-only earlier
 * version of a post or a comment, deleted once the period has passed since an edit replaced it,
 * whether or not the author withdrew, with the images only those versions used — save that a
 * withdrawn member's post or comment an operator still hides loses what is left of its versions
 * when its content is emptied under the 신고·제재 period, whatever this item's status or value
 * (owner decision 2026-10-24 (2차) 2: undecided, it keeps every other version). Nothing about an
 * item a pending report is about, or a pending account restriction request cites, is deleted until
 * it is processed, decided or retracted (owner decisions 2026-10-24 4 and 12); the period still
 * counts from the deletion or the replacement.
 */
export const DELETED_POSTS_RETENTION_SETTING = defineReleaseSetting({
  key: 'retention.deleted_posts',
  label: '지운 글 원문·수정 이력 보존기간',
  unit: '일',
  description: `작성자가 지운 근거 글·댓글·대댓글의 원문(그것만 쓰던 이미지 포함)을 지운 시각부터(탈퇴한 작성자는 탈퇴 시각부터), 글·댓글의 운영자 전용 수정 이력(이전 내용과 그것만 쓰던 이미지)을 바뀐 시각부터 이 기간이 지나면 지운다(#184). 탈퇴한 회원의 글·댓글 가운데 운영자가 숨긴 채로 남은 것의 수정 이력은 이 항목의 상태·값과 상관없이 그 내용을 비울 때('신고·제재 기록 보존기간') 함께 지운다. 처리 중인 신고가 있는 글·댓글과 결정을 기다리는 계정 제한 요청이 근거로 든 글·댓글의 것은 신고가 처리되거나 요청이 결정·철회될 때까지 지우지 않는다(기간은 그대로 지운 시각·바뀐 시각부터 센다). ${RETENTION_RULES}`,
  schema: retentionDaysSchema,
});

/**
 * 신고·제재 기록의 보존기간 (#184): the reports a withdrawn account sent or a withdrawn member received
 * (owner decision 2026-10-24 1), and the actions on a withdrawn member (warnings, hidings, the
 * profile actions — nickname reset, 소개 clearing, image removal — and writing and account
 * restrictions, with their end changes and their approval requests), deleted once this period has
 * passed since the later of the withdrawal and the processing (ADR-0069 decision 7). A withdrawn
 * member's post or comment an operator still hides is emptied then, as a deleted original is, and
 * its hiding deleted with it — it stays hidden (owner decision 2026-10-24 3) — and so is its
 * operator-only edit history, with the images only that used, whatever the edit history's own
 * period (owner decision 2026-10-24 (2차) 2). A pending one, and a
 * restriction that has not ended, are kept; so are a live member's actions and the reports between
 * live accounts (owner decision 2026-10-24 2). What a profile action took away is the removed
 * items' period (REMOVED_PROFILE_ITEMS_RETENTION_SETTING); its action stays while that is kept.
 * #187's repeated-link review list (`link_flags`, ADR-0083) follows this period too, whoever wrote
 * the items it names: each entry from the later of its flagging and the operator's '확인함' mark
 * that covered it (owner decision 2026-10-24 13) — the mark itself, with the link, is an
 * operational record and stays (owner decision 2026-10-22 (2차) 3).
 */
export const MODERATION_RECORDS_RETENTION_SETTING = defineReleaseSetting({
  key: 'retention.moderation_records',
  label: '신고·제재 기록 보존기간',
  unit: '일',
  description: `탈퇴한 계정이 낸 신고, 탈퇴한 회원이 받은 신고와 조치(경고·숨김·닉네임 강제 변경·소개 비우기·프로필 이미지 삭제·작성 제한·계정 제한과 그 감경·해제·승인 요청)를 탈퇴 시각과 처리 시각 가운데 늦은 쪽부터 이 기간이 지나면 지운다(#184). 탈퇴한 회원의 글·댓글 가운데 운영자가 숨긴 채로 남은 것은 지운 원문처럼 내용을 비우고(글은 계속 숨긴 채) 그 수정 이력(이전 내용과 그것만 쓰던 이미지)과 숨김 조치도 함께 지운다. 프로필 조치가 가져간 항목 자체는 '운영자가 지운 프로필 항목 보존기간'을 따르고, 그 항목이 남아 있는 동안 조치도 남는다. 처리 중인 신고·요청이 있는 것과 끝나지 않은 제한은 지우지 않는다. 탈퇴하지 않은 회원이 받은 조치와 탈퇴하지 않은 계정끼리의 신고는 지우지 않는다. 반복 링크 검토 목록의 항목은 작성자의 탈퇴와 상관없이 탐지된 시각과 '확인함'으로 표시된 시각 가운데 늦은 쪽부터 이 기간이 지나면 지운다('확인함' 운영 기록과 그 주소는 남는다). ${RETENTION_RULES}`,
  schema: retentionDaysSchema,
});

/**
 * 운영자가 지운 프로필 항목의 보존기간 (#184): the nickname, 소개 or profile image an operator took
 * away (#37-10, `profile_item_removals` — the image's row and object), deleted once this period has
 * passed since the action (since the withdrawal for a withdrawn member).
 */
export const REMOVED_PROFILE_ITEMS_RETENTION_SETTING = defineReleaseSetting({
  key: 'retention.removed_profile_items',
  label: '운영자가 지운 프로필 항목 보존기간',
  unit: '일',
  description: `운영자가 지운 닉네임·소개·프로필 이미지를 지운 시각부터(탈퇴한 회원은 탈퇴 시각부터) 이 기간이 지나면 지운다(#184). ${RETENTION_RULES}`,
  schema: retentionDaysSchema,
});

/**
 * 시장 제안 기록의 보존기간 (#77, ADR-0089; ADR-0087's owner decision 2026-10-24 13 and 결과 5): a
 * withdrawn account's market proposals (`market_proposals` — the form as submitted, the keyed hash of
 * the number, the status, the operators' reasons, memos and internal memo), deleted once this period
 * has passed since the later of the withdrawal and the end of their processing — the 채택 or 반려,
 * a market linked to a 채택 later, or the 철회 (ADR-0069 decision 7). One waiting for the operators
 * (접수, 검토) is never deleted: the operators still review it (decision 4 #140). A live account's
 * proposals are its own record: never. Who reviewed and decided stays in the operational records
 * (`admin_actions`), with no period.
 */
export const MARKET_PROPOSALS_RETENTION_SETTING = defineReleaseSetting({
  key: 'retention.market_proposals',
  label: '시장 제안 기록 보존기간',
  unit: '일',
  description: `탈퇴한 계정의 시장 제안(낸 양식·상태·반려 사유와 설명·채택 메모·운영자 내부 메모)을 탈퇴 시각과 처리가 끝난 시각(채택·반려, 채택 뒤 나중에 이은 시장, 철회) 가운데 늦은 쪽부터 이 기간이 지나면 지운다(#77). 처리를 기다리는 제안(접수·검토)과 탈퇴하지 않은 계정의 제안은 지우지 않는다. ${RETENTION_RULES}`,
  schema: retentionDaysSchema,
});

/** The retention items by period (retention.ts): the worker's job reads each once per run. */
export const RETENTION_PERIOD_SETTINGS: Readonly<
  Record<RetentionPeriod, ReleaseSettingDefinition<number>>
> = {
  consent_records: CONSENT_RECORDS_RETENTION_SETTING,
  phone_verification_records: PHONE_VERIFICATION_RECORDS_RETENTION_SETTING,
  deleted_posts: DELETED_POSTS_RETENTION_SETTING,
  moderation_records: MODERATION_RECORDS_RETENTION_SETTING,
  removed_profile_items: REMOVED_PROFILE_ITEMS_RETENTION_SETTING,
  market_proposals: MARKET_PROPOSALS_RETENTION_SETTING,
};

/**
 * The shipped registry, in the order the admin screen lists it. #170 built the mechanism, and each
 * value is registered by the issue that uses it (#70 the start grant, #184 the retention periods,
 * #77 the market proposals' retention period;
 * #74, #119, #152·#175, … to come) — define it with `defineReleaseSetting` and list it here, then
 * update every test that pins the list (docs/SETTINGS.md, 항목 등록하기). Tests inject their own
 * registry (`createTestApp({ releaseSettings })` in apps/api).
 */
export const RELEASE_SETTINGS: ReleaseSettingsRegistry = defineReleaseSettings([
  START_COIN_SETTING,
  CONSENT_RECORDS_RETENTION_SETTING,
  PHONE_VERIFICATION_RECORDS_RETENTION_SETTING,
  DELETED_POSTS_RETENTION_SETTING,
  MODERATION_RECORDS_RETENTION_SETTING,
  REMOVED_PROFILE_ITEMS_RETENTION_SETTING,
  MARKET_PROPOSALS_RETENTION_SETTING,
]);

/** A stored status and value: `value` is null exactly when `status` is `undecided`. */
export interface ReleaseSettingState {
  status: ReleaseSettingStatus;
  value: unknown;
}

/** What server code gets for an item: no value while undecided, a typed one otherwise. */
export type ReleaseSettingReading<T extends ReleaseSettingValue = ReleaseSettingValue> =
  | { key: string; status: 'undecided'; value: null }
  | { key: string; status: Exclude<ReleaseSettingStatus, 'undecided'>; value: T };

/**
 * The reading of `definition` from its stored row (`undefined`: no row, so `undecided`). Every
 * server read ends here — `ReleaseSettingsService.get` in apps/api and `getReleaseSetting` of
 * @buddha/db (the worker) — so it throws when `definition` is not the very object `registry`
 * holds under its key (an unlisted item, or a copy of a listed one), when the row breaks the
 * status/value rule, or when its value no longer fits the schema: a stale value after a
 * definition changed is a fault to surface, not a value to use.
 */
export function readReleaseSetting<T extends ReleaseSettingValue>(
  registry: ReleaseSettingsRegistry,
  definition: ReleaseSettingDefinition<T>,
  stored: ReleaseSettingState | undefined,
): ReleaseSettingReading<T> {
  const { key } = definition;
  if (registry.get(key) !== definition) {
    throw new Error(`release setting '${key}' is not registered`);
  }
  if (stored === undefined || stored.status === 'undecided') {
    if (stored !== undefined && stored.value !== null) {
      throw new Error(`release setting '${key}' is undecided but holds a value`);
    }
    return { key, status: 'undecided', value: null };
  }
  const parsed = definition.schema.safeParse(stored.value);
  if (!parsed.success) {
    throw new Error(`release setting '${key}': the stored value does not fit its schema`, {
      cause: parsed.error,
    });
  }
  return { key, status: stored.status, value: parsed.data };
}

/**
 * Whether two JSON values are one value, as jsonb compares them: deep, with object members in any
 * order (jsonb does not keep it) and a member that is `undefined` the same as an absent one (JSON
 * drops it).
 */
export function sameReleaseSettingJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameReleaseSettingJson(item, b[index]))
    );
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const present = (record: Record<string, unknown>) =>
    Object.keys(record).filter((member) => record[member] !== undefined);
  const members = present(left);
  return (
    members.length === present(right).length &&
    members.every((member) => sameReleaseSettingJson(left[member], right[member]))
  );
}

/**
 * Whether a change would leave an item as it stands (`current`, undefined for no row: `undecided`
 * with no value): the same status and the same value (`sameReleaseSettingJson`). Such a change is
 * refused — nothing written, nothing recorded (owner decision 2026-10-13~14, #170).
 */
export function isReleaseSettingUnchanged(
  current: ReleaseSettingState | undefined,
  next: ReleaseSettingState,
): boolean {
  return (
    (current?.status ?? 'undecided') === next.status &&
    sameReleaseSettingJson(current?.value ?? null, next.value ?? null)
  );
}

/**
 * The `message` of the VALIDATION_ERROR issue that refuses an unchanged change. Its path is the
 * whole body (`[]`): status and value together, neither one field. The admin screen tells this
 * refusal apart by the message.
 */
export const RELEASE_SETTING_UNCHANGED_MESSAGE = 'is the current status and value';

/** `parseReleaseSettingChange`: the state to store, or why the change is refused. */
export type ReleaseSettingChangeResult =
  | { success: true; state: { status: ReleaseSettingStatus; value: ReleaseSettingValue | null } }
  | { success: false; issues: ValidationIssue[] };

/**
 * Checks a change against the item: `undecided` takes no value (omitted or null), every other
 * status requires one, and a value must fit the item's schema. What the schema makes of it is
 * the value stored in jsonb, so a string or object key in it that jsonb cannot hold is refused
 * too (`jsonbValueIssues`) — a key the schema drops does not count. Issues are paths into the
 * request body (`['value', …]`), as the validation pipe reports them.
 */
export function parseReleaseSettingChange(
  definition: ReleaseSettingDefinition,
  change: { status: ReleaseSettingStatus; value?: unknown },
): ReleaseSettingChangeResult {
  const { status, value } = change;
  const absent = value === undefined || value === null;
  if (status === 'undecided') {
    return absent
      ? { success: true, state: { status, value: null } }
      : {
          success: false,
          issues: [{ path: ['value'], message: 'must be omitted while the status is undecided' }],
        };
  }
  if (absent) {
    return {
      success: false,
      issues: [{ path: ['value'], message: 'is required unless the status is undecided' }],
    };
  }
  const parsed = definition.schema.safeParse(value);
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues.map((issue) => ({
        path: [
          'value',
          ...issue.path.map((segment) => (typeof segment === 'number' ? segment : String(segment))),
        ],
        message: issue.message,
      })),
    };
  }
  const unstorable = jsonbValueIssues(parsed.data, ['value']);
  if (unstorable.length > 0) return { success: false, issues: unstorable };
  return { success: true, state: { status, value: parsed.data } };
}

/**
 * The JSON Schema of the value an admin enters for `definition` (its input side), so the admin
 * screen can say what shape is expected without knowing the item. Parts JSON Schema cannot say
 * (a refine, a transform) become `{}`; the server still checks them.
 */
export function releaseSettingValueJsonSchema(
  definition: ReleaseSettingDefinition,
): Record<string, unknown> {
  return z.toJSONSchema(definition.schema, { io: 'input', unrepresentable: 'any' });
}

// ---- DTOs ---------------------------------------------------------------------------

/**
 * Who changed an item: the admin's account id and nickname — null once that account closed (#140:
 * an admin closes once the role is revoked, and the nickname goes with the closure).
 */
export const releaseSettingActorSchema = z
  .object({ id: z.string(), nickname: z.string().nullable() })
  .meta({ id: 'ReleaseSettingActor' });
export type ReleaseSettingActor = z.infer<typeof releaseSettingActorSchema>;

/** A status and value, before or after a change: `value` is null exactly while `undecided`. */
export const releaseSettingStateSchema = z
  .object({ status: releaseSettingStatusSchema, value: z.unknown().nullable() })
  .meta({ id: 'ReleaseSettingState' });

/** `GET /admin/release-settings` item and `PATCH /admin/release-settings/:key` answer. */
export const releaseSettingSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    unit: z.string().nullable(),
    description: z.string(),
    /** JSON Schema of the value to enter (`releaseSettingValueJsonSchema`). */
    valueSchema: z.record(z.string(), z.unknown()),
    status: releaseSettingStatusSchema,
    /** The stored value; null exactly while `undecided`. */
    value: z.unknown().nullable(),
    /** The last change; null for an item never changed (no row: `undecided`). */
    updatedAt: z.iso.datetime().nullable(),
    updatedBy: releaseSettingActorSchema.nullable(),
  })
  .meta({ id: 'ReleaseSetting' });
export type ReleaseSetting = z.infer<typeof releaseSettingSchema>;

/** `GET /admin/release-settings`: every registered item, or only those with one status. */
export const releaseSettingListQuerySchema = z.object({
  status: releaseSettingStatusSchema.optional(),
});
export type ReleaseSettingListQuery = z.infer<typeof releaseSettingListQuerySchema>;

/**
 * `PATCH /admin/release-settings/:key`: the new status and value, and why (required). The value is
 * omitted (or null) for `undecided` and required otherwise; `parseReleaseSettingChange` checks it
 * against the item. The reason is stored in jsonb, so it must be text jsonb can hold
 * (`jsonbTextProblem`): refused here, before anything is written.
 */
export const releaseSettingChangeBodySchema = z
  .object({
    status: releaseSettingStatusSchema,
    value: z.unknown().optional(),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(RELEASE_SETTING_REASON_MAX_LENGTH)
      .superRefine((reason, ctx) => {
        const problem = jsonbTextProblem(reason);
        if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
      }),
  })
  .meta({ id: 'ReleaseSettingChangeBody' });
export type ReleaseSettingChangeBody = z.infer<typeof releaseSettingChangeBodySchema>;

/** `admin_actions.payload` of a `release_setting_change` row. */
export const releaseSettingChangePayloadSchema = z.object({
  key: z.string(),
  before: releaseSettingStateSchema,
  after: releaseSettingStateSchema,
  reason: z.string(),
});
export type ReleaseSettingChangePayload = z.infer<typeof releaseSettingChangePayloadSchema>;

/** One entry of `GET /admin/release-settings/changes`, newest first. */
export const releaseSettingChangeSchema = z
  .object({
    /** The admin_actions row. */
    id: z.uuid(),
    key: z.string(),
    /** The item's name today; null once the key is no longer registered. */
    label: z.string().nullable(),
    before: releaseSettingStateSchema,
    after: releaseSettingStateSchema,
    reason: z.string(),
    actor: releaseSettingActorSchema,
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'ReleaseSettingChange' });
export type ReleaseSettingChange = z.infer<typeof releaseSettingChangeSchema>;

/** `GET /admin/release-settings/changes`: a cursor page, of one item when `key` is given. */
export const releaseSettingChangeListQuerySchema = cursorQuerySchema.extend({
  key: releaseSettingKeySchema.optional(),
});
export type ReleaseSettingChangeListQuery = z.infer<typeof releaseSettingChangeListQuerySchema>;
