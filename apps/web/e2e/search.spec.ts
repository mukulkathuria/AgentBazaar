import { expect, test } from '@playwright/test';
import { PRODUCTS } from './helpers';

test('search tolerates a typo and filters still work', { tag: '@smoke' }, async ({ page }) => {
  await page.goto('/');
  await page.getByRole('searchbox', { name: 'Search products' }).fill('mechanicl keybord');
  await page.getByRole('button', { name: 'Search', exact: true }).click();

  await expect(page).toHaveURL(/\/search\?q=mechanicl\+keybord/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Results for “mechanicl keybord”');
  await expect(page.locator(`a[href="/p/${PRODUCTS.keyboard}"]`).first()).toBeVisible();

  await page.getByLabel('In stock only').check();
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page).toHaveURL(/inStock=1/);
  await expect(page.getByRole('heading', { name: /results$/ })).toBeVisible();
});
