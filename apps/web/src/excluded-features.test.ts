import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ADMIN_SCREEN_FEATURES,
  type AllowanceScope,
  EXCLUDED_FEATURE_IDS,
  type ExcludedFeatureId,
  PAID_COIN_SALES_ENABLED,
  findExcludedIdentifier,
  findExcludedText,
} from '@buddha/shared';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { type CopyKey, copy } from './copy';
import {
  LEGAL_BODIES,
  SCRIPT,
  SRC,
  type SourcePlace,
  copyRefsOf,
  literalsOf,
  localImportsOf,
  screenSources,
  scriptKindOf,
  usesOf,
} from './test/screen-text';

/**
 * What the plan leaves out must not come back to a screen (#113): no screen text, screen address
 * or menu link names an excluded feature of EXCLUDED_FEATURES (@buddha/shared). The text is the
 * copy, key by key, and every string literal, template literal and JSX text under `src/`
 * (test/screen-text.ts); the addresses are the route folders under `app/` and the folders and
 * page files under `pages/` (routeNames), and the menus and links are every internal path a
 * source writes down (`'/my/wallet'`, the header's and MY's lists, the admin menu, the footer,
 * redirects). The admin screens' text is held to the gambling words only (owner decision
 * 2026-10-14 #113); their addresses and links like any other. Word allowances common to all text
 * live with the list; the ones below are this app's: which code may still name paid Coin, which
 * copy names a feature on purpose, and where the service guide will be.
 */

const at = (...parts: string[]) => path.join(SRC, ...parts);
const APP = at('app');
const COPY = at('copy.ts');
const ADMIN_ROOT = at('app', 'admin');

function under(file: string, root: string): boolean {
  return file === root || file.startsWith(`${root}${path.sep}`);
}

/**
 * Code kept for paid Coin while it is closed (D9, ADR-0049): it may name 충전·결제·쿠폰, draw a
 * price and link to the paid pages, because nothing in it reaches a member's screen while
 * PAID_COIN_SALES_ENABLED is false — a page that answers not found, a component drawn only in
 * the branch the switch opens, an admin page the menu no longer lists. Code outside these may
 * name paid Coin only in that branch itself (test/screen-text.ts, `gated`). A folder covers
 * everything under it. Everything else here is still checked. The admin pages' text is an admin
 * screen's anyway (ADMIN below); their lines here are for their addresses and links.
 */
const PRESERVED_PAID_SOURCES: readonly { path: string; reason: string }[] = [
  { path: at('app', 'charge'), reason: 'the public /charge page: not found while closed' },
  {
    path: at('app', 'my', 'wallet', 'charge-form.tsx'),
    reason: "the wallet's charge card: my/wallet/page.tsx draws it only while sales are on",
  },
  {
    path: at('app', 'my', 'wallet', 'coupon-form.tsx'),
    reason: "the wallet's coupon form: likewise",
  },
  {
    path: at('app', 'my', 'wallet', 'payment-history.tsx'),
    reason: "the wallet's 결제 내역: likewise",
  },
  {
    path: at('app', 'admin', 'charge-packages'),
    reason: 'admin 충전 상품: off the admin menu, open by address (owner decision 2026-10-13 #112)',
  },
  { path: at('app', 'admin', 'coupons'), reason: 'admin 쿠폰: likewise' },
  { path: at('app', 'admin', 'payments'), reason: 'admin 결제: likewise' },
  { path: at('lib', 'charge-guide.ts'), reason: "/charge's helpers and its link to the wallet" },
  { path: at('lib', 'payments.ts'), reason: "결제 내역's labels and the admin refund's rules" },
];

/** Functions that draw a price in won, i.e. a price table (N06). */
const PRICE_FORMATTERS = ['formatKrw'] as const;

/**
 * The service guide (#136) is the one page that may say what the product does not offer —
 * '점수·순위를 제공하지 않습니다' (owner decision 2026-10-13 #113); the no-cash notice may stand
 * anywhere. The guide's sources go under this route group, which leaves its address to #136 (a
 * route group is not part of the URL). Nothing is there yet, so today every such sentence fails
 * wherever it is written.
 */
const SERVICE_GUIDE_ROOT = at('app', '(service-guide)');

/**
 * Copy a member's screen shows that names an excluded feature on purpose, key by key: the
 * feature, the words it may use, and why. No other copy may.
 */
const COPY_ALLOWANCES: readonly {
  key: CopyKey;
  feature: ExcludedFeatureId;
  words: readonly string[];
  reason: string;
}[] = [
  ...(
    ['ledgerTypeDeposit', 'ledgerTypePaymentCancel', 'ledgerTypePaymentCancelReversal'] as const
  ).map((key) => ({
    key,
    feature: 'paid-purchase' as const,
    words: ['충전', '결제'],
    reason:
      "The wallet's 이용 내역 names the kept ledger types (D9, ADR-0049): rows from before sales " +
      'closed, not an offer. None is written while they are closed.',
  })),
];

