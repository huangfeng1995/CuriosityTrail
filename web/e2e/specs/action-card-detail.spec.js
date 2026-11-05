'use strict';

// 操作卡「详情」弹层：mock SSE 用例。
//
// 不走真实模型：拦截 /api/ai/chat，直接回一份带结构化元信息的 SSE 流，
// 断言徽标的警示级别、点开「详情」能看到三项内容、无元信息时入口完全不渲染。
//
// 顺带验证长期记忆偏好：输入区的开关删掉后，写作页仍读 ct:memory:enabled，
// 并把它作为 useMemory 参数发给服务端（只是不能在写作页改）。

const { test, expect } = require('@playwright/test');
const { fixture } = require('../helpers');

const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

// 三项元信息都带：规划降级 + 缺拍 + 史实冲突
const META_EVENTS = [
  { type: 'token', content: '庙门半掩，' },
  {
    type: 'action',
    content: '庙门半掩，主角在门槛外停了停。',
    action: 'append',
    target: '',
    reason: '按节拍表写第二组',
    citations: [],
    findings: [],
    planDegraded: 'invalid',
    beatCheck: {
      covered: [{ id: 'B1' }, { id: 'B2' }],
      missing: ['B3', 'B4'],
      weak: [],
      hookPresent: true,
      chapterGoalMet: true,
    },
    skills: [],
  },
  {
    type: 'anchor_violation',
    violations: [
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
  {
    type: 'done',
    conversationId: 'e2e-mock-meta-conv',
    messageId: 'e2e-mock-meta-msg',
    userMessageId: 'e2e-mock-meta-user',
  },
];

// 没有任何元信息的普通续写
const PLAIN_EVENTS = [
  {
    type: 'action',
    content: '他推开门。',
    action: 'append',
    target: '',
    reason: '',
    citations: [],
    findings: [],
    skills: [],
  },
  {
    type: 'done',
    conversationId: 'e2e-mock-plain-conv',
    messageId: 'e2e-mock-plain-msg',
    userMessageId: 'e2e-mock-plain-user',
  },
];

async function mockChat(page, events, captured) {
  await page.route('**/api/ai/chat', async (route) => {
    captured.body = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
      body: sse(events),
    });
  });
}

async function openWorkspace(page) {
  const f = fixture();
  // 和 writing.spec 一样，先把 fixture 章节重置成单个空段落块
  await page.request.put(`/api/chapters/${f.chapter.id}`, {
    data: { blocks: [{ id: 'blk-e2e', type: 'paragraph', content: '' }] },
  });
  await page.goto(`/works/${f.work.id}`);
  await expect(page.locator('.ant-input-borderless')).toBeVisible();
}

async function ask(page) {
  await page.locator('textarea.ct-ai-textarea').fill('继续写一段');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.locator('.ct-action-card').last()).toBeVisible();
}

test('有元信息：徽标按最重级别着色，详情里三项都在', async ({ page }) => {
  const captured = {};
  await mockChat(page, META_EVENTS, captured);
  await openWorkspace(page);
  await ask(page);

  const card = page.locator('.ct-action-card').last();
  const detail = card.locator('.ct-badge');
  await expect(detail).toHaveCount(1);
  await expect(detail).toHaveText('详情');
  // 史实冲突是最重级别，徽标整体走 is-bad
  await expect(detail).toHaveClass(/is-bad/);

  await detail.click();
  const popover = page.locator('.ant-popover').last();
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('规划降级：格式不合格');
  await expect(popover).toContainText('节拍覆盖：2/4');
  await expect(popover).toContainText('缺拍 B3、B4');
  await expect(popover).toContainText('史实冲突 1 条');
  await expect(popover.locator('.ct-violation-quote')).toContainText(
    '原句：曹操端坐堂上，众客屏息。'
  );
  await expect(popover.locator('.ct-violation-loc')).toContainText('本章正文');

  // 写作页读到了记忆偏好（默认开启），并把它发给服务端
  expect(captured.body?.useMemory).toBe(true);
});

test('有元信息但只有缺拍：徽标走 is-warn', async ({ page }) => {
  const captured = {};
  await mockChat(
    page,
    META_EVENTS.filter((e) => e.type !== 'anchor_violation'),
    captured
  );
  await openWorkspace(page);
  await ask(page);

  const card = page.locator('.ct-action-card').last();
  const detail = card.locator('.ct-badge');
  await expect(detail).toHaveClass(/is-warn/);
  await detail.click();
  await expect(page.locator('.ant-popover').last()).toContainText('缺拍 B3、B4');
});

test('无元信息：详情入口不渲染', async ({ page }) => {
  const captured = {};
  await mockChat(page, PLAIN_EVENTS, captured);
  await openWorkspace(page);
  await ask(page);

  const card = page.locator('.ct-action-card').last();
  await expect(card.locator('.ct-badge')).toHaveCount(0);
  await expect(card).not.toContainText('详情');
  expect(captured.body?.useMemory).toBe(true);
});

test('记忆偏好关闭：写作页仍读 ct:memory:enabled=false，请求带 false', async ({
  page,
}) => {
  const captured = {};
  await mockChat(page, PLAIN_EVENTS, captured);
  await openWorkspace(page);
  // 模拟在设置页关掉长期记忆后回到写作页（开关本身已不在写作页）
  await page.evaluate(() => localStorage.setItem('ct:memory:enabled', 'false'));
  await page.reload();
  await expect(page.locator('.ant-input-borderless')).toBeVisible();
  await ask(page);

  expect(captured.body?.useMemory).toBe(false);
});
