import { readFileSync } from 'node:fs';
import path from 'node:path';
import { timeZoneSchema } from '@buddha/shared';
import ts from 'typescript';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { copy } from '@/copy';
import { SRC, scriptKindOf, screenSources, usesOf } from '@/test/screen-text';
import { ApiError } from './api';
import { SEOUL_TIME_ZONE, formatInTimeZone } from './datetime';
import {
  FOLLOW_BROWSER,
  type HeldTimeZone,
  type TimeZoneReading,
  browserTimeZone,
  displayTimeZone,
  effectiveTimeZone,
  holdTimeZone,
  settledTimeZone,
  supportedTimeZones,
  timeZoneFromSelect,
  timeZoneLabel,
  timeZoneOptions,
  timeZoneSaveFailure,
  timeZoneSelectValue,
} from './time-zone';

const originalTz = process.env.TZ;
afterAll(() => {
  process.env.TZ = originalTz;
});

describe('effectiveTimeZone', () => {
  it('takes the zone picked in MY 설정 over the browser’s (ADR-0061 #60-8)', () => {
    expect(effectiveTimeZone('America/New_York', 'Asia/Seoul')).toBe('America/New_York');
    expect(effectiveTimeZone('Asia/Seoul', 'Europe/London')).toBe('Asia/Seoul');
  });

  it('follows the browser when nothing is picked or nobody is signed in', () => {
    // null: the member follows the browser. undefined: signed out, or /me has not answered.
    expect(effectiveTimeZone(null, 'Europe/London')).toBe('Europe/London');
    expect(effectiveTimeZone(undefined, 'Europe/London')).toBe('Europe/London');
  });

  it('follows the browser rather than apply a picked zone this engine cannot read', () => {
    expect(effectiveTimeZone('Mars/Olympus_Mons', 'Europe/London')).toBe('Europe/London');
    expect(effectiveTimeZone('+09:00', 'Europe/London')).toBe('Europe/London');
  });
});

describe('browserTimeZone', () => {
  it('is the zone the engine reports', () => {
    // Node re-reads process.env.TZ for a new DateTimeFormat, which is what a browser's
    // resolvedOptions() answers from its OS.
    for (const tz of ['America/New_York', 'Asia/Seoul', 'Europe/London']) {
      process.env.TZ = tz;
      expect(browserTimeZone(), tz).toBe(tz);
    }
  });

  it('is Seoul when the engine reports a zone it cannot read, or none at all', () => {
    // 'Etc/Unknown' is ICU's name for "no idea", which Intl then refuses as a timeZone. An OS zone
    // ICU cannot place at all ('Nowhere/Land') comes back as `timeZone: undefined`, which a
    // pattern alone would read as the string 'undefined' and Intl as "the default zone".
    for (const tz of ['Etc/Unknown', 'Nowhere/Land']) {
      process.env.TZ = tz;
      expect(browserTimeZone(), tz).toBe(SEOUL_TIME_ZONE);
    }
  });
});