function isPreservedPaid(file: string): boolean {
  return PRESERVED_PAID_SOURCES.some((source) => under(file, source.path));
}

/**
 * Next's entry points outside `app/`: Next loads them on every request, whoever else imports
 * them, so they are never an admin screen's alone.
 */
const ENTRY_POINTS: readonly string[] = [at('proxy.ts')];

function scopeOf(file: string): AllowanceScope {
  return under(file, SERVICE_GUIDE_ROOT) ? 'service-guide' : 'everywhere';
}

/** The features to look for in code that paid Coin's switch hides, or not. */
function featuresFor(paidHidden: boolean): ExcludedFeatureId[] {
  return EXCLUDED_FEATURE_IDS.filter((id) => !(paidHidden && id === 'paid-purchase'));
}

function describeHits(where: string, text: string, hits: { feature: string; match: string }[]) {
  return hits.map((hit) => `${where}: ${hit.feature} '${hit.match}' in ${JSON.stringify(text)}`);
}

const SOURCES = screenSources();
const SOURCE_TEXT = new Map(SOURCES.map((file) => [file, readFileSync(file, 'utf8')]));
const source = (file: string) => SOURCE_TEXT.get(file) ?? '';

/**
 * The admin screens' sources: everything under `app/admin`, and every component, hook or lib
 * outside `app/` that only admin code imports (a test does not count). Members never see these
 * screens, so their text is held to the gambling words only (ADMIN_SCREEN_FEATURES, owner
 * decision 2026-10-14 #113). A source a member screen imports as well is a member screen's.
 */
function adminSources(): Set<string> {
  const importers = new Map<string, string[]>();
  for (const file of SOURCES) {
    for (const imported of localImportsOf(file, source(file))) {
      importers.set(imported, [...(importers.get(imported) ?? []), file]);
    }
  }
  const admin = new Set(SOURCES.filter((file) => under(file, ADMIN_ROOT)));
  for (let grew = true; grew;) {
    grew = false;
    for (const file of SOURCES) {
      if (admin.has(file) || under(file, APP) || ENTRY_POINTS.includes(file)) continue;
      const by = importers.get(file) ?? [];
      if (by.length > 0 && by.every((importer) => admin.has(importer))) {
        admin.add(file);
        grew = true;
      }
    }
  }
  return admin;
}

const ADMIN = adminSources();
const isAdmin = (file: string) => under(file, ADMIN_ROOT) || ADMIN.has(file);

/** Where each copy key is read, file by file. */
const COPY_REFS = new Map<string, (SourcePlace & { file: string })[]>();
for (const file of SOURCES) {
  for (const ref of copyRefsOf(file, source(file))) {
    const refs = COPY_REFS.get(ref.key) ?? [];
    refs.push({ ...ref, file });
    COPY_REFS.set(ref.key, refs);
  }
}

/**
 * The excluded features a copy value names, past the allowances. A key read nowhere is checked
 * like one on every screen; a key read only by admin screens, only by hidden paid code, or only
 * by the service guide, gets that code's allowance.
 */
function copyHits(key: string, value: string) {
  const refs = COPY_REFS.get(key) ?? [];
  if (refs.length > 0 && refs.every((ref) => isAdmin(ref.file))) {
    return findExcludedText(value, { features: ADMIN_SCREEN_FEATURES });
  }
  const paidHidden = refs.length > 0 && refs.every((ref) => ref.gated || isPreservedPaid(ref.file));
  const scope =
    refs.length > 0 && refs.every((ref) => scopeOf(ref.file) === 'service-guide')
      ? 'service-guide'
      : 'everywhere';
  return findExcludedText(value, { features: featuresFor(paidHidden), scope }).filter(
    (hit) =>
      !COPY_ALLOWANCES.some(
        (allowance) =>
          allowance.key === key &&
          allowance.feature === hit.feature &&
          allowance.words.includes(hit.match),
      ),
  );
}

/** The excluded features a literal of `file` names. */
function literalHits(file: string, text: string, gated: boolean) {
  if (isAdmin(file)) return findExcludedText(text, { features: ADMIN_SCREEN_FEATURES });
  return findExcludedText(text, {
    features: featuresFor(gated || isPreservedPaid(file)),
    scope: scopeOf(file),
  });
}

