'use strict';

// E2E 公共工具。注意：不要在模块顶层读 fixture.json —
// Playwright 会先加载测试文件、后跑 globalSetup，顶层读会拿不到文件。

const fs = require('fs');
const path = require('path');

const FIXTURE_PATH = path.join(__dirname, '.tmp', 'fixture.json');

function fixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

// antd 会给「无图标 + 恰好两个汉字」的按钮文本插入空格（如「保 存」），
// 统一用宽松正则匹配，避免 strict mode / 匹配失败。
function spaced(text) {
  return new RegExp('^' + text.split('').join('\\s*') + '$');
}

// 在给定作用域内找按钮（文本可能是「保 存」也可能是「保存」）
function button(root, text) {
  return root.locator('button', { hasText: spaced(text) });
}

// 左栏 antd Tabs 溢出后真实点击无效（被 ant-tabs-nav-more 遮挡 / 被 overflow 裁切），
// 必须用 dispatchEvent('click') 切换。
async function openTab(page, label) {
  await page
    .locator('.ant-tabs-tab-btn', { hasText: label })
    .first()
    .dispatchEvent('click');
  await page.locator('.ant-tabs-tabpane-active').first().waitFor();
}

function activePane(page) {
  return page.locator('.ant-tabs-tabpane-active').first();
}

module.exports = { fixture, spaced, button, openTab, activePane };
