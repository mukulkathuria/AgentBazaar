import { expect, test, type Page } from '@playwright/test';
import { PRODUCTS } from './helpers';

const CHAT_MESSAGES = '**/api/proxy/api/v1/chat/sessions/*/messages';

async function openChat(page: Page) {
  await page.goto(`/p/${PRODUCTS.mug}`);
  await page.getByRole('button', { name: 'Chat with our shopping assistant' }).click();
  const dialog = page.getByRole('dialog', { name: 'Shopping assistant' });
  await expect(dialog.getByRole('log')).toContainText('shopping assistant', { timeout: 20_000 }); // greeting = session up
  const send = async (text: string) => {
    await dialog.getByRole('textbox', { name: 'Your message' }).fill(text);
    await dialog.getByRole('button', { name: 'Send' }).click();
  };
  return { dialog, send };
}

test('slow network: the assistant shows that it is typing and blocks a second send', { tag: '@smoke' }, async ({ page }) => {
  const { dialog, send } = await openChat(page);
  await page.route(CHAT_MESSAGES, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.continue();
  });
  await send('Do you have ceramic mugs?');
  const log = dialog.getByRole('log');
  const human = dialog.getByRole('button', { name: 'Talk to a human' });
  await expect(dialog.getByText('The assistant is typing…')).toBeVisible();
  await expect(log).toHaveAttribute('aria-busy', 'true');
  await expect(human).toBeDisabled();
  await expect(dialog.getByText('The assistant is typing…')).toBeHidden({ timeout: 30_000 });
  await expect(log).toHaveAttribute('aria-busy', 'false');
  await expect(human).toBeEnabled();
});

test('offline: a failed send says so, and the next one works once back online', { tag: '@smoke' }, async ({ page, context }) => {
  const { dialog, send } = await openChat(page);
  await context.setOffline(true);
  await send('Do you have ceramic mugs?');
  await expect(dialog.getByText('Sorry, the assistant is unavailable right now. Please try again.')).toBeVisible();

  await context.setOffline(false);
  const answered = page.waitForResponse((r) => r.url().endsWith('/messages') && r.status() === 200);
  await send('Do you have ceramic mugs?');
  await answered;
  await expect(dialog.getByText('The assistant is typing…')).toBeHidden({ timeout: 30_000 });
  await expect(dialog.getByText('Sorry, the assistant is unavailable right now. Please try again.')).toHaveCount(1);
});
