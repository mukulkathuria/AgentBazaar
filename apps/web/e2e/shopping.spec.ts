import { expect, test } from '@playwright/test';
import { fillCheckout, PRODUCTS, startCheckout } from './helpers';

test('browse → personalised product → cart → checkout → mock pay → order page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.locator(`a[href="/p/${PRODUCTS.mug}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/p/${PRODUCTS.mug}`));

  // Personalise: the non-returnable notice must be visible before add-to-cart.
  const panel = page.getByRole('region', { name: 'Personalise it' });
  await expect(panel.getByRole('note')).toContainText('can’t be returned');
  await panel.getByRole('textbox').first().fill('Asha');
  await expect(panel.getByRole('status')).toHaveText(/Looks good|review this text/);
  await page.getByRole('button', { name: 'Add to cart' }).click();

  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByText('Non-returnable').first()).toBeVisible();
  await startCheckout(page);

  await fillCheckout(page, 'Pay online (UPI, card, net banking)');
  await page.getByRole('button', { name: 'Place order' }).click();

  await expect(page).toHaveURL(/\/pay\/mock\/[0-9a-f-]{36}\?t=/);
  await expect(page.getByText('Test payment — no real money moves')).toBeVisible();
  await page.getByRole('button', { name: /^Pay .+ \(mock\)$/ }).click();

  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Order');
  await expect(page.getByRole('heading', { name: 'Order timeline' })).toBeVisible();
  await expect(page.getByText(/Paid|Payment received/).first()).toBeVisible();
});
