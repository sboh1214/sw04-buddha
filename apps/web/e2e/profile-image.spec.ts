import { crc32, deflateSync } from 'node:zlib';
import { type APIRequestContext, type Locator, type Page, type Response } from '@playwright/test';
import { copy } from '../src/copy';
import { createOpenMarket, expect, freshEmail, freshTag, meOf, signUp, test } from './helpers';

/**
 * 프로필 이미지 (#141, ADR-0079; owner decisions in ADR-0069 decision 3 #37-6 and decision 4 #141): a
 * member uploads an image in MY 설정 — a GIF is refused before it is sent, and a GIF named a PNG by
 * the server, by its bytes — and the server keeps the middle of it as a 512px square, which anyone
 * reads, on the public profile and as the small round image of the member's bylines (the post page,
 * a 댓글, a community card). Replacing it removes the earlier one at once, deleting it asks first
 * and removes it too, and the nickname's first letter comes back everywhere; Back from MY 설정 to the
 * profile shows each change. The type sniffing, the size, the EXIF removal, the crop, the
 * restriction hook and the permissions are the API's tests (profile-image.controller.test.ts,
 * image.test.ts, public-items*.test.ts, private-data.test.ts); this walks the screens.
 */

/** A 1×1 GIF: a type a post takes and a profile image does not (#37-6: «JPEG·PNG·WebP»). */
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

type Rgb = readonly [number, number, number];
const RED: Rgb = [255, 0, 0];
const GREEN: Rgb = [0, 255, 0];
const BLUE: Rgb = [0, 0, 255];

/**
 * A PNG of vertical bands of equal width, one per colour, `height` tall (8-bit RGB, no filter): three
 * bands of a square each make an image three times wider than tall, whose middle square is the
 * second colour alone — what the server's centre crop keeps.
 */
