'use strict';

/**
 * 范文编排锚点（T6）。
 *
 * 节拍表负责「这一章要发生什么」，锚点负责「好的编排长什么样」。
 * 锚点从基线范文里按节拍抽出示范片段，拼成一段不超过 1500 字的参照，
 * 注入到写手 system 里紧挨节拍表的位置。
 *
 * 三条硬约束：
 *   1. **默认不注入**——必须作者亲手开启并确认一次。
 *   2. **只允许一张**——按 user_id 做主键，一人一行，重复开启是覆盖不是新增。
 *   3. **撤回即清空**——content 置空、enabled 归零、留 withdrawn_at 标记，
 *      不能留下肉眼看不见却仍会被注入的残留内容。
 */

const { get, run } = require('../../database');

/** 锚点来源。数字都来自实测，不是估算。 */
const ANCHOR_SOURCE = Object.freeze({
  file: 'docs/superpowers/baseline/sample.md',
  paragraphs: 45,
  chars: 5047,
  beats: 6,
});

/** 锚点正文上限（字） */
const ANCHOR_MAX_CHARS = 1500;

/**
 * 精选锚点。
 *
 * 不整段搬运：每段只保留能说明编排方式的动作与句子，
 * 后面跟一句「编排方式」点明它在示范什么。
 * 优先覆盖「目标—阻碍—代价」「变量变化」「信息增量」「决定—代价」「章末钩子」。
 */
const ANCHOR_TEXT = `【示范一 · 目标—阻碍—代价】
箭镞对准二十丈外的一头鹿，弓弦已经拉到极限。松手前一刻，他想到「那可是一头母鹿……也许很快就临盆了」，手指动了，箭钉在白桦树干上，鹿逃了。同伴盯着箭痕：「以你的准头，会在这么近的距离失手？」随后把他的箭拿出来，扔进自己箭壶。
编排方式：目标先写得具体可验证；阻碍来自主角自己的软处，不是外部巧合；代价当场落在实物上——猎物没了，箭也被收走。

【示范二 · 变量变化（关系）】
同伴摊手抱怨「趴了一整天，还是两手空空」；他解释，同伴两条淡眉一耸，一脸怨愤瞬间收起，淡淡道：「算了……早点回城吧。」转身就走，留给他一个背影。后来他还在絮叨，同伴忽然勒住坐骑，一挥鞭子抽在马屁股上，坐骑奋蹄狂奔，把后面的人甩开数十步远。
编排方式：争执不靠旁白总结，用「收起表情」「转身留背影」「抽马先走」三个动作，把关系从玩伴推向冷战；变量变化要让读者自己看出来。

【示范三 · 信息增量】
回城路上先落一句「如果一直这样生活下去就好了」，紧接着马蹄声打断——司马懿冲回来，身后跟着老管家：「杨公子，令尊大人到了……急着要见你。」杨平愣住了：父亲上任不过月余，怎么擅离职守跑来温县？
编排方式：先把松弛的日常推到顶点，再用突发消息撞碎它；新信息必须改变人物下一步行动，还要留下一个当场答不出的疑问。

【示范四 · 决定—代价】
杨俊一句「司空传诏，岂能耽搁」，决定便无可更改。按规矩，司空开幕府征辟曹掾是私辟，不该发符传，更不该称「传诏」——这种逾制本身就暗示着不能宣之于口的急切。杨平没有时间收拾行李，只能把犀角弓交给兄长：「以后我估计是用不着了。」司马防抓住杨俊的胳膊：「无论发生什么事，都要保他平安啊。」
编排方式：决定由外力下达，主角没有选择权；先让旁人看出异常却说不出口，再用「交出珍爱之物」和一句托付把代价显形。

【示范五 · 章末钩子】
司马防两手抄在袖中，微微颤动：「杨兄，你可要留神哪……」杨俊拱手，打一个响指；车夫甩响鞭，两匹辕马拖动大车，驶离温县，朝许都方向疾驰而去。而许都是「一个险恶的大旋涡」。
编排方式：结尾不收在情绪上，收在一个正在发生的动作和明确去向；送行者的担忧与险地的定性同时压上来，读者知道下一章必然进入险地。`;

