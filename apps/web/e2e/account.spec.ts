import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { uniqueEmail } from './helpers';

test('register → export my data → erase my account', async ({ page }) => {
  const email = uniqueEmail('dpdp');
  await page.goto('/account');

  const register = page.getByRole('form', { name: 'Create an account' });
  await register.getByLabel('Full name').fill('Ravi Kumar');
  await register.getByLabel('Email').fill(email);
  await register.getByLabel('Password').fill('correct-horse-42');
  await register.getByLabel('I accept the terms of sale and the privacy notice').check();
  await register.getByRole('button', { name: 'Create an account' }).click();

  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download my data (JSON)' }).click()]);
  expect(download.suggestedFilename()).toBe('agentbazaar-data-export.json');
  const exported = JSON.parse(await readFile(await download.path(), 'utf8')) as Record<string, unknown>;
  expect(typeof exported).toBe('object');

  const erase = page.getByRole('button', { name: 'Erase my account permanently' });
  await expect(erase).toBeDisabled();
  await page.getByLabel('Type ERASE to confirm').fill('ERASE');
  await erase.click();

  await expect(page).toHaveURL(/\/account\?erased=1/);
  await expect(page.getByText('Your account has been erased.')).toBeVisible();
  await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();
});
