import { expect, test } from '@playwright/test';
import { PRODUCTS } from './helpers';

test('chat negotiation ends with a checkout link', async ({ page }) => {
  await page.goto(`/p/${PRODUCTS.keyboard}`);
  await page.getByRole('button', { name: 'Chat with our shopping assistant' }).click();
  const dialog = page.getByRole('dialog', { name: 'Shopping assistant' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Your message' })).toBeFocused();

  const send = async (text: string) => {
    await dialog.getByRole('textbox', { name: 'Your message' }).fill(text);
    await dialog.getByRole('button', { name: 'Send' }).click();
  };

  await send('Can I get 2 Thock TK87 keyboards for ₹2,000 each?');
  // The pricing engine answers with a signed quote: offer card with a live countdown.
  await expect(dialog.getByRole('timer')).toContainText(/Offer expires in \d+:\d{2}/, { timeout: 30_000 });

  await dialog.getByRole('button', { name: 'Accept offer' }).last().click();
  const checkout = dialog.getByRole('link', { name: 'Checkout' });
  await expect(checkout).toBeVisible({ timeout: 30_000 });
  await expect(checkout).toHaveAttribute('href', /^\/checkout\/[0-9a-f-]{36}\?t=/);

  await checkout.click();
  await expect(page).toHaveURL(/\/checkout\/[0-9a-f-]{36}\?t=/);
  await expect(page.getByText('Includes your negotiated price')).toBeVisible();
});