// 锚点在模块加载时就不许超限：超了是选材出错，不能等注入时才截断，
// 否则作者看到的「来源」与真正喂给模型的内容对不上。
if (Array.from(ANCHOR_TEXT).length > ANCHOR_MAX_CHARS) {
  throw new Error(`范文锚点超过 ${ANCHOR_MAX_CHARS} 字上限`);
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * 读取一行锚点记录。没有开启过的用户返回 null。
 */
function getAnchor(userId) {
  if (!userId) return Promise.resolve(null);
  return get('SELECT * FROM reference_anchors WHERE user_id = ?', [userId]);
}

/**
 * 当前锚点状态。给设置页看：开没开、来源是什么、多大、什么时候撤的。
 */
async function getStatus(userId) {
  const row = await getAnchor(userId);
  const enabled = Boolean(row && row.enabled && row.content);
  return {
    enabled,
    hasContent: Boolean(row && row.content),
    source: enabled ? { ...ANCHOR_SOURCE } : null,
    chars: row && row.content ? Array.from(row.content).length : 0,
    maxChars: ANCHOR_MAX_CHARS,
    confirmedAt: row?.confirmed_at || null,
    withdrawnAt: row?.withdrawn_at || null,
  };
}

/**
 * 开启锚点。
 *
 * 必须带 confirmed: true——这是作者在界面上点过确认的回执。
 * 只接受布尔 true，不接受 "true" 之类的字符串，避免前端漏传时被静默放行。
 */
async function enableAnchor(userId, options = {}) {
  if (!userId) throw new Error('缺少用户');
  if (options.confirmed !== true) {
    const err = new Error('需要作者确认后才能启用范文锚点');
    err.status = 400;
    throw err;
  }

  const ts = nowIso();
  const source = JSON.stringify(ANCHOR_SOURCE);
  // 一人一行：user_id 是主键，重复开启只会覆盖同一行，不可能出现第二张。
  await run(
    `INSERT OR REPLACE INTO reference_anchors
       (user_id, enabled, content, source, confirmed_at, withdrawn_at, updated_at)
     VALUES (?, 1, ?, ?, ?, NULL, ?)`,
    [userId, ANCHOR_TEXT, source, ts, ts]
  );

  return getStatus(userId);
}

/**
 * 撤回锚点。
 *
 * 内容必须真的清掉：只置 enabled=0 而把正文留在库里，
 * 下次改库或改代码就可能让它重新生效，作者却以为已经撤回。
 * withdrawn_at 是给设置页看的标记——「这张锚点撤过，不是从来没开过」。
 */
async function withdrawAnchor(userId) {
  const ts = nowIso();
  await run(
    `UPDATE reference_anchors
        SET enabled = 0, content = NULL, source = NULL,
            withdrawn_at = ?, updated_at = ?
      WHERE user_id = ?`,
    [ts, ts, userId]
  );
  return getStatus(userId);
}

/**
 * 拼注入块。
 *
 * 顺序是：标题 → 质量参照声明 → 来源 → 正文。
 * 「不要照抄句子」必须写在最前面：模型看到具体句子时最容易直接复制。
 */
function formatAnchorBlock(content) {
  const body = typeof content === 'string' ? content : String(content?.content || '');
  return [
    '## 范文编排锚点',
    '质量参照，不要照抄句子，要照它的编排方式。',
    `来源：${ANCHOR_SOURCE.file}（${ANCHOR_SOURCE.paragraphs} 段 / ${ANCHOR_SOURCE.chars} 字 / ${ANCHOR_SOURCE.beats} 拍），作者已授权本次注入。`,
    '',
    body,
  ].join('\n');
}

/**
 * 给写手 system 用的注入块。未授权、已撤回或内容为空时返回空串。
 */
async function buildInjection(userId) {
  const row = await getAnchor(userId);
  if (!row || !row.enabled || !row.content) return '';
  return formatAnchorBlock(row.content);
}

module.exports = {
  ANCHOR_SOURCE,
  ANCHOR_MAX_CHARS,
  ANCHOR_TEXT,
  getStatus,
  enableAnchor,
  withdrawAnchor,
  formatAnchorBlock,
  buildInjection,
};
