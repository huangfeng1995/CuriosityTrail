'use strict';

// 左栏面板：情节卡 / 版本历史 / 写作进度 / 一致性检查。

const { test, expect } = require('@playwright/test');
const { fixture, button, openTab, activePane } = require('../helpers');

test.describe('左栏面板', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/works/${fixture().work.id}`);
    await expect(page.locator('.ant-input-borderless')).toBeVisible();
  });

  test('情节卡：新建卡片并切换状态', async ({ page }) => {
    const f = fixture();
    await openTab(page, '情节');
    const pane = activePane(page);

    await button(pane, '新建情节卡').click();
    const modal = page.locator('.ant-modal').last();
    await modal.getByPlaceholder('例：陈默在档案室发现第三份验尸报告').fill('E2E 情节卡');
    await button(modal, '保存').click();
    await expect(modal).toBeHidden();

    // 卡片默认只带章节筛选，切到「全部」看得到
    await pane.getByText('全部').click();
    await expect(pane.getByText('E2E 情节卡').first()).toBeVisible();

    // 状态 Tag 点击循环 todo -> doing
    await pane.getByText('待写').first().click();
    await expect(pane.getByText('进行中').first()).toBeVisible();

    const cards = await (await page.request.get(`/api/plot-cards/work/${f.work.id}`)).json();
    expect(cards.some((c) => c.title === 'E2E 情节卡')).toBe(true);
  });

  test('版本历史：手动存档出现在列表', async ({ page }) => {
    // 历史版本收在章节头的「⋯」里
    await page.locator('button[aria-label="更多章节操作"]').click();
    await page.locator('.ant-dropdown-menu-item:has-text("历史版本")').click();
    const drawer = page.locator('.ant-drawer').last();
    await expect(drawer).toBeVisible();

    await drawer.getByPlaceholder('给这一版起个名字，如「第三章结尾定稿」').fill('E2E 存档');
    await button(drawer, '存档').click();
    await expect(drawer.getByText('E2E 存档').first()).toBeVisible();
    await expect(drawer.getByText('手动').first()).toBeVisible();
  });

  test('作品：在设置「作品」里设置目标字数', async ({ page }) => {
    const f = fixture();
    // 作品信息与进度已从写作页左栏迁到设置页
    await page.goto(`/settings?tab=work&work=${f.work.id}`);
    await expect(page.locator('.ant-tabs-tab-active')).toContainText('作品');

    const input = page.getByPlaceholder('未设定');
    await input.fill('10000');
    await button(page, '保存作品信息').click();
    await expect(page.locator('.ant-message').getByText('已保存')).toBeVisible();

    const work = await (await page.request.get(`/api/works/${f.work.id}`)).json();
    expect(work.targetWords ?? work.target_words).toBe(10000);
  });

  test('快捷键：⌘⇧\\ 收左栏、⌘\\ 收右栏', async ({ page }) => {
    // Shift+\ 在多数布局产出的是 '|'，按 e.key 判定时会失灵；这里用真实按键回归
    await page.keyboard.press('Meta+Shift+Backslash');
    await expect(page.locator('.ct-col-left')).toHaveAttribute('data-hidden', 'true');
    await page.keyboard.press('Meta+Shift+Backslash');
    await expect(page.locator('.ct-col-left')).not.toHaveAttribute('data-hidden', 'true');

    await page.keyboard.press('Meta+Backslash');
    await expect(page.locator('.ct-col-right')).toHaveAttribute('data-hidden', 'true');
    await page.keyboard.press('Meta+Backslash');
    await expect(page.locator('.ct-col-right')).not.toHaveAttribute('data-hidden', 'true');
  });

  test('一致性检查：规则检查可运行', async ({ page }) => {
    const f = fixture();
    await openTab(page, '检查');
    const pane = activePane(page);

    await button(pane, '规则检查').click();
    await expect(pane.getByText('没发现问题').first()).toBeVisible();

    const res = await page.request.get(`/api/consistency/${f.work.id}`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(Array.isArray(body.issues)).toBe(true);
  });
});