/** An internal screen address a literal writes down (not an API path), without its query. */
function internalPath(text: string): string | undefined {
  if (!/^\/(?!\/)/.test(text) || text.startsWith('/api/')) return undefined;
  return text.split(/[?#]/)[0];
}

/**
 * What this app serves besides pages, registered (#113, owner decision 2026-10-13 (a)): Next's
 * proxy (`proxy.ts`, or `middleware.ts`, beside `app/`), which runs before the routes it matches
 * and may answer by itself, a route handler (a `route.ts` under `app/`), a metadata route
 * (`favicon.ico`, `sitemap`, `robots`, `manifest`, an Open Graph or Twitter image, an icon under
 * `app/`, generated or static), a Pages Router API route (`pages/api/`) or a server action (a
 * `'use server'` file or function) answers a request with whatever it returns, outside the API's
 * registry and its private-data checks. Reads and writes go to the API, so only the proxy is here;
 * one added fails below until it is written here with what it answers and why it may. Keyed by the
 * file under `src/`, and a route handler by its file and each HTTP method it exports
 * (`app/feed/route.ts GET`): each is a handler of its own. docs/GUARDS.md has the rule.
 */
const WEB_SERVER_ENDPOINTS: Readonly<Record<string, string>> = {
  'proxy.ts':
    'Next 프록시(middleware의 후속): /admin·/my 요청에만 맞춰, 관리자·MY 게이트가 로그인 뒤 돌아올 주소를 만들도록 요청의 경로와 쿼리를 x-pathname·x-search 헤더에 덮어써 넘긴다(NextResponse.next). 스스로 답하지 않는다.',
};

/** Next's proxy (the successor to `middleware`): a script of that name beside `app/`. */
const PROXY = /^(?:proxy|middleware)\.[cm]?[jt]sx?$/;

/** The HTTP methods a route handler exports a function for. */
const HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Next's metadata files, by name whatever the extension: each answers a request of its own —
 * `favicon.ico`, `icon.svg`, `icon1.png`, `apple-icon.png`, `opengraph-image.jpg`,
 * `twitter-image.tsx`, `sitemap.xml`, `sitemap.ts`, `robots.txt`, `manifest.webmanifest`.
 */
const METADATA_ROUTE =
  /^(?:favicon|sitemap|robots|manifest|opengraph-image|twitter-image|icon|apple-icon)\d*\./;

/** Whether a directive prologue — the string statements a body opens with — says 'use server'. */
function saysUseServer(statements: readonly ts.Statement[]): boolean {
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === 'use server') return true;
  }
  return false;
}

/**
 * Whether a script declares a server action: a `'use server'` directive opening the module or
 * any function body, read from the syntax tree — after another directive, before a comment, on
 * one line with the code (`async function save() { 'use server'; … }`).
 */
function declaresServerAction(file: string, text: string): boolean {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const visit = (node: ts.Node): true | undefined =>
    (ts.isBlock(node) && ts.isFunctionLike(node.parent) && saysUseServer(node.statements)) ||
    ts.forEachChild(node, visit);
  return saysUseServer(tree.statements) || ts.forEachChild(tree, visit) === true;
}

/** Whether `node` carries the `export` modifier. */
const exported = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

/** Whether `node` is `exports` or `module.exports`. */
const isCommonJsExports = (node: ts.Expression) =>
  (ts.isIdentifier(node) && node.text === 'exports') ||
  (ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'module' &&
    node.name.text === 'exports');

/**
 * The HTTP methods a route handler exports, in the order it writes them: `export function GET`,
 * `export const PUT = …` (destructured too), `export { handler as POST }`, a re-export by name,
 * and CommonJS (`exports.GET =`, `module.exports = { GET }`). `export * from` stands for whatever
 * the other module exports and is read as `*`.
 */
