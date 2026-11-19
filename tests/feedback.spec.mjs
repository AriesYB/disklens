import { expect, test } from '@playwright/test';

const endpoint = 'https://ikanp.top/api/feedback/disklens';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__TAURI__ = {
      app: { getVersion: async () => '1.2.2' },
      event: { listen: async () => () => {} },
      core: {
        invoke: async (command) => command === 'diag_report'
          ? { version: '1.2.2', os: 'windows x86_64', curTail: 'C:\\Private\\scan.log' }
          : null,
      },
    };
  });
});

async function openFeedback(page, text) {
  await page.goto('/');
  await page.locator('#brand').click();
  await page.getByRole('button', { name: /问题反馈/ }).click();
  await page.getByLabel('反馈内容', { exact: true }).fill(text);
}

test('只在主动勾选后提交编辑过的诊断日志', async ({ page }) => {
  const submissions = [];
  await page.route(endpoint, async (route) => {
    submissions.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { ok: true, id: 'test-id' } });
  });
  await openFeedback(page, '扫描完成后列表为空');
  const submit = page.getByRole('button', { name: '提交反馈' });
  const includeLog = page.getByLabel('附上诊断日志');
  await expect(includeLog).not.toBeChecked();
  await submit.click();
  await expect(page.locator('#feedback-status')).toHaveText('反馈已提交。编号 test-id');
  expect(submissions[0]).toEqual({ text: '扫描完成后列表为空', type: 'bug', contact: '', version: '1.2.2' });

  await page.getByLabel('反馈内容', { exact: true }).fill('重试后仍为空');
  await includeLog.check();
  const preview = page.getByLabel(/诊断预览/);
  await expect(preview).toHaveValue(/Private/);
  await preview.fill('已移除本机路径');
  await submit.click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1].diagnostics).toBe('已移除本机路径');
});

test('提交失败时保留草稿并复制可补交的内容', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (text) => { window.copiedFeedback = text; } },
    });
  });
  await page.route(endpoint, (route) => route.abort());
  await openFeedback(page, '建议增加列表筛选');
  await page.getByLabel('类型').selectOption('suggest');
  await page.getByRole('button', { name: '提交反馈' }).click();
  await expect(page.locator('#feedback-status')).toHaveText('未收到提交确认。已复制反馈内容。');
  await expect(page.getByLabel('反馈内容', { exact: true })).toHaveValue('建议增加列表筛选');
  expect(await page.evaluate(() => window.copiedFeedback)).toBe('DiskLens v1.2.2 · 建议\n\n建议增加列表筛选');
});
