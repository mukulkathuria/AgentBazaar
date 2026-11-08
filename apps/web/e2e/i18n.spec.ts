import { expect, test } from '@playwright/test';
import { PRODUCTS } from './helpers';

test('switches the store to Hindi, keeps it across pages, and back to English', { tag: '@smoke' }, async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('button', { name: 'हिन्दी' }).click();

  await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('एजेंट युग का पूरा स्टोर');
  await expect(page.getByRole('searchbox', { name: 'उत्पाद खोजें' })).toBeVisible();

  // The choice is a cookie: the next page and the assistant are in Hindi too.
  await page.goto(`/p/${PRODUCTS.keyboard}`);
  await expect(page.getByRole('button', { name: 'कार्ट में डालें' })).toBeVisible();
  await page.getByRole('button', { name: 'हमारे शॉपिंग असिस्टेंट से चैट करें' }).click();
  const dialog = page.getByRole('dialog', { name: 'शॉपिंग असिस्टेंट' });
  await expect(dialog.getByRole('log')).toContainText(/[ऀ-ॿ]{3,}/, { timeout: 20_000 });
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('button', { name: 'Add to cart' })).toBeVisible();
});
