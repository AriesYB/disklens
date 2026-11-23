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
    const observed = await page.evaluate(() => {
      const original = feed.recycleDelete;
      let finish, progress;
      feed.recycleDelete = (_paths, cb, update) => { finish = cb; progress = update; };
      try {
        document.querySelector('button.pr-recycle').click();
        const row = document.getElementById('pr-st-0');
        const bar = row.querySelector('progress');
        const hiddenBeforeEstimate = bar.hidden;
        progress({ total: 2, done: 1 });
        progress({ total: 5, done: 1 });
        progress({ total: 0, done: 0 });
        const result = { hiddenBeforeEstimate, sameBar: row.querySelector('progress') === bar, value: bar.value };
        return result;
      } finally {
        setTimeout(() => finish([]), 300);
        feed.recycleDelete = original;
      }
    });
    expect(observed).toEqual({ hiddenBeforeEstimate: true, sameBar: true, value: 50 });
    await expect(page.locator('#pr-st-0 .pr-current')).toContainText('Temp');
    await expect(page.locator('#pr-st-0')).toContainText('已移入回收站');
    // 执行迁移 → done → 撤销按钮出现（轮询等待 mock 12 tick 跑完）→ 点击 → 完成
    await page.evaluate("document.getElementById('prop-run').click()");
    await expect(page.locator('#pr-st-1 progress[value]')).toBeVisible();
    await expect(page.locator('#pr-st-1 .pr-current')).toBeVisible();
    await page.waitForSelector('button.pr-undo', { timeout: 15000 });
    await page.evaluate("document.querySelector('button.pr-undo').click()");
    await page.waitForTimeout(1500);
    expect(await page.evaluate("document.getElementById('pr-st-1').textContent")).toContain('撤销完成');
    await page.locator('#prop-close').click();
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

  test('回归：手动重扫后大文件榜结构完好（#files 容器曾被整体清空）', async () => {
    await page.evaluate("document.querySelector('[data-view=\"files\"]').click()");
    await page.evaluate("startScan()");   // 曾经的 bug：beginScanUI 把 #files 连搜索框一起 innerHTML=''
    await waitScanDone(page);
    expect(await page.evaluate("!!document.getElementById('files-bar')")).toBe(true);
    expect(await page.evaluate("!!document.getElementById('file-search')")).toBe(true);
    const rows = await page.evaluate("document.querySelectorAll('#files-body .f-row').length");
    expect(rows).toBeGreaterThan(0);
  });

  test('切换范围：不自动扫描，切回已扫范围秒显上次结果', async () => {
    async function pick(v) {
      await page.evaluate(`(() => {
        const sel = document.getElementById('root-drives');
        sel.value = ${JSON.stringify(v)};
        sel.dispatchEvent(new Event('change'));
      })()`);
      await page.waitForTimeout(300);
    }
    // 切到未扫过的 D:\ → 不启动扫描，提示待扫
    await pick('D:\\');
    expect(await page.evaluate('window.scanning')).toBe(false);
    expect(await page.evaluate("document.getElementById('status').textContent")).toContain('尚未扫描');
    // 切回 C:\ → 秒显上次结果，仍不自动扫描，榜单数据回到 C: 口径
    await pick('C:\\');
    expect(await page.evaluate('window.scanning')).toBe(false);
    expect(await page.evaluate("document.getElementById('status').textContent")).toContain('上次扫描结果');
    const rows = await page.evaluate("document.querySelectorAll('#files-body .f-row').length");
    expect(rows).toBeGreaterThan(0);
  });

  test('盘符和相对路径组合后同步到页脚和 AI 指令', async () => {
    await page.locator('#root-drives').selectOption('D:\\');
    await page.locator('#root-input').fill('Projects/Build Cache');
    await page.locator('#root-input').press('Enter');
    await expect(page.locator('#root-input')).toHaveValue('Projects\\Build Cache');
    await expect(page.locator('#foot-stats')).toContainText('D:\\Projects\\Build Cache');
    await page.locator('#ai-bar-btn').click();
    await expect(page.locator('#ai-src')).toContainText('D:\\Projects\\Build Cache');
    const fresh = page.getByRole('button', { name: '重新扫描', exact: true });
    const reuse = page.getByRole('button', { name: '使用已有记录', exact: true });
    await expect(fresh).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#ai-copy')).toBeVisible();
    const readPrompt = () => page.evaluate(() => {
      const original = IN_TAURI;
      IN_TAURI = true;
      aiChInfo = { enabled: true, port: 12345, token: 'test-token' };
      try {
        renderAiPanel();
        return document.getElementById('ai-prompt').textContent;
      } finally {
        IN_TAURI = original;
        aiChInfo = null;
      }
    });
    const refreshPrompt = await readPrompt();
    expect(refreshPrompt).toMatch(/-X POST[^\n]*\/api\/scan/);
    expect(refreshPrompt).toContain(JSON.stringify({
      roots: ['D:\\Projects\\Build Cache'], policy: 'refresh'
    }));
    expect(refreshPrompt).toContain('scanId 与本次一致且 scanState=completed');
    expect(refreshPrompt).toContain('只要这些指标还在推进就继续等待');
    expect(refreshPrompt).not.toContain('最多 24 次');

    await reuse.click();
    await expect(reuse).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#ai-copy')).toBeVisible();
    expect(await page.evaluate('scanning')).toBe(false);
    const prompt = await readPrompt();
    expect(prompt).toContain('/api/status?path=D%3A%5CProjects%5CBuild%20Cache&policy=reuse');
    expect(prompt).toContain('/api/scan?path=D%3A%5CProjects%5CBuild%20Cache&depth=3');
    expect(prompt).toContain('若 ready=false、scanning=true 或请求失败');
    expect(prompt).not.toMatch(/-X POST[^\n]*\/api\/scan/);
    await page.locator('#ai-close').click();

    const scanUi = await page.evaluate(() => {
      const events = {};
      const original = window.__TAURI__;
      window.__TAURI__ = { event: { listen: (name, listener) => { events[name] = listener; } } };
      try {
        new TauriFeed();
        const path = 'D:\\Projects\\Build Cache';
        events['scan-started']({ payload: { roots: [path], full: true, byAi: true, scanId: 9 } });
        const gib = 1024 ** 3;
        events['scan-batch']({ payload: [
          { path, size: gib, done: false },
          { path: path + '\\large', size: 72 * gib, done: true },
        ] });
        events['scan-progress']({ payload: { scanId: 9, progress: {
          bytesScanned: 73 * gib, allocatedBytes: 73 * gib, rootsTotal: 1,
          filesVisited: 30, directoriesVisited: 2,
          roots: [{ path, bytesScanned: 73 * gib, allocatedBytes: 73 * gib, done: false }],
        } } });
        render();
        const state = {
          running: scanning,
          canStop: !document.getElementById('stop-btn').disabled,
          status: document.getElementById('status').textContent,
          crumb: document.getElementById('bar').textContent.includes('73.00 GB'),
          summary: document.getElementById('summary').textContent.includes('已扫描 73.00 GB'),
        };
        events['scan-finished']({ payload: '扫描已停止' });
        return { ...state, stopped: !scanning };
      } finally {
        window.__TAURI__ = original;
      }
    });
    expect(scanUi).toEqual({
      running: true, canStop: true, status: 'AI 发起的后台扫描中…',
      crumb: true, summary: true, stopped: true,
    });
    const needsDetails = await page.evaluate(() => {
      applyEvent({ path: curPath, name: 'Build Cache', size: 1024, done: true, file: false, summarized: true });
      render();
      return needsDetailedScan([curPath]);
    });
    expect(needsDetails).toBe(true);
    await expect(page.locator('#summary')).toContainText('部分明细已聚合');
  });

  test('收尾：全程零渲染错误', async () => {
    const errs = await page.evaluate('window.__errs ? window.__errs : []');
    expect(errs).toEqual([]);
  });
});
