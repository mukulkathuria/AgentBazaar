import { expect, test } from '@playwright/test';

// Regression (found by the OWASP ZAP baseline, alert 10024): a form submitted before hydration, or without
// JavaScript, fell back to GET and put the email and password in the URL (history, server logs, Referer).
test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('signing in or registering never puts credentials in the URL', { tag: '@smoke' }, async ({ page }) => {
    for (const name of ['Sign in', 'Create an account']) {
      await page.goto('/account');
      const form = page.getByRole('form', { name });
      await form.getByLabel('Email', { exact: true }).fill('no-js@example.com');
      await form.getByLabel('Password').fill('correct-horse-42');
      await form.getByRole('button', { name }).click();
      await page.waitForLoadState();
      expect(page.url()).not.toMatch(/password|horse|no-js/);
    }
  });
});
