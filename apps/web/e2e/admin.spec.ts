import { expect, test } from '@playwright/test';
import { totp } from './helpers';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const ADMIN_TOTP_SECRET = process.env.E2E_ADMIN_TOTP_SECRET;

test('admin signs in with a TOTP code and opens the approvals queue', async ({ page }) => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD || !ADMIN_TOTP_SECRET, 'Set E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD and E2E_ADMIN_TOTP_SECRET');

  await page.goto('/account?next=/admin');
  const login = page.getByRole('form', { name: 'Sign in' });
  await login.getByLabel('Email').fill(ADMIN_EMAIL ?? '');
  await login.getByLabel('Password').fill(ADMIN_PASSWORD ?? '');
  await login.getByLabel('Authenticator code (admins only)').fill(totp(ADMIN_TOTP_SECRET ?? ''));
  await login.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText('Agent cost per conversation')).toBeVisible();

  await page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: 'Approvals' }).click();
  await expect(page).toHaveURL(/\/admin\/approvals$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Approvals' })).toHaveAttribute('aria-current', 'page');
});
