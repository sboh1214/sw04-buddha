import { type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import type { AdminCategory, Category } from '@buddha/shared';
import { copy } from '../src/copy';
import { accountIdOf, adminAccount, expect, freshTag, signIn, test } from './helpers';

/**
 * 카테고리 관리 (#17, ADR-0093 decision 2 #172 item 1 and decision 3's #17 rows): an admin adds a
 * top-level category of this run's — a malformed slug is the form's to refuse, a taken one the
 * API's, on the field — then two sub-categories under it (a name a sibling has is refused on the
 * field), renames one, moves the other up, and hides it: the admin list marks it 숨김, and the
 * public list (`GET /categories`, read signed out) and the home — the header's row and the
 * sidebar of the new category — show the new top-level one with the shown sub-category, renamed,
 * and not the hidden one. Hiding the top-level category at the end takes it and its sub-category
 * out of the public list; the sub-category's own flag stays on (상위 숨김). Nothing is deleted.
 *
 * Other specs run at the same time on the same database and read the seed's categories — by
 * position among the top-level ones (helpers.ts `topLevelCategory`), the first with a
 * sub-category, a leaf by slug — so this spec never hides, renames or reorders a seed category or
 * the top-level group: it changes only what it made, and its top-level category goes last
 * (a new category goes last among its siblings), behind every position the others read. Its
 * names and slugs carry a fresh tag, so the checks are presence and absence of its own rows, never
 * the whole list. The top-level category is hidden at the end — through the API if the test
 * stopped before it did — so it leaves the header of every later run.
 */

/** `{ data }` out of the success envelope, the body in the message on a failure. */
async function dataOf<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${response.url()} -> ${String(response.status())} ${body}`).toBe(true);
  return (JSON.parse(body) as { data: T }).data;
}

/** The public list as a signed-out visitor reads it. */
function publicCategories(request: APIRequestContext): Promise<Category[]> {
  return request.get('/api/v1/categories').then((response) => dataOf<Category[]>(response));
}

/** The admin list (`GET /admin/categories`): every category, hidden ones too, in display order. */
async function adminCategories(admin: APIRequestContext): Promise<AdminCategory[]> {
  return dataOf<AdminCategory[]>(await admin.get('/api/v1/admin/categories'));
}

/**
 * Hides this run's top-level category if the test stopped before it did, so a failed run does not
 * leave it in every later run's header. Never throws: it must not hide the failure it follows.
 */
async function hideIfShown(admin: APIRequestContext, slug: string): Promise<void> {
  try {
    const mine = (await adminCategories(admin)).find((row) => row.slug === slug);
    if (mine === undefined || !mine.isActive) return;
    await admin.post(`/api/v1/admin/categories/${String(mine.id)}/hide`, {
      data: { expectedAccountId: await accountIdOf(admin) },
    });
  } catch {
    // The test's own failure is the one to report.
  }
}

/**
 * Lets the page's toasts go before the next press (themes.spec.ts's `letToastsGo`): a toast pauses
 * while the pointer rests on the stack, which grows over the buttons at the bottom of a phone's
 * screen, so the pointer left there by the last press would hold them and the press would wait.
 */
async function letToastsGo(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await expect(page.locator('[data-scope="toast"][data-part="root"]')).toHaveCount(0);
}

test.describe('카테고리 관리 (#17)', () => {
  test('관리자가 상위 카테고리와 하위 둘을 더해 이름을 바꾸고 순서를 옮기고 하나를 숨기면, 공개 목록과 홈이 따른다', async ({
    admin,
    page,
    request,
  }) => {
    const tag = freshTag();
    const top = { slug: `e2e-${tag}`, name: `E2E ${tag}` };
    const subA = { slug: `e2e-${tag}-a`, name: `하위A ${tag}` };
    const subB = { slug: `e2e-${tag}-b`, name: `하위B ${tag}` };
    const renamedA = `${subA.name} 고침`;

    try {
      const topIdsBefore = (await adminCategories(admin))
        .filter((row) => row.parentId === null)
        .map((row) => row.id);
      await signIn(page, adminAccount.email, adminAccount.password);

      // --- From the menu: '카테고리', after '테마'. The screen says what hiding does.
      await page.goto('/admin/markets');
      const nav = page.getByTestId('admin-nav');
      await expect(nav.getByRole('link')).toContainText([copy.adminThemes, copy.adminCategories]);
      await nav.getByRole('link', { name: copy.adminCategories, exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/categories$/);
      await expect(page.getByTestId('admin-categories-hint')).toContainText(
        copy.adminCategoriesHint,
      );
      await expect(page.getByTestId('admin-categories-list')).toBeVisible();

      // --- 상위 카테고리 추가. A slug outside lower-case letters, digits and hyphens is the
      // form's to refuse; nothing is sent.
      const slugInput = page.getByTestId('category-create-top-slug');
      const nameInput = page.getByTestId('category-create-top-name');
      const createTop = page.getByTestId('category-create-top-submit');
      await slugInput.fill(`E2E_${tag}`);
      await nameInput.fill(top.name);
      await createTop.click();
      await expect(page.getByTestId('category-create-top-form')).toContainText(
        copy.adminCategoryErrSlug,
      );
      await expect(page.getByTestId(`admin-category-row-${top.slug}`)).toHaveCount(0);
      await slugInput.fill(top.slug);
      await createTop.click();
      const topRow = page.getByTestId(`admin-category-row-${top.slug}`);
      await expect(page.getByTestId(`admin-category-name-${top.slug}`)).toHaveText(top.name);
      await expect(topRow).toContainText(
        `${top.slug} · ${copy.adminCategoryMarkets} 0${copy.adminCategoryMarketsUnit}`,
      );
      // It went last among the top-level categories, behind every one there was before — hidden
      // ones too. (Not last outright: the other viewport's run may have added its own since.)
      const tops = (await adminCategories(admin)).filter((row) => row.parentId === null);
      const at = tops.findIndex((row) => row.slug === top.slug);
      expect(at).toBeGreaterThan(-1);
      expect(tops.slice(at + 1).filter((row) => topIdsBefore.includes(row.id))).toEqual([]);
      // The form emptied for the next one. The same slug again is the API's to refuse, on the
      // field: a slug is unique across the tree.
      await expect(slugInput).toHaveValue('');
      await letToastsGo(page);
      await slugInput.fill(top.slug);
      await nameInput.fill(`${top.name} 둘`);
      await createTop.click();
      await expect(page.getByTestId('category-create-top-form')).toContainText(
        copy.adminCategoryErrSlugTaken,
      );

      // --- 하위 카테고리 추가, twice; the form stays open for the next. A name its sibling has
      // is refused on the field.
      await page.getByTestId(`admin-category-add-child-${top.slug}`).click();
      // The first sub-category of a top-level one: its markets stay, and new ones go below it.
      await expect(page.getByTestId(`admin-category-child-panel-${top.slug}`)).toContainText(
        copy.adminCategoryChildHint,
      );
      const childForm = page.getByTestId(`category-create-form-${top.slug}`);
      const childSlug = page.getByTestId(`category-create-slug-${top.slug}`);
      const childName = page.getByTestId(`category-create-name-${top.slug}`);
      const createChild = page.getByTestId(`category-create-submit-${top.slug}`);
      await childSlug.fill(subA.slug);
      await childName.fill(subA.name);
      await createChild.click();
      await expect(page.getByTestId(`admin-category-name-${subA.slug}`)).toHaveText(subA.name);
      await expect(childSlug).toHaveValue('');
      await letToastsGo(page);
      await childSlug.fill(subB.slug);
      await childName.fill(subB.name);
      await createChild.click();
      await expect(page.getByTestId(`admin-category-name-${subB.slug}`)).toHaveText(subB.name);
      await letToastsGo(page);
      await childSlug.fill(`e2e-${tag}-c`);
      await childName.fill(subA.name);
      await createChild.click();
      await expect(childForm).toContainText(copy.adminCategoryErrNameTaken);
      await page.getByTestId(`category-create-close-${top.slug}`).click();
      await expect(childForm).toHaveCount(0);

      // Each new one went last among its siblings.
      const childNames = page
        .getByTestId(`admin-category-children-${top.slug}`)
        .getByTestId(/^admin-category-name-/);
      await expect(childNames).toHaveText([subA.name, subB.name]);

      // --- 이름 바꾸기, in place: the name only, the slug stays.
      await page.getByTestId(`admin-category-rename-open-${subA.slug}`).click();
      await page.getByTestId(`admin-category-rename-name-${subA.slug}`).fill(renamedA);
      await page.getByTestId(`admin-category-rename-save-${subA.slug}`).click();
      await expect(page.getByTestId(`admin-category-rename-form-${subA.slug}`)).toHaveCount(0);
      await expect(childNames).toHaveText([renamedA, subB.name]);
      await expect(page.getByTestId(`admin-category-row-${subA.slug}`)).toContainText(subA.slug);

      // --- 위로: within its parent, the whole group sent in its new order.
      await letToastsGo(page);
      await page.getByTestId(`admin-category-up-${subB.slug}`).click();
      await expect(childNames).toHaveText([subB.name, renamedA]);
      await expect(page.getByTestId(`admin-category-up-${subB.slug}`)).toBeDisabled();

      // The public list follows: the new top-level category, its two sub-categories in the new
      // order, the rename.
      let listed = await publicCategories(request);
      const topId = listed.find((row) => row.slug === top.slug)?.id;
      expect(topId, 'the new top-level category is public').toBeDefined();
      expect(
        listed.filter((row) => row.parentId === topId).map((row) => [row.slug, row.nameKo]),
      ).toEqual([
        [subB.slug, subB.name],
        [subA.slug, renamedA],
      ]);

      // --- 숨기기, after a confirmation: the row is marked 숨김 and can be shown again.
      await letToastsGo(page);
      await page.getByTestId(`admin-category-hide-${subB.slug}`).click();
      await page.getByTestId('category-hide-dialog-confirm').click();
      await expect(page.getByTestId(`admin-category-hidden-${subB.slug}`)).toHaveText(
        copy.adminCategoryHiddenTag,
      );
      await expect(page.getByTestId(`admin-category-show-${subB.slug}`)).toBeVisible();
      // Hidden, not gone: still in the admin list, in its place.
      await expect(childNames).toHaveText([subB.name, renamedA]);

      // The public list and the home leave it out; the shown one stays, renamed.
      listed = await publicCategories(request);
      expect(listed.filter((row) => row.parentId === topId).map((row) => row.slug)).toEqual([
        subA.slug,
      ]);
      await page.goto(`/?category=${top.slug}`);
      await expect(page.getByTestId(`nav-category-${top.slug}`)).toHaveText(top.name);
      // The sidebar (md and up) and its chip row (below md) are both in the DOM at every width.
      await expect(page.getByTestId(`market-subcategory-${subA.slug}`)).toContainText(renamedA);
      await expect(page.getByTestId(`market-subcategory-${subA.slug}-mobile`)).toHaveCount(1);
      await expect(page.getByTestId(`market-subcategory-${subB.slug}`)).toHaveCount(0);
      await expect(page.getByTestId(`market-subcategory-${subB.slug}-mobile`)).toHaveCount(0);

      // --- Hiding the top-level category takes its sub-categories out with it, their own flag
      // untouched (상위 숨김); a hidden parent takes no new sub-category.
      await page.goto('/admin/categories');
      await page.getByTestId(`admin-category-hide-${top.slug}`).click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText(copy.adminCategoryHideTopBody);
      await page.getByTestId('category-hide-dialog-confirm').click();
      await expect(page.getByTestId(`admin-category-hidden-${top.slug}`)).toHaveText(
        copy.adminCategoryHiddenTag,
      );
      await expect(page.getByTestId(`admin-category-parent-hidden-${subA.slug}`)).toHaveText(
        copy.adminCategoryHiddenByParentTag,
      );
      await expect(page.getByTestId(`admin-category-add-child-${top.slug}`)).toHaveCount(0);
      listed = await publicCategories(request);
      expect(listed.filter((row) => [top.slug, subA.slug, subB.slug].includes(row.slug))).toEqual(
        [],
      );
      await page.goto('/');
      // The row has read the categories (a seed one is listed after 전체) before the absence is
      // checked.
      await expect(page.getByTestId('nav-categories').getByRole('link').nth(1)).toBeVisible();
      await expect(page.getByTestId(`nav-category-${top.slug}`)).toHaveCount(0);
    } finally {
      await hideIfShown(admin, top.slug);
    }
  });
});
