import { expect, test } from '@playwright/test';
import { PRODUCTS, tabTo } from './helpers';

test.describe('keyboard only', () => {
  test('skip link, search, product and add to cart without a pointer', { tag: '@smoke' }, async ({ page, browserName }) => {
    // WebKit's Tab, like Safari's default, stops on form controls but not on links, so this walk needs Chromium or
    // Firefox; the dialog test below runs everywhere.
    test.skip(browserName === 'webkit', 'Tab skips links in WebKit by default');
    await page.goto('/');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);

    // From the top of a fresh page, as a keyboard user starts (Tab past the end leaves Firefox's page).
    await page.goto('/');
    await tabTo(page, page.getByRole('searchbox', { name: 'Search products' }));
    await page.keyboard.type('thock keyboard');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/search\?q=thock\+keyboard/);

    await tabTo(page, page.locator(`a[href="/p/${PRODUCTS.keyboard}"]`).first());
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/p/${PRODUCTS.keyboard}$`));

    await tabTo(page, page.getByRole('button', { name: 'Add to cart' }));
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/cart$/);
    await expect(page.getByRole('button', { name: 'Proceed to checkout' })).toBeVisible();
  });

  test('chat dialog traps focus, closes on Escape and returns focus to its launcher', { tag: '@smoke' }, async ({ page }) => {
    await page.goto(`/p/${PRODUCTS.mug}`);
    const launcher = page.getByRole('button', { name: 'Chat with our shopping assistant' });
    await tabTo(page, launcher, 80);
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Shopping assistant' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Your message' })).toBeFocused();

    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(launcher).toBeFocused();
  });
});