describe('timeZoneLabel (owner decision 2026-10-16: 이름 + 한국어 이름)', () => {
  // Fixed instants on both sides of daylight saving time, north and south. The Korean strings
  // themselves come from the engine's ICU and can change with its version, so these pin the
  // shape, not the words.
  const JANUARY = new Date('2026-01-15T12:00:00.000Z');
  const JULY = new Date('2026-07-15T12:00:00.000Z');
  const HANGUL = /[가-힣]/;

  /** The Korean name after the IANA one, or `undefined` for the IANA name alone. */
  const nameIn = (zone: string, label: string): string | undefined => {
    if (label === zone) return undefined;
    expect(label.startsWith(`${zone} — `), label).toBe(true);
    return label.slice(`${zone} — `.length);
  };

  it('is the IANA name, then the Korean name the engine gives it', () => {
    for (const zone of ['America/New_York', 'Asia/Seoul', 'Europe/London', 'Pacific/Chatham']) {
      const name = nameIn(zone, timeZoneLabel(zone, JANUARY));
      expect(name, zone).toMatch(HANGUL);
      expect(name, zone).not.toMatch(/GMT|UTC/);
    }
  });

  it("is the same name all year: the generic one, not winter's 표준시 or summer's 하계 표준시", () => {
    // New York and London change in summer, Chatham and Lord Howe in the southern summer.
    for (const zone of [
      'America/New_York',
      'Europe/London',
      'Pacific/Chatham',
      'Australia/Lord_Howe',
    ]) {
      const winter = timeZoneLabel(zone, JANUARY);
      expect(timeZoneLabel(zone, JULY), zone).toBe(winter);
      // The daylight-saving name the 'long' style gives in that half of the year is not it.
      for (const at of [JANUARY, JULY]) {
        const long = new Intl.DateTimeFormat('ko-KR', { timeZone: zone, timeZoneName: 'long' })
          .formatToParts(at)
          .find((part) => part.type === 'timeZoneName')?.value;
        if (long?.includes('하계')) expect(nameIn(zone, winter), zone).not.toBe(long);
      }
    }
  });

  it('is the IANA name alone for a zone the engine names only by its GMT offset', () => {
    // ICU has no Korean name for these and answers 'GMT+00:00', 'GMT-05:00': beside Etc/GMT+5
    // that would print the POSIX sign reversed.
    for (const zone of ['UTC', 'Etc/GMT+5', 'Etc/GMT-14']) {
      expect(timeZoneLabel(zone, JANUARY), zone).toBe(zone);
    }
  });

  it('is the IANA name alone, without throwing, for a zone this engine cannot read', () => {
    // A zone stored from a browser with newer tzdata: the select still lists it (timeZoneOptions).
    expect(timeZoneLabel('Mars/Olympus_Mons', JANUARY)).toBe('Mars/Olympus_Mons');
  });

  describe('in an engine that names zones differently', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** `Intl` whose DateTimeFormat answers `name` for a zone, or throws what `fail` gives. */
    const engine = (answer: { name?: string; fail?: () => Error }) => {
      class FakeDateTimeFormat {
        constructor(_locale: string, options: Intl.DateTimeFormatOptions) {
          if (answer.fail !== undefined) throw answer.fail();
          expect(options).toMatchObject({ timeZoneName: 'longGeneric' });
        }
        formatToParts(): Intl.DateTimeFormatPart[] {
          return answer.name === undefined
            ? [{ type: 'hour', value: '12' }]
            : [{ type: 'timeZoneName', value: answer.name }];
        }
      }
      vi.stubGlobal('Intl', { ...Intl, DateTimeFormat: FakeDateTimeFormat });
    };

    it.each([
      ['GMT'],
      ['GMT+9'],
      ['UTC-05:00'],
      ['GMT\u221205:00'],
      ['GMT+0530'],
      [''],
      ['  '],
      ['America/New_York'],
    ])('is the IANA name alone when the name is %j', (name) => {
      engine({ name });
      expect(timeZoneLabel('America/New_York', JANUARY)).toBe('America/New_York');
    });

    it('is the IANA name alone when no part names the zone', () => {
      engine({});
      expect(timeZoneLabel('America/New_York', JANUARY)).toBe('America/New_York');
    });

    it("is the IANA name alone in an engine without 'longGeneric', which refuses the option", () => {
      engine({ fail: () => new RangeError('Value longGeneric out of range') });
      expect(timeZoneLabel('America/New_York', JANUARY)).toBe('America/New_York');
    });

    it('takes any other name, a place written in another script included', () => {
      engine({ name: ' 미 동부 시간 ' });
      expect(timeZoneLabel('America/New_York', JANUARY)).toBe('America/New_York — 미 동부 시간');
      engine({ name: 'Eastern Time' });
      expect(timeZoneLabel('America/New_York', JANUARY)).toBe('America/New_York — Eastern Time');
    });

    it('does not hide an error that is not a RangeError', () => {
      engine({ fail: () => new TypeError('broken') });
      expect(() => timeZoneLabel('America/New_York', JANUARY)).toThrow(TypeError);
    });
  });
});

