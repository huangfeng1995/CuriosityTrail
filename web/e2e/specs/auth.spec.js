'use strict';

// 登录鉴权（手机号 + 短信验证码）。
// 注意：发验证码与登录都有频率限制，所以这里只保留一次真实登录，勿再加失败尝试。

const { test, expect } = require('@playwright/test');

const PHONE = process.env.E2E_PHONE || '13700000000';
const SMS_CODE = process.env.E2E_SMS_CODE || '135790';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('登录鉴权', () => {
  test('未登录访问工作区会跳转到登录页', async ({ page }) => {
    await page.goto('/works');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByPlaceholder('手机号')).toBeVisible();
  });

  test('验证码登录后进入作品列表，登出后回到登录页', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('手机号').fill(PHONE);
    await page.getByRole('button', { name: /获取验证码/ }).click();
    await page.getByPlaceholder('验证码').fill(SMS_CODE);
    await page.locator('button[type="submit"]').click();

    await expect(page).toHaveURL(/\/works/);
    await expect(page.getByText('我的作品').first()).toBeVisible();

    // 退出登录（lucide 图标按钮）
    await page.locator('button:has(.lucide-log-out)').click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByPlaceholder('手机号')).toBeVisible();
  });
});
