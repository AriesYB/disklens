// DiskLens 浏览器模式端到端冒烟：模拟扫描全程（~21s）后逐项验收。
// 覆盖：三视图 + 类型/对比、搜索与联动、提案面板（回收站/撤销）、denied 面板、零渲染错误。
import { test, expect } from '@playwright/test';

// 模拟扫描全程约 19.4s，统一等 21s 再断言
async function waitScanDone(page) {
  await page.waitForTimeout(21000);
}

test.describe('DiskLens 浏览器冒烟', () => {
  let page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto('/');
    await waitScanDone(page);
  });

  test('扫描完成且零渲染错误', async () => {
    const errs = await page.evaluate('window.__errs ? window.__errs.length : 0');
    expect(errs).toBe(0);
    const summary = await page.evaluate("document.getElementById('summary').textContent");
    expect(summary).toContain('根目录总计');
  });

  test('方块视图：根标题双口径', async () => {
    const crumb = await page.evaluate("document.getElementById('bar').textContent");
    expect(crumb).toContain('占用');
  });

  test('列表视图：占用列与状态标记', async () => {
    await page.evaluate("document.querySelector('[data-view=\"list\"]').click()");
    const head = await page.evaluate("document.querySelector('.l-head').textContent");
    expect(head).toContain('占用');
    const rows = await page.evaluate("document.querySelectorAll('.l-row').length");
    expect(rows).toBeGreaterThan(0);
  });

  test('大文件榜：搜索命中文件与目录', async () => {
    await page.evaluate("document.querySelector('[data-view=\"files\"]').click()");
    await page.evaluate(`(() => {
      const inp = document.getElementById('file-search');
      inp.value = 'downloads';
      inp.dispatchEvent(new Event('input'));
    })()`);
    await page.waitForTimeout(500);   // 防抖
    const count = await page.evaluate("document.getElementById('file-search-count').textContent");
    expect(count).toContain('匹配');
    const hasDir = await page.evaluate(
      "[...document.querySelectorAll('#files-body .f-row')].some(r => r.dataset.kind === 'dir')"
    );
    expect(hasDir).toBe(true);
  });

  test('类型统计：聚合 + 单击联动到搜索', async () => {
    await page.evaluate("document.querySelector('[data-view=\"types\"]').click()");
    const meta = await page.evaluate("document.getElementById('types-meta').textContent");
    expect(meta).toContain('种类型');
    await page.evaluate(`(() => {
      const row = [...document.querySelectorAll('.t-row')].find(r => r.dataset.ext === 'iso');
      row.click();
    })()`);
    const view = await page.evaluate("document.body.dataset.view");
    expect(view).toBe('files');
    const q = await page.evaluate("document.getElementById('file-search').value");
    expect(q).toBe('*.iso');
  });

  test('历史对比：空态引导', async () => {
    await page.evaluate("document.querySelector('[data-view=\"diff\"]').click()");
    const meta = await page.evaluate("document.getElementById('diff-meta').textContent");
    expect(meta).toContain('暂无历史数据');
  });

  test('AI 提案面板：回收站/撤销全流程（mock）', async () => {
    await page.evaluate(`window.__testProposal({
      id: 'e2e', summary: 'e2e 提案',
      items: [
        { action: 'cleanup', src: 'C:\\\\Users\\\\Demo\\\\AppData\\\\Local\\\\Temp', reason: 'r' },
        { action: 'migrate', src: 'C:\\\\Users\\\\Demo\\\\AppData\\\\Local\\\\Docker', dest_root: 'D:\\\\', reason: 'r' }
      ]
    })`);
    expect(await page.evaluate("document.getElementById('prop-mask').style.display")).toBe('flex');
    // 回收站
    await page.evaluate("document.querySelector('button.pr-recycle').click()");
    await page.waitForTimeout(700);
    expect(await page.evaluate("document.getElementById('pr-st-0').textContent")).toContain('已移入回收站');
    // 执行迁移 → done → 撤销按钮出现（轮询等待 mock 12 tick 跑完）→ 点击 → 完成
    await page.evaluate("document.getElementById('prop-run').click()");
    await page.waitForSelector('button.pr-undo', { timeout: 15000 });
    await page.evaluate("document.querySelector('button.pr-undo').click()");
    await page.waitForTimeout(1500);
    expect(await page.evaluate("document.getElementById('pr-st-1').textContent")).toContain('撤销完成');
  });

  test('无权限面板：列出受限目录', async () => {
    await page.evaluate("document.getElementById('denied-link').click()");
    expect(await page.evaluate("document.getElementById('denied-mask').style.display")).toBe('flex');
    const n = await page.evaluate("document.getElementById('denied-n').textContent");
    expect(n).toContain('1');
    await page.evaluate("document.getElementById('denied-close').click()");
  });

  test('右键菜单：重扫菜单项存在', async () => {
    await page.evaluate(`openContextMenu({clientX:100,clientY:100,preventDefault(){}}, 'C:\\\\Users\\\\Demo\\\\Downloads', false)`);
    expect(await page.evaluate("document.getElementById('mi-rescan').style.display")).not.toBe('none');
    await page.evaluate("hideCtx()");
  });

  test('收尾：全程零渲染错误', async () => {
    const errs = await page.evaluate('window.__errs ? window.__errs : []');
    expect(errs).toEqual([]);
  });
});