describe('timeZoneOptions', () => {
  const supported = ['Europe/London', 'America/New_York', 'Asia/Seoul'];
  const at = new Date('2026-01-15T12:00:00.000Z');

  it('offers "follow the browser" first, naming the zone it follows, then every zone sorted', () => {
    expect(timeZoneOptions(supported, null, 'Asia/Seoul', at)).toEqual([
      {
        value: FOLLOW_BROWSER,
        label: `${copy.timeZoneFollowBrowser} (${timeZoneLabel('Asia/Seoul', at)})`,
      },
      { value: 'America/New_York', label: timeZoneLabel('America/New_York', at) },
      { value: 'Asia/Seoul', label: timeZoneLabel('Asia/Seoul', at) },
      { value: 'Europe/London', label: timeZoneLabel('Europe/London', at) },
    ]);
    // The first choice names the browser's zone the same way, inside the brackets.
    expect(timeZoneOptions(supported, null, 'Asia/Seoul', at)[0]!.label).toMatch(
      new RegExp(`^${copy.timeZoneFollowBrowser} \\(Asia/Seoul — [^)]+\\)$`),
    );
  });

  it('keeps a stored zone the list does not hold, so the select shows the real choice', () => {
    // Picked in a browser that spells the zone differently (Asia/Kolkata against Asia/Calcutta).
    const options = timeZoneOptions(supported, 'Asia/Kolkata', 'Europe/London');
    expect(options.map((option) => option.value)).toEqual([
      FOLLOW_BROWSER,
      'America/New_York',
      'Asia/Kolkata',
      'Asia/Seoul',
      'Europe/London',
    ]);
    // A stored zone the list does hold is not listed twice.
    expect(timeZoneOptions(supported, 'Asia/Seoul', 'Europe/London')).toHaveLength(4);
  });

  it('adds the zones without a place that V8 leaves out of its list, UTC first of all', () => {
    // Node (V8, like Chrome) knows UTC and the Etc/GMT offsets but does not list them.
    const all = supportedTimeZones();
    for (const zone of ['UTC', 'Etc/GMT-14', 'Etc/GMT-1', 'Etc/GMT+5', 'Etc/GMT+12']) {
      expect(all, zone).toContain(zone);
    }
    // Nothing is offered twice, and the server takes every choice the select offers.
    expect(new Set(all).size).toBe(all.length);
    expect(all.filter((zone) => !timeZoneSchema.safeParse(zone).success)).toEqual([]);
    // POSIX signs: Etc/GMT+5 is five hours behind UTC, and its marker says so.
    expect(formatInTimeZone('2026-07-15T12:00:00.000Z', 'Etc/GMT+5')).toBe(
      '2026. 7. 15. 오전 7:00 (GMT-5)',
    );
  });

  it('lists every zone this engine knows when fed its own list', () => {
    const all = supportedTimeZones();
    expect(all.length).toBeGreaterThan(300);
    const options = timeZoneOptions(all, null, browserTimeZone(), at);
    expect(options).toHaveLength(all.length + 1);
    // Values are the raw IANA names, sorted by them, whatever the labels say.
    expect(options.slice(1).map((option) => option.value)).toEqual([...all].sort());
    // Each label is its value, alone or followed by a name that is not an offset.
    for (const { value, label } of options.slice(1)) {
      if (label === value) continue;
      expect(label.startsWith(`${value} — `), label).toBe(true);
      expect(label.slice(`${value} — `.length), label).not.toMatch(/^(GMT|UTC)/);
    }
    // Every zone with a place has a Korean name in Node's ICU; the zones without one are the
    // ones V8 leaves out of its list.
    const unnamed = options
      .slice(1)
      .filter(({ value, label }) => label === value)
      .map(({ value }) => value);
    expect(unnamed.filter((zone) => zone !== 'UTC' && !zone.startsWith('Etc/'))).toEqual([]);
  });
});

describe('the select value', () => {
  it('maps "follow the browser" to no stored zone and back', () => {
    expect(timeZoneSelectValue(null)).toBe(FOLLOW_BROWSER);
    expect(timeZoneFromSelect(FOLLOW_BROWSER)).toBeNull();
    expect(timeZoneSelectValue('America/New_York')).toBe('America/New_York');
    expect(timeZoneFromSelect('America/New_York')).toBe('America/New_York');
    // No IANA name is empty, so the two can never be confused.
    expect(supportedTimeZones()).not.toContain(FOLLOW_BROWSER);
  });
});

/** A profile as `['me']` holds it, reduced to what the provider reads. */
const profileOf = (id: string, timeZone: string | null): TimeZoneReading['me'] => ({
  id,
  profile: { timeZone },
});

/**
 * TimeZoneProvider's render, run over a sequence of readings: what it computes from each one and
 * keeps for the next (`holdTimeZone` stored in state). Answers the zone handed down each time.
 */
function provider(readings: readonly TimeZoneReading[]): string[] {
  let last: HeldTimeZone | null = null;
  return readings.map((reading) => {
    const held = holdTimeZone(last, reading.viewer, settledTimeZone(reading));
    last = held;
    return displayTimeZone(held, reading.viewer);
  });
}

