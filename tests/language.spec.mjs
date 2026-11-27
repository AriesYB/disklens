import { expect, test } from '@playwright/test';

test.use({ locale: 'en-US' });

test('language switch keeps the current scan and remembers the selection', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#summary')).toContainText('Root total', { timeout: 30000 });
  const summary = await page.locator('#summary').textContent();
  const size = summary.match(/Root total (\S+)/)?.[1];
  expect(size).toBeTruthy();

  await page.getByRole('combobox', { name: 'Interface language' }).selectOption('zh-CN');
  await expect(page.locator('#summary')).toContainText('根目录总计 ' + size);
  await expect(page.getByRole('button', { name: '开始扫描' })).toBeEnabled();
  await page.getByRole('combobox', { name: '界面语言' }).selectOption('en');
  await expect(page.locator('#summary')).toContainText('Root total ' + size);
  await page.getByRole('button', { name: 'Largest files' }).click();
  await expect(page.locator('.f-head')).toContainText('Location');

  await page.evaluate(() => window.openMigrate('C:' + String.fromCharCode(92) + 'Users'));
  await expect(page.locator('#mig-title')).toContainText('Move folder');
  await expect(page.locator('#mig-check')).toContainText('Close any apps using this folder');
  await expect(page.getByRole('button', { name: 'Start move' })).toBeEnabled();
  await page.locator('#mig-cancel').click();

  await page.getByRole('combobox', { name: 'Interface language' }).selectOption('zh-CN');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
});