function routeMethodsOf(file: string, text: string): string[] {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const names: string[] = [];
  const bindings = (name: ts.BindingName): string[] =>
    ts.isIdentifier(name)
      ? [name.text]
      : name.elements.flatMap((element) =>
          ts.isOmittedExpression(element) ? [] : bindings(element.name),
        );
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && exported(node) && node.name) {
      names.push(node.name.text);
    } else if (ts.isVariableStatement(node) && exported(node)) {
      names.push(...node.declarationList.declarations.flatMap((d) => bindings(d.name)));
    } else if (ts.isExportDeclaration(node)) {
      if (node.exportClause === undefined) names.push('*');
      else if (ts.isNamedExports(node.exportClause)) {
        names.push(...node.exportClause.elements.map((element) => element.name.text));
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const target = node.left;
      if (ts.isPropertyAccessExpression(target) && isCommonJsExports(target.expression)) {
        names.push(target.name.text);
      } else if (isCommonJsExports(target) && ts.isObjectLiteralExpression(node.right)) {
        names.push(
          ...node.right.properties.flatMap((property) =>
            property.name && ts.isIdentifier(property.name) ? [property.name.text] : [],
          ),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return [...new Set(names.filter((name) => name === '*' || HTTP_METHODS.has(name)))];
}

/** Why a file is a server endpoint, or undefined when it is not one. */
function serverEndpointOf(file: string, text: string): string | undefined {
  const name = path.basename(file);
  if (path.dirname(file) === SRC && PROXY.test(name)) return 'proxy';
  if (under(file, APP) && /^route\./.test(name) && SCRIPT.test(name)) return 'route handler';
  if (under(file, APP) && METADATA_ROUTE.test(name)) return 'metadata route';
  if (under(file, at('pages', 'api'))) return 'API route';
  if (SCRIPT.test(name) && declaresServerAction(file, text)) return 'server action';
  return undefined;
}

/**
 * What a file registers as, keyed as WEB_SERVER_ENDPOINTS is: nothing when it serves nothing, the
 * file under `src/` for one endpoint, the file and each method for a route handler.
 */
function endpointKeysOf(file: string, text: string): string[] {
  const kind = serverEndpointOf(file, text);
  if (kind === undefined) return [];
  const key = path.relative(SRC, file).split(path.sep).join('/');
  const methods = kind === 'route handler' ? routeMethodsOf(file, text) : [];
  return methods.length === 0 ? [key] : methods.map((method) => `${key} ${method}`);
}

/**
 * Every file that could answer a request, whatever its extension (the screen walk reads scripts
 * only): everything under `app/` and `pages/`, and every script under `src/`, where a server
 * action's directive may stand. Tests and the test support are not served.
 */
function servedFiles(dir: string = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return full === at('test') ? [] : servedFiles(full);
    if (/\.(test|d)\.[cm]?[jt]sx?$/.test(entry.name)) return [];
    return under(full, APP) || under(full, at('pages')) || SCRIPT.test(entry.name) ? [full] : [];
  });
}

/** The Pages Router's own files, which no address serves: the app and document wrappers, the error page. */
const PAGES_ROUTER_SPECIAL = /^_(?:app|document|error)$/;

/**
 * Every name a screen address is made of, with the file or folder it comes from: each route
 * folder under `app/`, and under `pages/` (Next's Pages Router, served beside `app/`) each folder
 * and each page file's own name — `pages/rankings.tsx` is served at `/rankings` — less
 * `pages/api` (an API route: WEB_SERVER_ENDPOINTS), `_app`, `_document`, `_error` and `index`,
 * which names no segment. Tests are not pages.
 */
function routeNames(src: string = SRC): { file: string; name: string }[] {
  const pagesApi = path.join(src, 'pages', 'api');
  const walk = (dir: string, pagesRouter: boolean): { file: string; name: string }[] =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            return file === pagesApi
              ? []
              : [{ file, name: entry.name }, ...walk(file, pagesRouter)];
          }
          if (!pagesRouter || !SCRIPT.test(entry.name)) return [];
          if (/\.(test|d)\.[cm]?[jt]sx?$/.test(entry.name)) return [];
          const name = entry.name.replace(SCRIPT, '');
          return name === 'index' || PAGES_ROUTER_SPECIAL.test(name) ? [] : [{ file, name }];
        })
      : [];
  return [...walk(path.join(src, 'app'), false), ...walk(path.join(src, 'pages'), true)];
}