describe('settledTimeZone', () => {
  const reading = (overrides: Partial<TimeZoneReading>): TimeZoneReading => ({
    browser: 'Europe/London',
    viewer: null,
    profilePending: false,
    me: undefined,
    ...overrides,
  });

  it('is unknown before hydration, whatever the profile or the browser says (ADR-0063)', () => {
    // The server's render and the hydrating one: the store's server snapshot is null.
    for (const profilePending of [true, false]) {
      for (const me of [profileOf('user-1', 'America/New_York'), profileOf('user-1', null)]) {
        expect(
          settledTimeZone(reading({ browser: null, viewer: 'user-1', profilePending, me })),
        ).toBeNull();
      }
      expect(settledTimeZone(reading({ browser: null, profilePending }))).toBeNull();
    }
  });

  it('is unknown after hydration until the profile is known, so times switch once', () => {
    // THE HAZARD: the session, then /me, answer two round trips after hydration. Following the
    // browser meanwhile would read a member who picked Seoul in New York's time, marked, in
    // between two Seoul renders.
    expect(
      settledTimeZone(reading({ browser: 'America/New_York', profilePending: true })),
    ).toBeNull();
  });

  it('is the effective zone once the profile is known', () => {
    const member = (timeZone: string | null, browser = 'Europe/London') =>
      settledTimeZone(reading({ browser, viewer: 'user-1', me: profileOf('user-1', timeZone) }));
    expect(member('America/New_York')).toBe('America/New_York');
    expect(member(SEOUL_TIME_ZONE, 'America/New_York')).toBe(SEOUL_TIME_ZONE);
    expect(member(null)).toBe('Europe/London');
    // Signed out (ADR-0061 #60-8: 로그인하지 않았으면 브라우저 시간대), or a /me that failed:
    // nothing picked to apply, so the browser's zone.
    expect(settledTimeZone(reading({}))).toBe('Europe/London');
    expect(settledTimeZone(reading({ viewer: 'user-1' }))).toBe('Europe/London');
  });

  it("is unknown while ['me'] still holds the previous account's profile", () => {
    // The render between the session naming B (or nobody) and SessionCacheGuard's reset, which
    // runs in an effect: A's zone is not B's, nor a signed-out visitor's.
    const a = profileOf('user-a', 'America/New_York');
    expect(settledTimeZone(reading({ viewer: 'user-b', me: a }))).toBeNull();
    expect(settledTimeZone(reading({ viewer: null, me: a }))).toBeNull();
  });
});

describe('holdTimeZone', () => {
  it('answers what it was given when nothing changed, so the state set during render settles', () => {
    const held = holdTimeZone(null, null, 'America/New_York');
    expect(held).toEqual({ viewer: null, zone: 'America/New_York' });
    expect(holdTimeZone(held, null, 'America/New_York')).toBe(held);
    expect(holdTimeZone(held, null, null)).toBe(held);
    expect(holdTimeZone(held, 'user-1', null)).toBe(held);
    expect(holdTimeZone(null, null, null)).toBeNull();
    // A new zone or a new viewer is a new object.
    expect(holdTimeZone(held, null, 'Europe/London')).toEqual({
      viewer: null,
      zone: 'Europe/London',
    });
    expect(holdTimeZone(held, 'user-1', 'America/New_York')).toEqual({
      viewer: 'user-1',
      zone: 'America/New_York',
    });
  });
});