function bandsPng(bands: readonly Rgb[], side: number): Buffer {
  const width = side * bands.length;
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  const row = Buffer.from([
    0,
    ...bands.flatMap((rgb) => Array.from({ length: side }, () => rgb).flat()),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: side }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A PNG's width and height, from its header (IHDR is the first chunk). */
function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** A post straight at the API with the context's cookie: this spec's subject is its byline. */
async function postThroughApi(
  context: APIRequestContext,
  marketId: string,
  title: string,
  text: string,
): Promise<string> {
  const me = await meOf(context);
  const res = await context.post('/api/v1/posts', {
    data: {
      marketId,
      title,
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
      expectedAccountId: me.id,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/** A 댓글 straight at the API with the context's cookie. */
async function commentThroughApi(
  context: APIRequestContext,
  postId: string,
  body: string,
): Promise<string> {
  const me = await meOf(context);
  const res = await context.post(`/api/v1/posts/${postId}/comments`, {
    data: { parentId: null, body, expectedAccountId: me.id },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/** Whether `response` is the answer to an upload of the profile image. */
const isUpload = (response: Response) =>
  response.request().method() === 'PUT' &&
  new URL(response.url()).pathname === '/api/v1/me/profile-image';

/** The uploads the page sends from now on. */
function uploadsSent(page: Page): () => number {
  let sent = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'PUT' &&
      new URL(request.url()).pathname === '/api/v1/me/profile-image'
    )
      sent += 1;
  });
  return () => sent;
}

/** React's hydration complaints in the browser's console from now on (likes.spec.ts says why). */
function hydrationErrors(page: Page): string[] {
  const seen: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /hydrat/i.test(message.text())) seen.push(message.text());
  });
  return seen;
}

/** An avatar's image: this address, drawn (loaded and decoded), and shown over the initial. */
async function expectImage(image: Locator, src: string): Promise<void> {
  await expect(image).toHaveAttribute('src', src);
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);
  await expect(image).toBeVisible();
}

/**
 * The colour of the stored image near its left and right edges, halfway down, read in the browser
 * (the page's own origin serves it, so the canvas may be read): the middle band alone if the server
 * cut the middle square, a side band's colour otherwise. Far enough from the edges that the resize's
 * filter, which blends a few pixels across the cut, does not reach.
 */
async function edgeColours(page: Page, src: string): Promise<string[]> {
  return page.evaluate(async (address) => {
    const img = new Image();
    img.src = address;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('no 2d canvas');
    context.drawImage(img, 0, 0);
    const name = (x: number, y: number) => {
      const [r = 0, g = 0, b = 0] = context.getImageData(x, y, 1, 1).data;
      if (r > 200 && g < 60 && b < 60) return 'red';
      if (g > 200 && r < 60 && b < 60) return 'green';
      if (b > 200 && r < 60 && g < 60) return 'blue';
      return `rgb(${String(r)}, ${String(g)}, ${String(b)})`;
    };
    const middle = Math.floor(canvas.height / 2);
    return [name(24, middle), name(canvas.width - 25, middle)];
  }, src);
}

test.describe('프로필 이미지', () => {
  test('회원이 MY 설정에서 올린 이미지는 가운데를 512px 정사각형으로 자른 것이 공개 프로필과 글·댓글·카드의 작성자 표기에 보이고, GIF는 받지 않으며, 바꾸면 이전 이미지는 곧바로 없어지고, 삭제하면 닉네임 첫 글자로 돌아간다', async ({
    admin,
    page,
    request,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const me = await meOf(page.request);
    const profileUrl = `/u/${me.profile.publicId}`;
    const initial = (Array.from(me.profile.nickname.trim())[0] ?? '').toLocaleUpperCase('ko-KR');
    const postId = await postThroughApi(page.request, market.id, `이미지 글 ${tag}`, tag);
    const commentId = await commentThroughApi(page.request, postId, `이미지 댓글 ${tag}`);
    const hydration = hydrationErrors(page);
    const uploads = uploadsSent(page);

    // --- MY 설정, no image yet: the nickname's first letter (#37-6), and nothing to delete.
    await page.goto('/my/settings');
    const card = page.getByTestId('settings-profile-image');
    const preview = card.getByTestId('profile-image-preview');
    const file = card.getByTestId('profile-image-file');
    await expect(card).toContainText(copy.settingsProfileImageHint);
    await expect(preview).toHaveText(initial);
    await expect(card.getByTestId('profile-image-preview-image')).toHaveCount(0);
    await expect(card.getByTestId('profile-image-upload')).toHaveText(copy.profileImageUpload);
    await expect(card.getByTestId('profile-image-delete')).toHaveCount(0);

    // --- a GIF is refused before it is sent; a GIF named a PNG goes up and the server refuses it
    // by its bytes (#37-6: «JPEG·PNG·WebP»). Both say the profile image's three types.
    const notice = card.getByTestId('profile-image-notice');
    await file.setInputFiles({ name: 'moving.gif', mimeType: 'image/gif', buffer: GIF });
    await expect(notice).toHaveText(copy.errProfileImageType);
    // The same refusal again is a new alert, announced again: the same sentence left in the same
    // node would change nothing a screen reader hears.
    await notice.evaluate((node) => {
      node.setAttribute('data-seen', 'yes');
    });
    await file.setInputFiles({ name: 'again.gif', mimeType: 'image/gif', buffer: GIF });
    await expect(notice).toHaveText(copy.errProfileImageType);
    await expect(notice).not.toHaveAttribute('data-seen');
    expect(uploads()).toBe(0);
    const refused = page.waitForResponse(isUpload);
    await file.setInputFiles({ name: 'disguised.png', mimeType: 'image/png', buffer: GIF });
    expect((await refused).status()).toBe(422);
    await expect(card.getByTestId('profile-image-notice')).toHaveText(copy.errProfileImageType);
    expect((await meOf(page.request)).profile.imageUrl).toBeNull();

    // --- three bands, red · green · blue, three times wider than tall: stored as the middle square.
    const saved = page.waitForResponse(isUpload);
    await file.setInputFiles({
      name: 'bands.png',
      mimeType: 'image/png',
      buffer: bandsPng([RED, GREEN, BLUE], 200),
    });
    expect((await saved).status()).toBe(200);
    await expect(page.getByText(copy.profileImageSaved)).toBeVisible();
    await expect(card.getByTestId('profile-image-notice')).toHaveCount(0);
    const first = (await meOf(page.request)).profile.imageUrl;
    if (first === null) throw new Error('the upload left no image');
    expect(first).toMatch(/^\/api\/v1\/media\/[0-9a-f-]{36}$/);
    await expectImage(card.getByTestId('profile-image-preview-image'), first);
    await expect(card.getByTestId('profile-image-upload')).toHaveText(copy.profileImageReplace);
    await expect(card.getByTestId('profile-image-delete')).toBeVisible();
    // The image and its two buttons stay inside a phone's width: the page never scrolls sideways.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    // Anyone reads it (no cookie on `request`): a 512px square PNG, the green middle to its edges.
    const served = await request.get(first);
    expect(served.status()).toBe(200);
    expect(served.headers()['content-type']).toBe('image/png');
    expect(pngSize(await served.body())).toEqual({ width: 512, height: 512 });
    expect(await edgeColours(page, first)).toEqual(['green', 'green']);

    // --- the profile, from the 프로필 card: the image over the initial, in the server's HTML too.
    await page.getByTestId('settings-view-profile').click();
    await expect(page).toHaveURL(profileUrl);
    await expectImage(page.getByTestId('profile-avatar-image'), first);
    expect(await (await request.get(profileUrl)).text()).toContain(`src="${first}"`);

    // --- the bylines (#37-6: «작은 원형 + 닉네임»): the post page's, its 댓글's, the community card's.
    await page.goto(`/community/posts/${postId}`);
    await expectImage(
      page
        .getByTestId('post-screen')
        .getByTestId('post-byline')
        .first()
        .getByTestId('post-author-image'),
      first,
    );
    await expectImage(
      page.getByTestId(`comment-${commentId}`).getByTestId('post-author-image'),
      first,
    );
    await page.goto(`/community?q=${tag}`);
    await expectImage(
      page.getByTestId(`post-card-${postId}`).getByTestId('post-author-image'),
      first,
    );

    // --- replaced from MY 설정, reached from the profile: a new address, the earlier image gone
    // at once (decision 4 #141), and Back shows the new one (the router's kept page is dropped).
    await page.goto(profileUrl);
    await page.getByTestId('profile-edit').click();
    await expect(page).toHaveURL('/my/settings');
    const replaced = page.waitForResponse(isUpload);
    await file.setInputFiles({
      name: 'blue.png',
      mimeType: 'image/png',
      buffer: bandsPng([BLUE], 120),
    });
    expect((await replaced).status()).toBe(200);
    const second = (await meOf(page.request)).profile.imageUrl;
    if (second === null) throw new Error('the replacement left no image');
    expect(second).not.toBe(first);
    await expectImage(card.getByTestId('profile-image-preview-image'), second);
    expect((await request.get(first)).status()).toBe(404);
    // A smaller upload is the same square, enlarged (ADR-0079).
    expect(pngSize(await (await request.get(second)).body())).toEqual({ width: 512, height: 512 });
    await page.goBack();
    await expect(page).toHaveURL(profileUrl);
    await expectImage(page.getByTestId('profile-avatar-image'), second);

    // --- deleted: asked first, then gone at once, and the initial is back on the card, the
    // profile (Back to it) and the bylines (#37-6, #37-19).
    await page.getByTestId('profile-edit').click();
    await expect(page).toHaveURL('/my/settings');
    await card.getByTestId('profile-image-delete').click();
    const dialog = page.getByTestId('profile-image-delete-dialog');
    await expect(dialog).toContainText(copy.profileImageDeleteBody);
    // Cancelled, nothing changes, and focus is back on 삭제.
    await dialog.getByTestId('profile-image-delete-cancel').click();
    await expect(dialog).toHaveCount(0);
    await expect(card.getByTestId('profile-image-delete')).toBeFocused();
    expect((await meOf(page.request)).profile.imageUrl).toBe(second);
    await card.getByTestId('profile-image-delete').click();
    await page.getByTestId('profile-image-delete-confirm').click();
    await expect(page.getByText(copy.profileImageDeleted)).toBeVisible();
    // 삭제 is gone with the image: focus lands on the card's 올리기, not the page's start.
    await expect(card.getByTestId('profile-image-upload')).toBeFocused();
    await expect(card.getByTestId('profile-image-preview-image')).toHaveCount(0);
    await expect(preview).toHaveText(initial);
    await expect(card.getByTestId('profile-image-delete')).toHaveCount(0);
    await expect(card.getByTestId('profile-image-upload')).toHaveText(copy.profileImageUpload);
    expect((await meOf(page.request)).profile.imageUrl).toBeNull();
    expect((await request.get(second)).status()).toBe(404);
    await page.goBack();
    await expect(page).toHaveURL(profileUrl);
    await expect(page.getByTestId('profile-avatar')).toHaveText(initial);
    await expect(page.getByTestId('profile-avatar-image')).toHaveCount(0);
    await page.goto(`/community/posts/${postId}`);
    await expect(page.getByTestId(`comment-${commentId}`).getByTestId('post-byline')).toContainText(
      me.profile.nickname,
    );
    await expect(page.getByTestId('post-author-image')).toHaveCount(0);
    expect(hydration).toEqual([]);
  });
});
