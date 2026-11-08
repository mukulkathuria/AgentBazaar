import { expect, test } from '@playwright/test';
import { adminSignIn, hasAdmin } from './helpers';

test('admin signs in with a TOTP code and opens the approvals queue', { tag: '@smoke' }, async ({ page }) => {
  test.skip(!hasAdmin, 'Set E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD and E2E_ADMIN_TOTP_SECRET (scripts/e2e-stack.sh does)');

  await adminSignIn(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText('Agent cost per conversation')).toBeVisible();

  await page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: 'Approvals' }).click();
  await expect(page).toHaveURL(/\/admin\/approvals$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Approvals' })).toHaveAttribute('aria-current', 'page');
});