describe('displayTimeZone (the provider over a visit)', () => {
  const NEW_YORK = 'America/New_York';

  it("keeps a signed-out visitor in the browser's zone through every session refetch", () => {
    // THE HAZARD: better-auth sets `isPending` again at the start of every session fetch while
    // its `data` is null — the focus refetch on each return to the tab among them. Seoul there
    // would print every time on screen as unmarked KST for one round trip, then New York again.
    const visit: TimeZoneReading[] = [
      { browser: null, viewer: null, profilePending: true, me: undefined }, // server, hydrating
      { browser: NEW_YORK, viewer: null, profilePending: true, me: undefined }, // first fetch
      { browser: NEW_YORK, viewer: null, profilePending: false, me: undefined }, // no session
      { browser: NEW_YORK, viewer: null, profilePending: true, me: undefined }, // back to the tab
      { browser: NEW_YORK, viewer: null, profilePending: false, me: undefined },
      { browser: NEW_YORK, viewer: null, profilePending: true, me: undefined }, // back online
      { browser: NEW_YORK, viewer: null, profilePending: false, me: undefined },
    ];
    expect(provider(visit)).toEqual([
      SEOUL_TIME_ZONE,
      SEOUL_TIME_ZONE,
      NEW_YORK,
      NEW_YORK,
      NEW_YORK,
      NEW_YORK,
      NEW_YORK,
    ]);
  });

  it('switches a member once, straight to the picked zone, and holds it through a refetch', () => {
    const tokyo = profileOf('user-1', 'Asia/Tokyo');
    expect(
      provider([
        { browser: null, viewer: null, profilePending: true, me: undefined },
        { browser: NEW_YORK, viewer: null, profilePending: true, me: undefined },
        { browser: NEW_YORK, viewer: 'user-1', profilePending: true, me: undefined }, // /me out
        { browser: NEW_YORK, viewer: 'user-1', profilePending: false, me: tokyo },
        { browser: NEW_YORK, viewer: 'user-1', profilePending: true, me: tokyo },
        { browser: NEW_YORK, viewer: 'user-1', profilePending: false, me: tokyo },
      ]),
    ).toEqual([
      SEOUL_TIME_ZONE,
      SEOUL_TIME_ZONE,
      SEOUL_TIME_ZONE,
      'Asia/Tokyo',
      'Asia/Tokyo',
      'Asia/Tokyo',
    ]);
  });

  it('follows a saved zone at once, and back to the browser when following it again', () => {
    expect(
      provider([
        {
          browser: NEW_YORK,
          viewer: 'user-1',
          profilePending: false,
          me: profileOf('user-1', null),
        },
        {
          browser: NEW_YORK,
          viewer: 'user-1',
          profilePending: false,
          me: profileOf('user-1', 'UTC'),
        },
        {
          browser: NEW_YORK,
          viewer: 'user-1',
          profilePending: false,
          me: profileOf('user-1', null),
        },
      ]),
    ).toEqual([NEW_YORK, 'UTC', NEW_YORK]);
  });

  it("starts over from Seoul for another viewer, never reading one account's screens in another's zone", () => {
    const a = profileOf('user-a', 'America/Los_Angeles');
    const b = profileOf('user-b', 'Asia/Tokyo');
    expect(
      provider([
        { browser: NEW_YORK, viewer: 'user-a', profilePending: false, me: a },
        // Another tab signed in as B: the session names B before the guard has reset `['me']`…
        { browser: NEW_YORK, viewer: 'user-b', profilePending: false, me: a },
        // …then the reset, B's /me in flight, and its answer.
        { browser: NEW_YORK, viewer: 'user-b', profilePending: true, me: undefined },
        { browser: NEW_YORK, viewer: 'user-b', profilePending: false, me: b },
        // Signed out: Seoul until the session is known to be gone, then the browser's zone.
        { browser: NEW_YORK, viewer: null, profilePending: true, me: b },
        { browser: NEW_YORK, viewer: null, profilePending: false, me: undefined },
      ]),
    ).toEqual([
      'America/Los_Angeles',
      SEOUL_TIME_ZONE,
      SEOUL_TIME_ZONE,
      'Asia/Tokyo',
      SEOUL_TIME_ZONE,
      NEW_YORK,
    ]);
  });
});

describe('timeZoneSaveFailure', () => {
  const invalid = (path: string[]) =>
    new ApiError(400, {
      code: 'VALIDATION_ERROR',
      message: 'invalid',
      details: [{ path, message: 'must be an IANA time zone name' }],
    });

  it("puts a zone the server's Intl does not know under the select, with no toast", () => {
    expect(timeZoneSaveFailure(invalid(['timeZone']))).toEqual({
      kind: 'field',
      message: copy.errTimeZoneInvalid,
    });
  });

  it('says the signed-in account changed for the 403 naming expectedAccountId (A-PG-24)', () => {
    const forbidden = new ApiError(403, {
      code: 'FORBIDDEN',
      message: 'other account',
      details: [{ path: ['expectedAccountId'], message: 'session belongs to another account' }],
    });
    expect(timeZoneSaveFailure(forbidden)).toEqual({ kind: 'toast', title: copy.sessionChanged });
  });

  it('is the generic failure for anything else, a 400 on another field included', () => {
    const generic = (error: unknown) => {
      const failure = timeZoneSaveFailure(error);
      return failure.kind === 'toast' ? failure.title : failure.message;
    };
    expect(generic(invalid(['expectedAccountId']))).toBe(copy.errUnknown);
    expect(generic(new ApiError(403, { code: 'FORBIDDEN', message: 'origin' }))).toBe(
      copy.errUnknown,
    );
    expect(generic(new ApiError(500, { code: 'INTERNAL', message: 'x' }))).toBe(copy.errUnknown);
    expect(timeZoneSaveFailure(new Error('네트워크'))).toEqual({
      kind: 'toast',
      title: copy.errUnknown,
      description: '네트워크',
    });
  });
});

