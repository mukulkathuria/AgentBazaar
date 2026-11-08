import { expect, test } from '@playwright/test';
import { PRODUCTS } from './helpers';

test('chat negotiation ends with a checkout link', { tag: '@smoke' }, async ({ page }) => {
  await page.goto(`/p/${PRODUCTS.keyboard}`);
  await page.getByRole('button', { name: 'Chat with our shopping assistant' }).click();
  const dialog = page.getByRole('dialog', { name: 'Shopping assistant' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Your message' })).toBeFocused();

  const send = async (text: string) => {
    await dialog.getByRole('textbox', { name: 'Your message' }).fill(text);
    await dialog.getByRole('button', { name: 'Send' }).click();
  };

  // The chat has no page context: the buyer names the product, then haggles.
  await send('How much is the Thock TK-87 Hot-swap Mechanical Keyboard?');
  // The pricing engine answers with a signed quote: offer card with a live countdown.
  const timers = dialog.getByRole('timer');
  await expect(timers.first()).toContainText(/Offer expires in \d+:\d{2}/, { timeout: 30_000 });
  await expect(dialog.getByRole('region', { name: /^Offer: 1 × Thock TK-87/ })).toContainText('₹5,499 each');

  await send('Can you do ₹4,000?');
  await expect(timers).toHaveCount(2, { timeout: 30_000 }); // a counter-offer, never below the floor
  await dialog.getByRole('button', { name: 'Accept offer' }).last().click();
  const checkout = dialog.getByRole('link', { name: 'Checkout' });
  await expect(checkout).toBeVisible({ timeout: 30_000 });
  await expect(checkout).toHaveAttribute('href', /^\/checkout\/[0-9a-f-]{36}\?t=/);

  await checkout.click();
  await expect(page).toHaveURL(/\/checkout\/[0-9a-f-]{36}\?t=/);
  await expect(page.getByText('Includes your negotiated price')).toBeVisible();
});
