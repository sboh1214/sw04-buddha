import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

// CI uses the app's bundled font, not the hosted image's optional CJK font packages.
// A successful browser download is insufficient: installation catches host validation
// errors as warnings, while the default launch below propagates them.
export async function verifyBrowserRuntime(baseURL) {
  assert.equal(
    process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS,
    undefined,
    'Host requirements validation must not be bypassed',
  );
  const origin = new URL(baseURL);
  assert(
    origin.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(origin.hostname) &&
      !origin.username &&
      !origin.password &&
      origin.pathname === '/' &&
      !origin.search &&
      !origin.hash,
    'The browser runtime check requires a local HTTP origin',
  );

  // Deliberately no executablePath/channel/args or skip-validation setting.
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const response = await page.goto(origin.href, { waitUntil: 'load', timeout: 30_000 });
    assert(response?.ok(), 'The local app must respond successfully');
    let fontTimer;
    const loaded = await Promise.race([
      page.evaluate(async () => {
        const { document } = globalThis;
        const family = globalThis.getComputedStyle(document.body).fontFamily;
        const probe = document.createElement('span');
        probe.id = 'ci-korean-font-probe';
        probe.textContent = '한글가나다라마바사아자차카타파하';
        document.body.append(probe);
        const faces = await document.fonts.load('16px "Pretendard Variable"', probe.textContent);
        await document.fonts.ready;
        return {
          family,
          faces: faces.map((face) => ({ family: face.family, status: face.status })),
        };
      }),
      new Promise((_, reject) => {
        fontTimer = setTimeout(() => reject(new Error('Korean font readiness timed out')), 30_000);
      }),
    ]).finally(() => clearTimeout(fontTimer));
    assert.match(loaded.family, /^['"]?Pretendard Variable['"]?(?:,|$)/);
    assert(loaded.faces.length > 0, 'The app must declare a matching Korean font face');
    assert(
      loaded.faces.every((face) => face.status === 'loaded'),
      'Korean font loading failed',
    );

    // FontFaceSet.check() can succeed with fallback glyphs. Chromium's actual rendered
    // font list proves these Hangul glyphs came from the app's custom Pretendard font.
    const session = await page.context().newCDPSession(page);
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root } = await session.send('DOM.getDocument');
    const { nodeId } = await session.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '#ci-korean-font-probe',
    });
    const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
    assert(fonts.length > 0, 'The Korean probe must render glyphs');
    assert(
      fonts.every(
        (font) => font.isCustomFont && /Pretendard/.test(font.familyName) && font.glyphCount > 0,
      ),
      'Korean glyphs must use the bundled Pretendard font without a system fallback',
    );
    return { browser: browser.version(), fonts };
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await verifyBrowserRuntime(process.env.E2E_BASE_URL ?? 'http://localhost:3000');
    console.log(JSON.stringify({ browserRuntime: 'ready', ...result }));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