/**
 * ADR-0061 #60-8 splits the screens in two: an admin screen reads every time in KST, a member
 * screen in the member's zone. `formatKst` is the first and `useFormatDateTime` the second, so a
 * member screen that calls `formatKst` shows KST to a member in New York, unmarked — the very
 * thing the decision removed. A file outside `app/admin/` may call it only from a declaration
 * listed here, and each of those may be used only by an admin screen.
 */
const ADMIN_DIR = `${path.join(SRC, 'app', 'admin')}${path.sep}`;

const KST_CALLERS: Readonly<Record<string, { names: readonly string[]; reason: string }>> = {
  'lib/datetime.ts': {
    names: ['formatKst', 'formatInTimeZone'],
    reason: 'the definition, and the floor for a zone the engine cannot read (KST, unmarked)',
  },
  'lib/market-admin.ts': {
    names: ['settlementStepViews', 'kstInstant', 'marketEventRows'],
    reason:
      'the admin market detail: 정산 단계 and the event rows (and the payload check they use)',
  },
  'lib/admin-accounts.ts': {
    names: ['formatAdminGrant'],
    reason: 'the admin accounts list: the line under an admin saying when it was granted',
  },
  'lib/admin-sms.ts': {
    names: ['smsAsOf'],
    reason: 'the admin SMS send status (ADR-0070): 기준 시각, when the counts were read',
  },
  'lib/moderation.ts': {
    names: ['adminRestrictionEndText', 'endChangeText', 'operatorLineText'],
    reason:
      'the admin moderation pages (#50, ADR-0081): who processed, acted or cancelled, and when; ' +
      'a writing restriction’s end and each change of it (#185, ADR-0082)',
  },
  'lib/admin-link-flags.ts': {
    names: ['labelledTime'],
    reason:
      'the admin repeated-link review list (ADR-0083): when an item was caught, written, ' +
      'edited, deleted and hidden, a group’s latest entry, and when an operator marked it',
  },
};

/**
 * The top-level declarations of `file` that call `formatKst` — under its own name or the local
 * name an import gives it (`usesOf`) — by name.
 */
function kstCallersIn(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const lineOf = (position: number) => tree.getLineAndCharacterOfPosition(position).line + 1;
  const names = new Set<string>();
  for (const use of usesOf(file, source, ['formatKst'])) {
    const statement = tree.statements.find(
      (candidate) =>
        lineOf(candidate.getStart(tree)) <= use.line && use.line <= lineOf(candidate.getEnd()),
    );
    if (statement !== undefined && ts.isFunctionDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
    } else if (statement !== undefined && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        names.add(declaration.name.getText(tree));
      }
    } else {
      names.add(`<line ${String(use.line)}>`);
    }
  }
  return [...names].sort();
}

describe('member screens read absolute times in the display zone (ADR-0063)', () => {
  const memberSources = screenSources().filter((file) => !file.startsWith(ADMIN_DIR));

  it('calls formatKst outside app/admin/ only from the declarations listed', () => {
    const found = Object.fromEntries(
      memberSources
        .map(
          (file) =>
            [path.relative(SRC, file).split(path.sep).join('/'), kstCallersIn(file)] as const,
        )
        .filter(([, names]) => names.length > 0),
    );
    expect(found).toEqual(
      Object.fromEntries(
        Object.entries(KST_CALLERS).map(([file, { names }]) => [file, [...names].sort()]),
      ),
    );
  });

  it('uses those KST declarations only on admin screens', () => {
    const adminOnly = Object.entries(KST_CALLERS)
      .filter(([file]) => file !== 'lib/datetime.ts')
      .flatMap(([, { names }]) => names);
    const outside = memberSources
      .filter((file) => !Object.keys(KST_CALLERS).some((own) => file === path.join(SRC, own)))
      .flatMap((file) =>
        usesOf(file, readFileSync(file, 'utf8'), adminOnly).map(
          (use) => `${path.relative(SRC, file)}:${String(use.line)} ${use.name}`,
        ),
      );
    expect(outside).toEqual([]);
  });
});
