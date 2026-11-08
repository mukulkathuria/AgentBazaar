import { expect, test, type Page } from '@playwright/test';
import { addToCart, adminSignIn, fillCheckout, hasAdmin, PRODUCTS, startCheckout } from './helpers';

/** Runs one fulfilment action from the admin orders console and waits for its result. */
async function adminAction(admin: Page, orderId: string, action: string, status: RegExp, tracking?: string) {
  await admin.getByLabel('Order ID').fill(orderId);
  await admin.getByLabel('Action').selectOption({ label: action });
  if (tracking) await admin.getByLabel('Tracking number').fill(tracking);
  await admin.getByRole('button', { name: 'Apply' }).click();
  await expect(admin.getByRole('status')).toContainText(status);
}

test('cash on delivery → shipped → delivered → return requested → return completed', { tag: '@smoke' }, async ({ page, browser }) => {
  test.skip(!hasAdmin, 'Needs the seeded admin (scripts/e2e-stack.sh)');

  await addToCart(page, PRODUCTS.keyboard);
  await startCheckout(page);
  await fillCheckout(page, 'Cash on delivery');
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}\?t=/, { timeout: 20_000 });
  const orderId = new URL(page.url()).pathname.split('/').pop() ?? '';
  await expect(page.getByText('Confirmed (cash on delivery)').first()).toBeVisible();

  // The store fulfils it from the admin console, in a separate session.
  const adminContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const admin = await adminContext.newPage();
  await adminSignIn(admin, '/admin/orders');
  await adminAction(admin, orderId, 'Mark shipped', /is now: Shipped/, 'E2E123456IN');
  await adminAction(admin, orderId, 'Mark delivered', /is now: Delivered/);

  await page.reload();
  await expect(page.getByText('Delivered').first()).toBeVisible();
  const form = page.getByRole('form', { name: 'Request a return' });
  await form.getByLabel('Reason').selectOption('damaged');
  await form.getByLabel('Anything else we should know? (optional)').fill('The box was crushed.');
  await form.getByRole('button', { name: 'Request return' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Return requested' })).toBeVisible();
  await expect(page.getByText('Return requested').first()).toBeVisible();

  await adminAction(admin, orderId, 'Complete return (restock and refund)', /is now: (Returned|Refunded)/);
  await adminContext.close();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Order timeline' })).toBeVisible();
  await expect(page.getByText(/Returned|Refunded/).first()).toBeVisible();
});
