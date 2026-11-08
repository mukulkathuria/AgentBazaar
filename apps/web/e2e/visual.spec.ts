import { expect, test } from '@playwright/test';
import { PRODUCTS } from './helpers';

// Baselines are Linux Chromium screenshots made on the CI runner (refresh: run web-e2e with update-snapshots,
// download the artifact, commit). The catalog is seeded the same way every run, but products that tie in search
// ranking or "bought together" order by random ids, so those product grids are masked; the layout around them,
// and every other pixel, is compared.
test.describe('visual regression', { tag: '@visual' }, () => {
  test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, 'Baselines are kept for desktop Chromium only');

  test('home', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveScreenshot('home.png', { fullPage: true });
  });

  test('product page with personalisation', async ({ page }) => {
    await page.goto(`/p/${PRODUCTS.mug}`);
    const together = page.getByRole('region', { name: 'Frequently bought together' }).getByRole('list');
    await expect(page).toHaveScreenshot('product-mug.png', { fullPage: true, mask: [together] });
  });

  test('search results', async ({ page }) => {
    await page.goto('/search?q=keyboard');
    await expect(page).toHaveScreenshot('search-keyboard.png', { fullPage: true, mask: [page.locator('main li article')] });
  });

  test('empty cart', async ({ page }) => {
    await page.goto('/cart');
    await expect(page).toHaveScreenshot('cart-empty.png', { fullPage: true });
  });
});
