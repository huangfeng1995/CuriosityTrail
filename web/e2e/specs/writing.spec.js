'use strict';

// 章节写作主流程：块编辑、字数统计、自动落库。

const { test, expect } = require('@playwright/test');
const { fixture, button } = require('../helpers');

test.describe('章节写作', () => {
  test.beforeEach(async ({ page }) => {
    const f = fixture();
    // 把全局 fixture 章节重置成单个空段落块，保证用例互不影响
    await page.request.put(`/api/chapters/${f.chapter.id}`, {
      data: { blocks: [{ id: 'blk-e2e', type: 'paragraph', content: '' }] },
    });
    await page.goto(`/works/${f.work.id}`);
    await expect(page.locator('.ant-input-borderless')).toBeVisible();
    await expect(page.locator('[data-block-id]')).toHaveCount(1);
  });

  test('编辑器展示章节标题与正文块', async ({ page }) => {
    await expect(page.locator('.ant-input-borderless')).toHaveValue(fixture().chapter.title);
    await expect(page.locator('textarea[placeholder="正文…"]')).toBeVisible();
  });

  test('输入正文后字数更新并自动落库', async ({ page }) => {
    const f = fixture();
    await page.locator('textarea[placeholder="正文…"]').fill('他走进巷子。');
    await expect(page.getByText('6 字')).toBeVisible();

    // 防抖 800ms 落库，轮询 API 直到字数写回
    await expect(async () => {
      const res = await page.request.get(`/api/chapters/${f.chapter.id}`);
      const chapter = await res.json();
      expect(chapter.word_count).toBe(6);
    }).toPass({ timeout: 15000 });
  });

  test('添加内容块并删除', async ({ page }) => {
    await button(page, '添加内容块').click();
    await button(page, '对白').click();
    await expect(page.locator('[data-block-id]')).toHaveCount(2);
    await expect(page.locator('input[placeholder="说话人"]')).toBeVisible();

    await page.locator('button[title="删除"]').last().click();
    await expect(page.locator('[data-block-id]')).toHaveCount(1);
  });

  test('章节标题失焦后保存', async ({ page }) => {
    const title = page.locator('.ant-input-borderless');
    await title.fill('E2E 改过的标题');
    await title.blur();
    await expect(async () => {
      const res = await page.request.get(`/api/chapters/${fixture().chapter.id}`);
      const chapter = await res.json();
      expect(chapter.title).toBe('E2E 改过的标题');
    }).toPass({ timeout: 15000 });
  });

  test('选中段中一句可标为对白，一次撤销还原', async ({ page }) => {
    const text = page.locator('textarea[placeholder="正文…"]');
    await text.fill('第一句。第二句。第三句。');

    // textarea 是自绘内容，没有 DOM Range：设字符下标后补一对鼠标事件，
    // React 的 onSelect 是靠 mousedown/mouseup 这一路构造出来的，原生 select 事件触发不了。
    await text.evaluate((el) => {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.focus();
      el.setSelectionRange(4, 8);
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    await expect(page.locator('.ct-inline-toolbar')).toBeVisible();
    await button(page, '标记').click();
    await page.locator('.ct-tone-menu').locator('button', { hasText: '对白' }).click();

    // 前段 / 对白 / 后段：原段落被切成三块，对白块带说话人输入框
    await expect(page.locator('[data-block-id]')).toHaveCount(3);
    const blocks = page.locator('[data-block-id]');
    await expect(blocks.nth(0).locator('textarea')).toHaveValue('第一句。');
    await expect(blocks.nth(1).locator('input[placeholder="说话人"]')).toBeVisible();
    await expect(blocks.nth(1).locator('textarea')).toHaveValue('第二句。');
    await expect(blocks.nth(2).locator('textarea')).toHaveValue('第三句。');

    // 一组拆块只记一个撤销点：按一次就回到原段落
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await expect(page.locator('[data-block-id]')).toHaveCount(1);
    await expect(page.locator('textarea[placeholder="正文…"]')).toHaveValue(
      '第一句。第二句。第三句。'
    );
  });

  test('防抖窗口内切章，刚写的字不丢', async ({ page }) => {
    const f = fixture();
    // 章节名带时间戳：重试用例复用同一个库，固定名字会堆出重复行
    const otherTitle = `换章测试 ${Date.now()}`;
    const created = await page.request.post(`/api/works/${f.work.id}/chapters`, {
      data: { title: otherTitle },
    });
    expect(created.ok()).toBeTruthy();

    await page.goto(`/works/${f.work.id}`);
    await expect(page.locator('[data-block-id]')).toHaveCount(1);
    // 别的用例可能改过标题，现取当前章名，别用 fixture 里的旧值
    const firstTitle = await page.locator('.ant-input-borderless').inputValue();

    // 写完立刻切章：800ms 防抖还没触发，最容易被上一次实现整段丢掉
    await page.locator('textarea[placeholder="正文…"]').fill('换章前刚写的一句。');
    await page.locator('.ct-tree-label', { hasText: otherTitle }).first().click();
    await expect(page.locator('.ant-input-borderless')).toHaveValue(otherTitle);
    // 新章还没有块：确认确实切过去了，而不是停在旧章
    await expect(page.locator('[data-block-id]')).toHaveCount(0);

    // 切回来，内容必须还在
    await page.locator('.ct-tree-label', { hasText: firstTitle }).first().click();
    await expect(page.locator('textarea[placeholder="正文…"]')).toHaveValue('换章前刚写的一句。');
  });
});
