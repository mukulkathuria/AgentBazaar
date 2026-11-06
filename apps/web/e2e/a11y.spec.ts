import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addToCart, PRODUCTS, startCheckout } from './helpers';

async function expectNoSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const serious = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
  expect(serious).toEqual([]);
}

test.describe('accessibility (axe, zero serious/critical violations)', () => {
  test('home', async ({ page }) => {
    await page.goto('/');
    await expectNoSeriousViolations(page);
  });

  test('product page, with the chat dialog open too', async ({ page }) => {
    await page.goto(`/p/${PRODUCTS.mug}`);
    await expectNoSeriousViolations(page);
    await page.getByRole('button', { name: 'Chat with our shopping assistant' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectNoSeriousViolations(page);
  });

  test('cart and checkout', async ({ page }) => {
    await addToCart(page, PRODUCTS.chocolate);
    await expectNoSeriousViolations(page);
    await startCheckout(page);
    await expectNoSeriousViolations(page);
    // Error state of the address form must stay accessible too.
    await page.getByRole('button', { name: 'Place order' }).click();
    await expect(page.getByText('Enter a valid Indian mobile number')).toBeVisible();
    await expectNoSeriousViolations(page);
  });
});
