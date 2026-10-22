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
});
