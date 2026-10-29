'use strict';

/**
 * 全局前置：登录一次，把会话写进 storage state。
 *
 * 为什么不每个用例各登录一次？
 * 登录接口有防爆破限流（同一 IP 每 15 分钟 5 次）。用例一多就会被限流打回，
 * 测试变成随机失败。登录一次、把 Cookie 存下来给所有用例复用，问题就没了。
 *
 * 顺带把要用的测试数据也准备好：一部作品、一个章节。
 * 作品和章节是所有用例的公共起点，后面的用例往上面加内容。
 */

const fs = require('fs');
const path = require('path');
const { request } = require('@playwright/test');

const PORT = Number(process.env.E2E_PORT || 3457);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PHONE = process.env.E2E_PHONE || '13700000000';
const SMS_CODE = process.env.E2E_SMS_CODE || '135790';

const STATE_FILE = path.join(__dirname, '.tmp', 'storage-state.json');

/** 公共测试数据，写到临时文件里给用例读 */
const FIXTURE_FILE = path.join(__dirname, '.tmp', 'fixture.json');

async function main() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

  const ctx = await request.newContext({ baseURL: BASE_URL });

  // 1. 走「发验证码 → 登录」流程，拿到会话 Cookie
  const sendRes = await ctx.post('/api/auth/send-code', {
    data: { phone: PHONE },
  });
  if (!sendRes.ok()) {
    throw new Error(`E2E 发送验证码失败（${sendRes.status()}）：${await sendRes.text()}`);
  }

  const loginRes = await ctx.post('/api/auth/login', {
    data: { phone: PHONE, code: SMS_CODE },
  });
  if (!loginRes.ok()) {
    const body = await loginRes.text();
    throw new Error(`E2E 登录失败（${loginRes.status()}）：${body}`);
  }

  // 2. 存下登录态，后续所有用例直接带着它跑
  await ctx.storageState({ path: STATE_FILE });

  // 3. 准备公共数据：一部作品 + 一个章节
  const workRes = await ctx.post('/api/works', {
    data: { title: 'E2E 测试小说', genre: '悬疑', synopsis: '给自动化测试用的样稿' },
  });
  if (!workRes.ok()) {
    throw new Error(`创建测试作品失败（${workRes.status()}）：${await workRes.text()}`);
  }
  const work = await workRes.json();

  const chapterRes = await ctx.post(`/api/works/${work.id}/chapters`, {
    data: { title: '第一章 雨夜' },
  });
  if (!chapterRes.ok()) {
    throw new Error(`创建测试章节失败（${chapterRes.status()}）：${await chapterRes.text()}`);
  }
  const chapter = await chapterRes.json();

  // 4. 一条素材，供"引用定位"用例查找原文
  const body =
    '雨夜的巷子很窄，两边的墙挤过来，只留一线天。' +
    '陈默把伞收了，雨水顺着伞骨往下淌，在青石板上砸出一串细响。' +
    '巷口的路灯忽明忽暗，把他的影子拉长又压短。';
  const materialRes = await ctx.post('/api/materials', {
    data: { title: '雨夜巷子', body, source: '手记', tags: '环境描写,悬疑' },
  });
  if (!materialRes.ok()) {
    throw new Error(`创建测试素材失败（${materialRes.status()}）：${await materialRes.text()}`);
  }
  const material = await materialRes.json();

  fs.writeFileSync(
    FIXTURE_FILE,
    JSON.stringify(
      {
        work,
        chapter,
        material,
        // 素材正文里的一段，用来验证"定位到原文"能高亮到正确位置
        materialSnippet: '雨水顺着伞骨往下淌，在青石板上砸出一串细响',
      },
      null,
      2
    )
  );

  await ctx.dispose();
}

module.exports = main;
