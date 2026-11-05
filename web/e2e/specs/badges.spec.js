'use strict';

// HP8 徽标展示：节拍覆盖 / 规划降级 / 史实冲突。
//
// 用真实前端 + 真实历史对话接口渲染：把一份带结构化结果的 payload
// 写进临时库，再从「历史对话」里打开，截图落在 test-results/hp8-badges/。

const path = require('path');
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { fixture } = require('../helpers');

// 必须在 require database 之前指向 E2E 的临时库。
process.env.DATA_DIR = path.join(__dirname, '..', '.tmp', 'data');
const db = require('../../server/database');

const SHOT_DIR = path.join(__dirname, '..', 'test-results', 'hp8-badges');

fs.mkdirSync(SHOT_DIR, { recursive: true });

const CASES = [
  {
    id: 'e2e-badge-beat',
    title: '徽标演示：节拍覆盖',
    content: '庙门半掩，主角在门槛外停了停。',
    payload: {
      action: 'append',
      target: '',
      reason: '按节拍表写第二组',
      citations: [],
      beatCheck: {
        covered: [{ id: 'B1' }, { id: 'B2' }, { id: 'B3' }],
        missing: ['B4'],
        weak: [],
        hookPresent: true,
        chapterGoalMet: true,
      },
      planDegraded: '',
      anchorViolations: [],
    },
  },
  {
    id: 'e2e-badge-degraded',
    title: '徽标演示：规划降级',
    content: '县衙后门当晚抬出一口箱子。',
    payload: {
      action: 'append',
      target: '',
      reason: '规划格式不合格，已降级直写',
      citations: [],
      beatCheck: null,
      planDegraded: 'invalid',
      anchorViolations: [],
    },
  },
  {
    id: 'e2e-badge-conflict',
    title: '徽标演示：史实冲突',
    content: '曹操端坐堂上，众客屏息。县衙后门当晚抬出一口箱子。',
    payload: {
      action: 'append',
      target: '',
      reason: '按节拍表写第一组',
      citations: [],
      beatCheck: null,
      planDegraded: '',
      anchorViolations: [
        {
          anchorId: 'e2e-anchor-cao',
          ruleType: 'presence_forbidden',
          quote: '曹操端坐堂上，众客屏息。',
          offset: 0,
          blockId: '',
          severity: 'block',
        },
      ],
    },
  },
];

async function seedConversation(item) {
  const { work } = fixture();
  const user = await db.get('SELECT id FROM users WHERE phone = ?', ['13700000000']);
  expect(user).toBeTruthy();

  await db.run('DELETE FROM messages WHERE conversation_id = ?', [item.id]);
  await db.run('DELETE FROM conversations WHERE id = ?', [item.id]);
  await db.run(
    `INSERT INTO conversations (id, user_id, work_id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, '2026-11-05T09:00:00.000Z', '2026-11-05T09:00:00.000Z')`,
    [item.id, user.id, work.id, item.title]
  );
  await db.run(
    `INSERT INTO messages (id, conversation_id, role, content, role_key, action, payload, citations, created_at)
     VALUES (?, ?, 'assistant', ?, 'writer', 'append', ?, '[]', '2026-11-05T09:00:00.000Z')`,
    [`${item.id}-msg`, item.id, item.content, JSON.stringify(item.payload)]
  );
}

async function openSeededConversation(page, item) {
  const { work } = fixture();
  await page.goto(`/works/${work.id}`);
  await expect(page.locator('.ant-input-borderless')).toBeVisible();

  // 历史对话按钮是输入区左侧的第一个图标按钮
  await page.locator('.ct-ai-actions button').first().click();
  const drawer = page.locator('.ant-drawer').last();
  await expect(drawer).toBeVisible();
  await drawer.locator(`.ct-history-item:has-text("${item.title}")`).click();
  await expect(page.locator('.ct-action-card').last()).toBeVisible();
}

test.beforeAll(async () => {
  await db.ready;
  for (const item of CASES) await seedConversation(item);
});

test('节拍覆盖：显示「节拍 3/4 · 缺拍 B4」', async ({ page }) => {
  await openSeededConversation(page, CASES[0]);
  const card = page.locator('.ct-action-card').last();
  const badge = card.locator('.ct-badge.is-warn');
  await expect(badge).toContainText('节拍 3/4');
  await expect(badge).toContainText('缺拍 B4');

  const shot = path.join(SHOT_DIR, '01-beat-coverage.png');
  await card.screenshot({ path: shot });
  console.log('[badge-shot] 节拍覆盖 →', shot, '；点击次数 = 0（纯展示）');
});

test('规划降级：显示「规划降级（格式不合格）」', async ({ page }) => {
  await openSeededConversation(page, CASES[1]);
  const card = page.locator('.ct-action-card').last();
  await expect(card.locator('.ct-badge.is-warn')).toContainText('规划降级（格式不合格）');

  const shot = path.join(SHOT_DIR, '02-plan-degraded.png');
  await card.screenshot({ path: shot });
  console.log('[badge-shot] 规划降级 →', shot, '；点击次数 = 0（纯展示）');
});

test('史实冲突：点 1 次徽标看到原句与定位', async ({ page }) => {
  await openSeededConversation(page, CASES[2]);
  const card = page.locator('.ct-action-card').last();
  const badge = card.locator('.ct-badge.is-bad');
  await expect(badge).toContainText('史实冲突 1');

  await badge.click();
  const popover = page.locator('.ant-popover').last();
  await expect(popover).toBeVisible();
  await expect(popover.locator('.ct-violation-quote')).toContainText(
    '原句：曹操端坐堂上，众客屏息。'
  );
  await expect(popover.locator('.ct-violation-loc')).toContainText('本章正文');
  await expect(popover.locator('.ct-violation-loc')).toContainText('字符偏移 0');

  const shot = path.join(SHOT_DIR, '03-anchor-conflict-open.png');
  await page.screenshot({ path: shot });
  console.log('[badge-shot] 史实冲突（已打开）→', shot, '；点击次数 = 1');
});
