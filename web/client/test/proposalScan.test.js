import test from 'node:test';
import assert from 'node:assert/strict';

import api from '../src/api/client.js';
import {
  resetProposalScan,
  resetScanBaseline,
  scheduleBlockScan,
  scanAdoptedBlock,
  markBlockScanned,
  dismissProposalsFrom,
} from '../src/components/Assistant/proposalScan.js';

const DEBOUNCE_WAIT = 1800;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 装一个只记账的 adapter，返回调用列表。 */
function stubAdapter(handler) {
  const calls = [];
  api.defaults.adapter = async (config) => {
    const body = config.data ? JSON.parse(config.data) : {};
    calls.push({ url: config.url, body });
    const data = await (handler ? handler(body, config) : { proposals: [] });
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
  return calls;
}

test.beforeEach(() => {
  resetProposalScan();
});

test('保存后只送改动过的 block，没改的不重复识别', async () => {
  const calls = stubAdapter();

  const blocks = [
    { id: 'b1', content: '第一段原文，写的是雨落在青石板上，巷子里没有一个人。' },
    { id: 'b2', content: '第二段原文，写的是城隍庙的门槛上积着水，供桌下压着旧案。' },
  ];
  resetScanBaseline({ workId: 'w1', chapterId: 'c1', blocks });

  // 基线刚建好：原样保存一次，不应触发任何识别
  scheduleBlockScan({ workId: 'w1', chapterId: 'c1', blocks });
  await wait(DEBOUNCE_WAIT);
  assert.strictEqual(calls.length, 0, '内容没变时不应调用识别');

  // 只改 b1
  const changed = [blocks[0], { ...blocks[1] }];
  changed[0] = {
    ...blocks[0],
    content:
      '第一段改过了，写的是雨停了，青石板上只剩一层薄薄的水光，巷子深处传来更鼓声，一下一下敲得人心慌。',
  };
  scheduleBlockScan({ workId: 'w1', chapterId: 'c1', blocks: changed });
  await wait(DEBOUNCE_WAIT);

  assert.strictEqual(calls.length, 1, '一次保存只应发一次识别');
  assert.deepStrictEqual(
    calls[0].body.blocks.map((b) => b.blockId),
    ['b1'],
    '只送改动过的 b1'
  );

  // 再保存一次同样的内容：已经扫过，不再调用
  scheduleBlockScan({ workId: 'w1', chapterId: 'c1', blocks: changed });
  await wait(DEBOUNCE_WAIT);
  assert.strictEqual(calls.length, 1, '相同内容不应重复识别');
});

test('连续输入合并成一次识别，只送最新的文字', async () => {
  const calls = stubAdapter();
  const base = [
    { id: 'b1', content: '第一版正文，写的是雨落在青石板上，巷子里没有一个人。' },
  ];
  resetScanBaseline({ workId: 'w1', chapterId: 'c1', blocks: base });

  scheduleBlockScan({
    workId: 'w1',
    chapterId: 'c1',
    blocks: [
      {
        id: 'b1',
        content:
          '第二版正文，写的是雨落在青石板上，巷口多了一盏灯，灯下的影子被风吹得摇摇晃晃。',
      },
    ],
  });
  scheduleBlockScan({
    workId: 'w1',
    chapterId: 'c1',
    blocks: [
      {
        id: 'b1',
        content:
          '第三版正文，写的是雨落在青石板上，灯下站着一个人，手里提着一把还在滴水的旧伞。',
      },
    ],
  });
  await wait(DEBOUNCE_WAIT);

  assert.strictEqual(calls.length, 1, '窗口内的连续保存应合并');
  assert.strictEqual(
    calls[0].body.blocks[0].text,
    '第三版正文，写的是雨落在青石板上，灯下站着一个人，手里提着一把还在滴水的旧伞。'
  );
});

test('多个改动 block 按字数分批发送', async () => {
  const calls = stubAdapter();
  const long = (tag) => `${tag}` + '字'.repeat(1499); // 每段 1500 字
  const base = [
    { id: 'b1', content: long('一') },
    { id: 'b2', content: long('二') },
    { id: 'b3', content: long('三') },
  ];
  resetScanBaseline({ workId: 'w1', chapterId: 'c1', blocks: base });

  const changed = base.map((b) => ({ ...b, content: `${b.content}改` }));
  scheduleBlockScan({ workId: 'w1', chapterId: 'c1', blocks: changed });
  await wait(DEBOUNCE_WAIT);

  assert.strictEqual(calls.length, 2, '三段共 4500 字，应按 3500 上限拆成两批');
  const sizes = calls.map((c) => c.body.blocks.length);
  assert.deepStrictEqual(sizes, [2, 1]);
});

test('采纳识别带 originRef，并在完成后把这段记为已扫', async () => {
  const calls = stubAdapter(() => ({
    proposals: [{ kind: 'character', title: '林砚' }],
  }));
  resetScanBaseline({
    workId: 'w1',
    chapterId: 'c1',
    blocks: [{ id: 'b1', content: '旧的一段正文。' }],
  });

  await scanAdoptedBlock({
    workId: 'w1',
    chapterId: 'c1',
    blockId: 'b1',
    text: '林砚把伞靠在门边，抬头看见城隍庙的门槛上积着水。',
    originRef: 'msg-1',
  });

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].body.originRef, 'msg-1', '应带上来源采纳');
  assert.strictEqual(calls[0].body.blockId, 'b1');

  // 采纳这段后保存：不应再识别一遍
  scheduleBlockScan({
    workId: 'w1',
    chapterId: 'c1',
    blocks: [
      { id: 'b1', content: '林砚把伞靠在门边，抬头看见城隍庙的门槛上积着水。' },
    ],
  });
  await wait(DEBOUNCE_WAIT);
  assert.strictEqual(calls.length, 1, '采纳识别过的段落保存时不应重复识别');
});

