'use strict';

// 素材库：搜索、引用定位、focus 参数打开编辑弹窗。

const { test, expect } = require('@playwright/test');
const { fixture } = require('../helpers');

test.describe('素材库', () => {
  test('搜索素材能命中正文片段', async ({ page }) => {
    const f = fixture();
    await page.goto('/materials');

    const search = page.getByPlaceholder('搜索素材标题、正文、标签');
    await search.fill('青石板');
    await search.press('Enter');
    await expect(page.getByText(f.material.title).first()).toBeVisible();

    const res = await page.request.get(`/api/materials/search?q=${encodeURIComponent('青石板')}`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const list = Array.isArray(body) ? body : body.results || body.items || [];
    expect(list.some((m) => m.id === f.material.id)).toBe(true);
  });

  test('引用定位高亮命中原文片段', async ({ page }) => {
    const f = fixture();
    await page.goto(
      `/materials?focus=${f.material.id}&snippet=${encodeURIComponent(f.materialSnippet)}`
    );
    await expect(page.locator('.ant-drawer mark').first()).toContainText(f.materialSnippet);
  });

  test('focus 参数打开素材编辑弹窗', async ({ page }) => {
    const f = fixture();
    await page.goto(`/materials?focus=${f.material.id}`);
    await expect(page.locator('.ant-modal').last()).toBeVisible();
  });
});
