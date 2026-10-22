'use strict';

// 登录鉴权。
// 注意：登录接口限流 5 次/15 分钟/IP，globalSetup 已用掉 1 次，
// 所以本文件只保留 1 次真实登录，勿再加失败登录用例。

const { test, expect } = require('@playwright/test');

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('登录鉴权', () => {
  test('未登录访问工作区会跳转到登录页', async ({ page }) => {
    await page.goto('/works');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByPlaceholder('访问密码')).toBeVisible();
  });

  test('登录后进入作品列表，登出后回到登录页', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('访问密码').fill('e2e-password-123');
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/works/);
    await expect(page.getByText('我的作品').first()).toBeVisible();

    // 退出登录（lucide 图标按钮）
    await page.locator('button:has(.lucide-log-out)').click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByPlaceholder('访问密码')).toBeVisible();
  });
});
