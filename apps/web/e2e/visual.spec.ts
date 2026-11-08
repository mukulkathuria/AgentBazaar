import { expect, test } from '@playwright/test';
import { PRODUCTS } from './helpers';

// Baselines are Linux Chromium screenshots made on the CI runner (refresh: run web-e2e with update-snapshots,
// download the artifact, commit). The seeded catalog, its product ids included, is the same on every boot, so
// these pages render the same every run; the screenshots run before any journey changes the data.
test.describe('visual regression', { tag: '@visual' }, () => {
  test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, 'Baselines are kept for desktop Chromium only');

  test('home', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveScreenshot('home.png', { fullPage: true });
  });

  test('product page with personalisation', async ({ page }) => {
    await page.goto(`/p/${PRODUCTS.mug}`);
    await expect(page).toHaveScreenshot('product-mug.png', { fullPage: true });
  });

  test('search results', async ({ page }) => {
    await page.goto('/search?q=keyboard');
    await expect(page).toHaveScreenshot('search-keyboard.png', { fullPage: true });
  });

  test('empty cart', async ({ page }) => {
    await page.goto('/cart');
    await expect(page).toHaveScreenshot('cart-empty.png', { fullPage: true });
  });
});