test('撤销会等这一轮识别落地后再作废提案', async () => {
  let resolveScan;
  const calls = stubAdapter((body, config) => {
    if (config.url === '/card-proposals/scan') {
      return new Promise((resolve) => {
        resolveScan = () => resolve({ proposals: [{ kind: 'plot', title: '节点' }] });
      });
    }
    return { dismissed: 1, confirmed: 0 };
  });

  resetScanBaseline({ workId: 'w1', chapterId: 'c1', blocks: [] });

  const adoption = scanAdoptedBlock({
    workId: 'w1',
    chapterId: 'c1',
    blockId: 'b1',
    text: '他在供桌下翻出一卷旧案，封皮上的字被潮气洇开了。',
    originRef: 'msg-9',
  });

  // 识别还没回来就点撤销
  const revoke = dismissProposalsFrom('msg-9');

  // 此时只应有识别请求，还没有作废请求
  assert.strictEqual(calls.length, 1, '作废应等识别落地');
  assert.strictEqual(calls[0].url, '/card-proposals/scan');

  resolveScan();
  await adoption;
  await revoke;

  const urls = calls.map((c) => c.url);
  assert.deepStrictEqual(urls, ['/card-proposals/scan', '/card-proposals/dismiss-source']);
  assert.strictEqual(calls[1].body.originRef, 'msg-9');
});

test('撤销后基线退回原文，保存不会把旧文再识别一遍', async () => {
  const calls = stubAdapter();
  resetScanBaseline({
    workId: 'w1',
    chapterId: 'c1',
    blocks: [{ id: 'b1', content: '原来的正文，写的是雨落在青石板上，巷口没有人。' }],
  });

  markBlockScanned('c1', 'b1', 'AI 写入的正文，写的是林砚在供桌下翻出一卷旧案卷宗。');
  // 撤销：正文回到原样
  markBlockScanned('c1', 'b1', '原来的正文，写的是雨落在青石板上，巷口没有人。');

  scheduleBlockScan({
    workId: 'w1',
    chapterId: 'c1',
    blocks: [{ id: 'b1', content: '原来的正文，写的是雨落在青石板上，巷口没有人。' }],
  });
  await wait(DEBOUNCE_WAIT);

  assert.strictEqual(calls.length, 0, '撤销回原文后不应再识别');
});