describe('excluded features on screens (#113)', () => {
  it('reads screen text the way it renders, and sees what the sales switch hides', () => {
    const planted = [
      'const a = <Text>{copy.walletTitle} 출석 체크</Text>;',
      'const b = PAID_COIN_SALES_ENABLED ? <Text>충전하기</Text> : null;',
      'const c = PAID_COIN_SALES_ENABLED && copy.chargeSubmit;',
      'if (PAID_COIN_SALES_ENABLED) { label = `${n}원`; }',
      "const e = PAID_COIN_SALES_ENABLED ? null : '충전하기';",
      '// 점수 in a comment is not screen text',
    ].join('\n');
    const literals = literalsOf('planted.tsx', planted).map(({ line, text, gated }) => ({
      line,
      text,
      gated,
    }));
    expect(literals).toEqual([
      { line: 1, text: '0 출석 체크', gated: false },
      { line: 2, text: '충전하기', gated: true },
      { line: 4, text: '0원', gated: true },
      { line: 5, text: '충전하기', gated: false },
    ]);
    expect(copyRefsOf('planted.tsx', planted).map(({ key, gated }) => ({ key, gated }))).toEqual([
      { key: 'walletTitle', gated: false },
      { key: 'chargeSubmit', gated: true },
    ]);
    const visible = (text: string) => literalHits(at('app', 'x.tsx'), text, false);
    expect(visible('0 출석 체크').map((hit) => hit.feature)).toEqual(['activity-reward']);
    expect(visible('충전하기').map((hit) => hit.feature)).toEqual(['paid-purchase']);
    expect(literalHits(at('app', 'x.tsx'), '충전하기', true)).toEqual([]);
    expect(literalHits(at('app', 'charge', 'x.tsx'), '충전하기', false)).toEqual([]);
    // Hidden paid code is still held to everything else.
    expect(literalHits(at('app', 'charge', 'x.tsx'), '베팅', false)).toHaveLength(1);
  });

  it('reads JavaScript screen sources as well: JSX text in .jsx, imports of .js and .jsx', () => {
    const page = 'export default function Page() { return <p>출석 체크</p>; }';
    expect(literalsOf(at('app', 'x', 'page.jsx'), page).map(({ text }) => text)).toEqual([
      '출석 체크',
    ]);
    const dir = mkdtempSync(path.join(tmpdir(), 'screen-imports-'));
    try {
      for (const name of ['card.jsx', 'format.js', 'page.jsx']) {
        writeFileSync(path.join(dir, name), '');
      }
      expect(
        localImportsOf(
          path.join(dir, 'page.jsx'),
          "import Card from './card';\nimport { format } from './format';",
        ),
      ).toEqual([path.join(dir, 'card.jsx'), path.join(dir, 'format.js')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows a negative notice on the service guide only (owner decisions 2026-10-13, 2026-10-14 #113)', () => {
    const member = at('app', 'my', 'page.tsx');
    const guide = path.join(SERVICE_GUIDE_ROOT, 'guide', 'page.tsx');
    const features = (file: string, text: string) => [
      ...new Set(literalHits(file, text, false).map((hit) => hit.feature)),
    ];
    for (const [notice, named] of [
      ['점수·순위를 제공하지 않습니다.', ['scoring']],
      // The #14 terms and 예측 too, since 2026-10-14.
      ['확률 입력이나 투표 기능은 없습니다.', ['probability-input', 'replaced-term']],
      ['시장가격은 확률이 아닙니다.', ['replaced-term']],
      ['이 서비스의 거래는 예측이나 투표가 아닙니다.', ['replaced-term', 'prediction-word']],
    ] as const) {
      expect(features(member, notice), notice).toEqual(named);
      expect(features(guide, notice), notice).toEqual([]);
    }
    // A gambling word fails there too, and a sentence that is no notice.
    expect(features(guide, '베팅은 할 수 없습니다.')).toEqual(['gambling']);
    expect(features(guide, '확률이 오르면 투표하세요.')).toEqual(['replaced-term']);
    // The no-cash notice stands anywhere.
    expect(literalHits(member, copy.walletNotice, false)).toEqual([]);
  });

  it('knows the admin screens: app/admin and what only it imports', () => {
    expect(
      localImportsOf(
        at('app', 'admin', 'x.tsx'),
        [
          "import { api } from '@/lib/api';",
          "import Page from './admins/page';",
          "export { default } from '../my/page';",
          "const later = () => import('@/copy');",
          "import { z } from 'zod';",
          "import missing from '@/lib/missing';",
        ].join('\n'),
      ),
    ).toEqual([
      at('lib', 'api.ts'),
      at('app', 'admin', 'admins', 'page.tsx'),
      at('app', 'my', 'page.tsx'),
      at('copy.ts'),
    ]);
    for (const file of [
      at('app', 'admin', 'layout.tsx'),
      at('lib', 'admin-accounts.ts'),
      at('hooks', 'use-admin-payments.ts'),
      at('lib', 'market-form.ts'),
    ]) {
      expect(ADMIN.has(file), file).toBe(true);
    }
    // What a member screen imports as well is a member screen's (use-markets.ts re-exports from
    // use-admin-markets.ts), and Next's proxy is its own.
    for (const file of [
      COPY,
      at('lib', 'api.ts'),
      at('hooks', 'use-wallet.ts'),
      at('hooks', 'use-admin-markets.ts'),
      at('proxy.ts'),
    ]) {
      expect(ADMIN.has(file), file).toBe(false);
    }
  });

  it('holds the admin screens to the gambling words only (owner decision 2026-10-14 #113)', () => {
    const admin = at('app', 'admin', 'markets', 'page.tsx');
    expect(literalHits(admin, '거래량 순위 1위 시장의 확률', false)).toEqual([]);
    expect(literalHits(admin, '충전 1,000원', false)).toEqual([]);
    expect(literalHits(admin, '베팅 한도', false).map((hit) => hit.feature)).toEqual(['gambling']);
    // The same text on a member's screen.
    expect(
      literalHits(at('app', 'my', 'page.tsx'), '거래량 순위 1위 시장의 확률', false).map(
        (hit) => hit.feature,
      ),
    ).toEqual(['scoring', 'replaced-term']);
  });

  it('keeps paid Coin closed, which the allowances for its kept code rely on', () => {
    // Opening sales (#111) puts a price list and a charge button on members' screens, which N06
    // leaves out of the initial product; whoever opens them revisits this check with the plan.
    expect(PAID_COIN_SALES_ENABLED).toBe(false);
    for (const { path: kept } of PRESERVED_PAID_SOURCES) expect(existsSync(kept), kept).toBe(true);
  });

  it('is not in any copy value', () => {
    expect(COPY_REFS.get('walletNotice')?.length).toBeGreaterThan(0);
    const hits = Object.entries(copy).flatMap(([key, value]) =>
      describeHits(`copy.${key}`, value, copyHits(key, value)),
    );
    expect(hits).toEqual([]);
  });

  it('allows copy only where an allowance is still needed', () => {
    for (const allowance of COPY_ALLOWANCES) {
      const value = copy[allowance.key];
      const named = findExcludedText(value, { features: [allowance.feature] });
      expect(named.length, `copy.${allowance.key} no longer needs its allowance`).toBeGreaterThan(
        0,
      );
    }
  });

  it('is not in any string or JSX text under src/ outside the copy and the legal bodies', () => {
    // The walk reached the screens and legal/'s screen code, and skipped the legal bodies and
    // the test support.
    expect(SOURCES).toContain(at('components', 'layout', 'nav.tsx'));
    expect(SOURCES).toContain(at('legal', 'business-info.ts'));
    expect(SOURCES.filter((file) => LEGAL_BODIES.includes(file))).toEqual([]);
    expect(SOURCES.filter((file) => under(file, at('test')))).toEqual([]);
    const hits = SOURCES.filter((file) => file !== COPY).flatMap((file) =>
      literalsOf(file, source(file)).flatMap((literal) =>
        describeHits(
          `${path.relative(SRC, file)}:${String(literal.line)}`,
          literal.text,
          literalHits(file, literal.text, literal.gated),
        ),
      ),
    );
    expect(hits).toEqual([]);
  });

  it('draws no price in won outside the kept paid code and the admin screens (N06: no price table)', () => {
    const uses = SOURCES.filter((file) => !isPreservedPaid(file) && !isAdmin(file)).flatMap(
      (file) =>
        usesOf(file, source(file), PRICE_FORMATTERS)
          .filter((use) => !use.gated)
          .map((use) => `${path.relative(SRC, file)}:${String(use.line)}: ${use.name}`),
    );
    expect(uses).toEqual([]);
  });

  it('finds a price formatter however the file names it: an alias, a namespace, a string key', () => {
    const uses = (text: string) =>
      usesOf(at('app', 'x.tsx'), text, PRICE_FORMATTERS).map(({ line, name }) => ({ line, name }));
    expect(
      uses(
        [
          "import { formatKrw as money, formatCoin } from '@buddha/shared';",
          'const a = <Text>{money(price)}</Text>;',
          'const b = formatCoin(balance);',
        ].join('\n'),
      ),
    ).toEqual([{ line: 2, name: 'formatKrw as money' }]);
    expect(
      uses(
        [
          "import * as shared from '@buddha/shared';",
          'const a = shared.formatKrw(price);',
          "const b = shared['formatKrw'](price);",
          'const { formatKrw: won } = shared;',
        ].join('\n'),
      ),
    ).toEqual([
      { line: 2, name: 'formatKrw' },
      { line: 3, name: 'formatKrw' },
      { line: 4, name: 'formatKrw' },
    ]);
    // The import itself is no use: a file that imports and never calls it draws no price.
    expect(uses("import { formatKrw as money } from '@buddha/shared';")).toEqual([]);
  });

  it('holds the legal bodies to the gambling words until #137 revises them', () => {
    // The rest — the old '예측', 'P 충전', the 순위 nickname clause — stays until #137.
    const hits = LEGAL_BODIES.flatMap((file) =>
      literalsOf(file, readFileSync(file, 'utf8')).flatMap((literal) =>
        describeHits(
          `${path.relative(SRC, file)}:${String(literal.line)}`,
          literal.text,
          findExcludedText(literal.text, { features: ['gambling'] }),
        ),
      ),
    );
    expect(hits).toEqual([]);
  });
});

describe('excluded features in screen addresses and menus (#113)', () => {
  it('has no route folder or page that names one', () => {
    const names = routeNames();
    expect(names.map(({ file }) => file)).toContain(at('app', 'my', 'wallet'));
    const hits = names.flatMap(({ file, name }) =>
      findExcludedIdentifier(name, 'route', {
        features: featuresFor(isPreservedPaid(file)),
      }).map((hit) => `${path.relative(SRC, file)}: ${hit.feature} '${hit.word}'`),
    );
    expect(hits).toEqual([]);
  });

  it('reads the Pages Router as well: its folders and page files are addresses too', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'route-names-'));
    try {
      const files = [
        'app/my/wallet/page.tsx',
        'pages/rankings.tsx',
        'pages/leaderboard/index.tsx',
        'pages/leaderboard/[season].jsx',
        'pages/index.tsx',
        'pages/_app.tsx',
        'pages/_document.tsx',
        'pages/_error.tsx',
        'pages/rankings.test.tsx',
        'pages/api/score.ts',
      ];
      for (const file of files) {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        writeFileSync(path.join(dir, file), '');
      }
      expect(
        routeNames(dir)
          .map(({ file, name }) => `${path.relative(dir, file).split(path.sep).join('/')} ${name}`)
          .sort(),
      ).toEqual([
        'app/my my',
        'app/my/wallet wallet',
        'pages/leaderboard leaderboard',
        'pages/leaderboard/[season].jsx [season]',
        'pages/rankings.tsx rankings',
      ]);
      expect(findExcludedIdentifier('rankings', 'route').map((hit) => hit.feature)).toEqual([
        'scoring',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('links to none: no internal path in a menu, a link or a redirect names one', () => {
    const paths = SOURCES.flatMap((file) =>
      literalsOf(file, source(file)).flatMap((literal) => {
        const pathname = internalPath(literal.text);
        return pathname === undefined ? [] : [{ file, pathname, literal }];
      }),
    );
    // The walk found the menus: the header's areas, MY's tabs, the admin menu, the footer.
    for (const menuPath of ['/community', '/my/wallet', '/admin/markets', '/terms']) {
      expect(paths.map((p) => p.pathname)).toContain(menuPath);
    }
    const hits = paths.flatMap(({ file, pathname, literal }) => {
      const where = `${path.relative(SRC, file)}:${String(literal.line)}`;
      return findExcludedIdentifier(pathname, 'route', {
        features: featuresFor(literal.gated || isPreservedPaid(file)),
      }).map((hit) => `${where}: ${hit.feature} '${hit.word}' in ${pathname}`);
    });
    expect(hits).toEqual([]);
  });

  it('reads a screen address, not an API path or a protocol-relative URL', () => {
    expect(internalPath('/my/wallet?package=0')).toBe('/my/wallet');
    expect(internalPath('/login#top')).toBe('/login');
    expect(internalPath('/api/v1/me')).toBeUndefined();
    expect(internalPath('//evil.example')).toBeUndefined();
    expect(internalPath('market-status-badge')).toBeUndefined();
  });
});

describe('what the web serves besides pages (#113)', () => {
  it('knows Next’s proxy beside app/: it runs before the routes it matches and may answer itself', () => {
    for (const name of ['proxy.ts', 'proxy.js', 'proxy.mjs', 'middleware.ts', 'middleware.js']) {
      expect(serverEndpointOf(at(name), ''), name).toBe('proxy');
    }
    // Only there: a file of that name anywhere else is no entry point.
    expect(serverEndpointOf(at('lib', 'proxy.ts'), '')).toBeUndefined();
    expect(serverEndpointOf(at('app', 'middleware.ts'), '')).toBeUndefined();
    expect(serverEndpointOf(at('proxy.md'), '')).toBeUndefined();
  });

  it('reads each HTTP method a route handler exports, however it exports it', () => {
    const route = at('app', 'feed', 'route.ts');
    const methods = (text: string) => routeMethodsOf(route, text);
    expect(methods('export async function GET() {}\nexport function POST() {}')).toEqual([
      'GET',
      'POST',
    ]);
    expect(
      methods(
        'export const PUT = async () => Response.json({});\nexport const { PATCH, DELETE } = h;',
      ),
    ).toEqual(['PUT', 'PATCH', 'DELETE']);
    expect(
      methods('const h = () => new Response();\nexport { h as GET, h as HEAD, h as OPTIONS };'),
    ).toEqual(['GET', 'HEAD', 'OPTIONS']);
    expect(methods("export { GET, handler as POST } from './handlers';")).toEqual(['GET', 'POST']);
    // A re-export of everything cannot be read: it stands for whatever that module exports.
    expect(methods("export * from './handlers';")).toEqual(['*']);
    expect(
      routeMethodsOf(
        at('app', 'feed', 'route.js'),
        'exports.GET = async () => {};\nmodule.exports.POST = h;\nmodule.exports = { PUT, DELETE: h };',
      ),
    ).toEqual(['GET', 'POST', 'PUT', 'DELETE']);
    // Not a method: another export, a local, another case.
    expect(
      methods("export const dynamic = 'force-static';\nconst GET = 1;\nexport function get() {}"),
    ).toEqual([]);
    // Each method is its own registry entry; a file that exports none is one entry.
    expect(endpointKeysOf(route, 'export function GET() {}\nexport function POST() {}')).toEqual([
      'app/feed/route.ts GET',
      'app/feed/route.ts POST',
    ]);
    expect(endpointKeysOf(route, '')).toEqual(['app/feed/route.ts']);
    expect(endpointKeysOf(at('proxy.ts'), 'export function proxy() {}')).toEqual(['proxy.ts']);
    expect(endpointKeysOf(at('app', 'x', 'page.tsx'), '')).toEqual([]);
  });

  it('knows a route handler, a metadata route, an API route and a server action', () => {
    expect(serverEndpointOf(at('app', 'feed', 'route.ts'), '')).toBe('route handler');
    expect(serverEndpointOf(at('app', 'feed', 'route.js'), '')).toBe('route handler');
    for (const name of [
      'favicon.ico',
      'icon.ico',
      'icon.svg',
      'icon1.png',
      'icon.tsx',
      'apple-icon.png',
      'apple-icon.ts',
      'opengraph-image.jpg',
      'opengraph-image.gif',
      'twitter-image.png',
      'twitter-image.tsx',
      'sitemap.xml',
      'sitemap.ts',
      'robots.txt',
      'robots.js',
      'manifest.json',
      'manifest.webmanifest',
      'manifest.ts',
    ]) {
      expect(serverEndpointOf(at('app', name), ''), name).toBe('metadata route');
    }
    expect(serverEndpointOf(at('app', 'markets', 'opengraph-image.tsx'), '')).toBe(
      'metadata route',
    );
    expect(serverEndpointOf(at('pages', 'api', 'me.js'), '')).toBe('API route');
    expect(serverEndpointOf(at('pages', 'api', 'me.ts'), '')).toBe('API route');
    expect(serverEndpointOf(at('app', 'market-icons.tsx'), '')).toBeUndefined();
    expect(serverEndpointOf(at('app', 'favicons.tsx'), '')).toBeUndefined();
    expect(serverEndpointOf(at('lib', 'route.ts'), '')).toBeUndefined();
  });

  it('reads a server action from the syntax: the directive opening a module or a function body', () => {
    const page = at('app', 'x', 'page.tsx');
    for (const text of [
      "'use server';\n",
      "'use server' // reads the session\nexport async function load() {}",
      '/* actions */\n\'use strict\';\n"use server";\n',
      'async function save() {\n  "use server"\n}',
      "async function save() { 'use server'; return secret; }",
      "async function save() { 'use server' /* inline */; return secret; }",
      "export const save = async () => { 'use server'; return secret; };",
      "const form = { save: async function () { 'use server'; } };",
      "class Form { async save() { 'use server'; } }",
      [
        'export default function Page() {',
        "  async function save() { 'use server'; }",
        '  return <form action={save} />;',
        '}',
      ].join('\n'),
    ]) {
      expect(serverEndpointOf(page, text), text).toBe('server action');
    }
    expect(serverEndpointOf(at('lib', 'actions.js'), "'use server';\nexports.x = 1;")).toBe(
      'server action',
    );
    expect(
      serverEndpointOf(at('lib', 'actions.jsx'), "'use server';\nexport const x = <b />;"),
    ).toBe('server action');
    // Not a directive: another string, a statement before it, a comment, a value, a call, a
    // block that is no function body, a template.
    for (const text of [
      "'use client';\n",
      "import x from 'y';\n'use server';\n",
      "function save() { log(); 'use server'; }",
      "// 'use server'\n",
      "const directive = 'use server';",
      "register('use server');",
      "if (ok) { 'use server'; }",
      '`use server`;',
      "('use server');",
    ]) {
      expect(serverEndpointOf(page, text), text).toBeUndefined();
    }
    // A file that is no script is never read for one.
    expect(serverEndpointOf(at('lib', 'notes.txt'), "'use server';\n")).toBeUndefined();
  });

  it('registers every one, with a reason', () => {
    const files = servedFiles();
    // The walk reached past the screen sources: every file under app/, whatever it is.
    expect(files).toEqual(expect.arrayContaining(SOURCES.filter((file) => under(file, APP))));
    expect(files.filter((file) => under(file, at('test')) || /\.test\./.test(file))).toEqual([]);
    const found = files.flatMap((file) =>
      endpointKeysOf(file, SCRIPT.test(file) ? readFileSync(file, 'utf8') : ''),
    );
    expect(files.length).toBeGreaterThan(100);
    // The walk found the proxy.
    expect(found).toContain('proxy.ts');
    expect({
      unregistered: found.filter((key) => !(key in WEB_SERVER_ENDPOINTS)),
      stale: Object.keys(WEB_SERVER_ENDPOINTS).filter((key) => !found.includes(key)),
    }).toEqual({ unregistered: [], stale: [] });
    for (const [file, reason] of Object.entries(WEB_SERVER_ENDPOINTS)) {
      expect(reason.trim(), file).not.toBe('');
    }
  });
});
