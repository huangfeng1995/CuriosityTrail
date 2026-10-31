import React, { useState } from 'react';
import { Typography, Tag } from 'antd';
import { Link } from 'react-router-dom';

const { Paragraph } = Typography;

/**
 * 使用手册。
 *
 * 仿 help center 的形态：左边目录，右边正文。
 * 写给刚打开这个工具、不知道从哪儿下手的人——
 * 手册不是功能列表，是"我现在该点哪里"。
 */

const SECTIONS = [
  {
    id: 'start',
    title: '开始写第一部',
    items: [
      {
        h: '建作品、加章节',
        p: '顶栏「作品」新建一本，进去后在左边目录加章节。正文直接写在中间那块地方，不用点任何按钮——写完自动存。',
      },
      {
        h: '认识三栏布局',
        p: '左边是目录和资料（人物、设定、情节、进度、检查），中间是正文，右边是 AI 助手。三栏中间的竖线可以拖，宽窄自己定；点竖线上的箭头可以整栏收起。',
      },
      {
        h: '先给 AI 一点材料',
        p: 'AI 不知道你书里的事。左边「人物」建人物卡、「设定」建世界观，写 AI 的时候它才有依据。人物卡不用填满，写清身份、性格、说话风格三项就有用。',
      },
    ],
  },
  {
    id: 'ai',
    title: '用 AI 写',
    items: [
      {
        h: '选角色',
        p: '右边顶上有几个角色：写手负责写正文，审稿人挑毛病，资料员找素材。不同角色用不同的提示词，产出方向不一样。',
      },
      {
        h: '它不会替你改稿',
        p: 'AI 给出的改动要你点「应用到正文」才真的写进稿子。它给的是建议，不是决定。',
      },
      {
        h: '不满意就重新生成',
        p: '每条回答底下有「重新生成」。AI 引用了哪条长期记忆你不认可，可以先把它剔掉再重新生成——它就不会再拿那条记忆说事。',
      },
      {
        h: '重要的话记进记忆',
        p: '「记入记忆」按钮会把一条内容存进长期记忆，以后每次对话都会想起来。作者自己划的线，权重比 AI 自己判断的高。',
      },
    ],
  },
  {
    id: 'history',
    title: '找回以前写过的东西',
    items: [
      {
        h: '历史对话',
        p: '输入框左下角的历史按钮，可以翻出之前的对话继续问。换章会另起一段对话——上一章的内容不会串到下一章。',
      },
      {
        h: '版本历史',
        p: '编辑器里的版本历史记着每次保存前的旧稿。改坏了可以回到任意一个时间点。改稿前先存一档，这个习惯能省很多事。',
      },
      {
        h: '撤销',
        p: 'Cmd/Ctrl+Z 撤销正文改动。AI 写进正文后也能撤销，右边那条回答上的「撤销」按钮只撤它自己那一次。',
      },
    ],
  },
  {
    id: 'style',
    title: '把文风调成你要的样子',
    items: [
      {
        h: '文风参照',
        p: '顶栏「文风」里，存下你心里的好文章和讨厌的文章，系统会把它蒸馏成可执行的规则（句长区间、对白占比、禁用词），之后 AI 每次写都照着来。',
      },
      {
        h: '原文不留存',
        p: '粘贴的样例原文只用来提炼规则，提完就丢——因为那可能是别人的作品。从自己写过的章节里选更放心。',
      },
      {
        h: '写作指纹',
        p: '',
        extra: (
          <Paragraph className="ct-manual-extra">
            <Link to="/stats">写作统计页</Link>
            里的「写作指纹」会算出你的平均句长、对白占比、感官词密度。
            这些数字每次算出来都一样，可以直接拿来对照目标。
          </Paragraph>
        ),
      },
    ],
  },
  {
    id: 'data',
    title: '数据与隐私',
    items: [
      {
        h: '导出',
        p: '作品列表和作品内都能导出。导出的内容是纯文本与文档，不含你在别处的任何数据。',
      },
      {
        h: '长期记忆',
        p: 'AI 记住的东西都存在你自己的库里，可以随时清。设置页有记忆状态与重建入口。',
      },
      {
        h: '文风原文与样例',
        p: '不存原文，只存规则。要彻底不留下，删掉那张卡就行。',
      },
    ],
  },
];

export default function ManualPage() {
  const [active, setActive] = useState(SECTIONS[0].id);
  const current = SECTIONS.find((s) => s.id === active) || SECTIONS[0];

  return (
    <div className="ct-page">
      <div className="ct-page-head">
        <div>
          <h2 className="ct-page-title font-serif">使用手册</h2>
          <p className="ct-page-sub">从哪儿开始、怎么写顺、东西存在哪里</p>
        </div>
      </div>

      <div className="ct-manual">
        <nav className="ct-manual-nav">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`ct-manual-nav-item${active === s.id ? ' is-active' : ''}`}
              onClick={() => setActive(s.id)}
            >
              {s.title}
            </button>
          ))}
        </nav>

        <div className="ct-manual-body">
          {SECTIONS.map((s) => (
            <section
              key={s.id}
              className={`ct-manual-section${active === s.id ? ' is-active' : ''}`}
            >
              <h3 className="ct-manual-title">{s.title}</h3>
              {s.items.map((item, i) => (
                <div key={i} className="ct-manual-item">
                  <h4 className="ct-manual-item-h">{item.h}</h4>
                  {item.p && <Paragraph className="ct-manual-item-p">{item.p}</Paragraph>}
                  {item.extra}
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
