'use strict';

// 素材库勾选框：真实渲染用例。
//
// 曾经把 Checkbox 传给 List.Item 的 avatar（属于 List.Item.Meta），
// antd 把它当未知属性透传到 <li>（li 上出现 avatar="[object Object]"），
// 勾选框从未挂载，导致「升格为史实锚点 / 确认入库 / 撤回」永远不可达。
//
// 这里用真实的页面渲染 + mock 列表数据，不依赖数据库里的素材数量。

const { test, expect } = require('@playwright/test');
const { button } = require('../helpers');

const MATERIALS = [
  {
    id: 'mat-sourced',
    title: '明代更鼓',
    source: '书籍',
    confidence: 'sourced',
    status: 'confirmed',
    preview: '京城夜禁以更鼓为号……',
    provenance: '《明史·兵志》',
    char_count: 120,
    page_count: 2,
    tags: '制度,夜禁',
    created_by: 'agent',
  },
  {
    id: 'mat-pending',
    title: '雨夜巷子',
    source: '手记',
    confidence: 'inferable',
    status: 'pending',
    preview: '雨水顺着伞骨往下淌……',
    char_count: 80,
  },
  {
    id: 'mat-missing',
    title: '待补：更夫口音',
    source: '手记',
    confidence: 'missing',
    status: 'confirmed',
    preview: '待补：缺更夫的口音细节',
    char_count: 40,
  },
];

async function mockApi(page) {
  await page.route('**/api/materials', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: MATERIALS });
      return;
    }
    await route.fallback();
  });
  await page.route('**/api/materials/confirm', (route) =>
    route.fulfill({ json: { confirmed: 2 } })
  );
  await page.route('**/api/materials/*/retract', (route) =>
    route.fulfill({ json: { ok: true } })
  );
  await page.route('**/api/works', (route) =>
    route.fulfill({
      json: [{ id: 'w-e2e', title: '测试作品', template: 'history_thriller' }],
    })
  );
}

test.describe('素材库勾选', () => {
  test('每条素材都有勾选框，li 不再泄漏 avatar 属性', async ({ page }) => {
    await mockApi(page);
    await page.goto('/materials');

    await expect(page.locator('.ant-list-item')).toHaveCount(MATERIALS.length);
    await expect(page.locator('.ant-list-item input[type="checkbox"]')).toHaveCount(
      MATERIALS.length
    );

    const liAvatarAttrs = await page
      .locator('.ant-list-item')
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('avatar')));
    expect(liAvatarAttrs).toEqual([null, null, null]);

    // 未勾选时三个批量按钮都不渲染
    await expect(button(page, '升格为史实锚点')).toHaveCount(0);
    await expect(button(page, '确认入库')).toHaveCount(0);
    await expect(page.locator('button', { hasText: /撤回（/ })).toHaveCount(0);
  });

  test('勾选 2 条：三个操作出现，「升格为史实锚点」可点开弹窗', async ({ page }) => {
    await mockApi(page);
    await page.goto('/materials');

    const boxes = page.locator('.ant-list-item input[type="checkbox"]');
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await expect(page.getByText('已选 2 条')).toBeVisible();

    // mat-sourced 可升格（非 missing、非 pending）；mat-pending 只能确认入库
    await expect(button(page, '升格为史实锚点（1）')).toBeEnabled();
    await expect(button(page, '确认入库（1）')).toBeEnabled();
    await expect(button(page, '撤回（2）')).toBeEnabled();

    await button(page, '升格为史实锚点（1）').click();
    await expect(page.locator('.ant-modal-title').last()).toContainText('升格为史实锚点');
  });

  test('确认入库：可点并发出批量确认', async ({ page }) => {
    let confirmedBody = null;
    await mockApi(page);
    await page.route('**/api/materials/confirm', async (route) => {
      confirmedBody = route.request().postDataJSON();
      await route.fulfill({ json: { confirmed: 2 } });
    });
    await page.goto('/materials');

    await page.locator('.ant-list-item input[type="checkbox"]').nth(1).check();
    const btn = button(page, '确认入库（1）');
    await expect(btn).toBeEnabled();
    await btn.click();

    await expect(page.locator('.ant-message').getByText(/已确认 2 条/)).toBeVisible();
    expect(confirmedBody).toEqual({ ids: ['mat-pending'] });
  });

  test('撤回：可点并逐条发出撤回', async ({ page }) => {
    const calls = [];
    await mockApi(page);
    await page.route('**/api/materials/*/retract', async (route) => {
      calls.push(route.request().url());
      await route.fulfill({ json: { ok: true } });
    });
    await page.goto('/materials');

    await page.locator('.ant-list-item input[type="checkbox"]').nth(0).check();
    await page.locator('.ant-list-item input[type="checkbox"]').nth(1).check();
    const btn = button(page, '撤回（2）');
    await expect(btn).toBeEnabled();
    await btn.click();

    await expect(page.locator('.ant-message').getByText(/已撤回 2 条/)).toBeVisible();
    expect(calls).toHaveLength(2);
  });

  test('三档底色/图标/边框与出处行仍按原样显示', async ({ page }) => {
    await mockApi(page);
    await page.goto('/materials');

    const lis = page.locator('.ant-list-item');
    await expect(lis.nth(0)).toHaveCSS('border-left-width', '3px');
    await expect(lis.nth(0)).toHaveCSS('border-left-style', 'solid');
    await expect(lis.nth(1)).toHaveCSS('border-left-style', 'solid');
    await expect(lis.nth(2)).toHaveCSS('border-left-style', 'dashed');

    // 筛选 Segmented 上也有「有出处/查不到」，断言必须限定在列表项里
    await expect(lis.nth(0).getByText('有出处', { exact: true })).toBeVisible();
    await expect(lis.nth(1).getByText('可推定', { exact: true })).toBeVisible();
    await expect(lis.nth(2).getByText('查不到', { exact: true })).toBeVisible();
    await expect(lis.nth(0).getByText('出处：《明史·兵志》')).toBeVisible();
  });
});
