import React, { useEffect, useMemo, useState } from 'react';
import { Input, Modal, Form, message, Empty } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, AimOutlined } from '@ant-design/icons';
import api from '../../api/client';
import { useWorkspace } from '../../store/workspace';
import useCardOccurrences from './useCardOccurrences';
import { CardHitBadge, CardHitList } from './CardOccurrences';

/** 别名串按作者常用的中英文标点拆开，与服务端匹配规则保持一致。 */
function splitAliases(raw) {
  return String(raw || '')
    .split(/[,，、;；|/\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 人物卡面板。
 *
 * 人物卡是 AI 知道"这个人是谁"的唯一来源，因此字段要跟写作决策对齐：
 * 说话风格（对白辨识度）、核心目标（行为动机）、成长弧（转变铺垫）。
 *
 * 每张卡还显示本名和别名在正文里出现的章节：这是「这个角色到底写了多少」
 * 最直接的度量，也是改名时判断影响面的依据。
 */
export default function CharacterPanel({ workId }) {
  const { chapter, loadChapter, dispatch } = useWorkspace();
  const [characters, setCharacters] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();

  // 本名 + 别名一起检索：正文里叫「老陈」和叫「陈默」都是在写这个人
  const cards = useMemo(
    () =>
      characters.map((c) => ({
        id: c.id,
        label: c.name,
        words: [c.name, ...splitAliases(c.aliases)],
      })),
    [characters]
  );
  const { stats, selectedId, toggle, goto } = useCardOccurrences(workId, cards);

  const load = async () => {
    if (!workId) return;
    try {
      const res = await api.get(`/characters?workId=${workId}`);
      setCharacters(res.data);
    } catch (e) {
      message.error('人物卡加载失败');
    }
  };

  useEffect(() => {
    load();
  }, [workId]);

  const openEditor = (character) => {
    setEditing(character || {});
    form.setFieldsValue(
      character || {
        name: '',
        aliases: '',
        role: '',
        identity: '',
        personality: '',
        speech: '',
        goal: '',
        arc: '',
        canon: '',
        stance: '',
        bottom_line: '',
        weakness: '',
        notes: '',
      }
    );
  };

  /**
   * 改名后问一句要不要连正文一起改。
   *
   * 只替换旧本名：别名怎么改是另一件事，自动把「老陈」也换掉
   * 很可能把对白的语气改没了。
   */
  const offerRenameInText = async (from, to, before) => {
    // 出现统计是异步扫的：刚打开面板就改名时 stats 可能还是空的，
    // 直接 return 会让「全文一起改」悄悄不出现，作者以为功能没做。
    // 这里现扫一次旧名，确认正文里到底有没有。
    let known = before;
    if (!known?.total) {
      try {
        const res = await api.post('/occurrences/scan', {
          workId,
          items: [{ key: 'rename', words: [from] }],
        });
        const hit = res.data?.rename;
        if (hit?.total) known = hit;
      } catch (e) {
        // 扫描失败就当没出现：不能因为一个统计把改名本身卡住
      }
    }
    if (!known?.total) return;
    const hits = known;
    Modal.confirm({
      title: '正文里的旧名要一起改吗？',
      content: (
        <div>
          <p style={{ marginBottom: 6 }}>
            正文里有 <b>{hits.total}</b> 处「{from}」，分布在 {hits.chapters.length} 章。
          </p>
          <p style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
            一并替换会直接改写正文，每章都会留一份自动版本，可在版本历史里回滚。
          </p>
        </div>
      ),
      okText: `全部替换（${hits.total} 处）`,
      cancelText: '只改卡片',
      onOk: async () => {
        try {
          const res = await api.post('/occurrences/replace', {
            workId,
            words: [from],
            replacement: to,
          });
          message.success(`已替换 ${res.data.replaced} 处`);
          // 改动明细留在 AI 侧栏：弹窗一关、章节一切，只看 toast 就找不回来了。
          dispatch({
            type: 'message/add',
            message: {
              id: `chg-${Date.now()}`,
              role: 'system',
              content: `已把正文里的「${from}」改成「${to}」，共 ${res.data.replaced} 处`,
              items: res.data.chapters || [],
            },
          });
          // 接口返回的字段名是 chapterId，不是 id——写成 c.id 永远匹配不上，
          // 表现就是「替换成功了，但屏幕上的字没变」。
          if (res.data.chapters?.some((c) => c.chapterId === chapter?.id)) {
            await loadChapter(chapter.id);
          }
          await load();
        } catch (e) {
          message.error(e.response?.data?.error || '替换失败');
        }
      },
    });
  };

  const save = async () => {
    const values = await form.validateFields();
    const oldName = editing?.id ? editing.name : '';
    const newName = String(values.name || '').trim();
    // 改名前的出现统计要现在就取：保存后重扫的是新名字
    const before = editing?.id ? stats[editing.id] : null;
    try {
      if (editing?.id) {
        await api.put(`/characters/${editing.id}`, values);
      } else {
        await api.post('/characters', { ...values, workId });
      }
      setEditing(null);
      message.success('已保存');
      await load();
      if (oldName && newName && newName !== oldName) {
        await offerRenameInText(oldName, newName, before);
      }
    } catch (e) {
      message.error(e.response?.data?.error || '保存失败');
    }
  };

  const remove = (character) => {
    Modal.confirm({
      title: `删除人物「${character.name}」？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await api.delete(`/characters/${character.id}`);
        load();
      },
    });
  };

  if (!workId) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先选一个作品" />;
  }

  return (
    <div className="ct-panel">
      <button type="button" className="ct-add-btn" onClick={() => openEditor(null)}>
        <PlusOutlined />
        新建人物卡
      </button>

      {characters.map((c) => {
        const active = selectedId === c.id;
        return (
          <div key={c.id} className={`ct-card-item${active ? ' is-selected' : ''}`}>
            <div className="ct-item">
              <button
                type="button"
                className="ct-item-main"
                onClick={() => openEditor(c)}
                title={`编辑「${c.name}」`}
              >
                <span className="ct-item-title">{c.name}</span>
                {c.role && <span className="ct-item-meta">{c.role}</span>}
                <CardHitBadge stat={stats[c.id]} />
              </button>
              <div className="ct-item-actions">
                <button
                  type="button"
                  className={`ct-item-act${active ? ' is-on' : ''}`}
                  title={active ? '取消正文标黄' : '在正文中标出这个人物'}
                  aria-label={`定位 ${c.name}`}
                  onClick={() => toggle(cards.find((x) => x.id === c.id))}
                >
                  <AimOutlined />
                </button>
                <button
                  type="button"
                  className="ct-item-act"
                  title="编辑"
                  aria-label={`编辑 ${c.name}`}
                  onClick={() => openEditor(c)}
                >
                  <EditOutlined />
                </button>
                <button
                  type="button"
                  className="ct-item-act is-danger"
                  title="删除"
                  aria-label={`删除 ${c.name}`}
                  onClick={() => remove(c)}
                >
                  <DeleteOutlined />
                </button>
              </div>
            </div>

            {active && (
              <CardHitList stat={stats[c.id]} label={c.name} onGoto={goto} />
            )}
          </div>
        );
      })}

      {characters.length === 0 && (
        <p className="ct-hint">还没有人物卡。AI 写对白时靠它区分说话人。</p>
      )}

      <Modal
        open={!!editing}
        title={editing?.id ? '编辑人物' : '新建人物'}
        okText="保存"
        cancelText="取消"
        width={520}
        onOk={save}
        onCancel={() => setEditing(null)}
      >
        <Form form={form} layout="vertical" size="small" requiredMark={false}>
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入姓名' }]}>
            <Input placeholder="陈默" />
          </Form.Item>
          <Form.Item name="aliases" label="别名 / 称呼" help="用逗号分隔。正文里出现任一称呼，AI 都会带上这张卡。">
            <Input placeholder="老陈，小默" />
          </Form.Item>
          <Form.Item name="role" label="身份">
            <Input placeholder="刑侦支队队长" />
          </Form.Item>
          <Form.Item name="identity" label="背景">
            <Input.TextArea rows={2} placeholder="出身、经历、关键事件" />
          </Form.Item>
          <Form.Item name="personality" label="性格">
            <Input.TextArea rows={2} placeholder="沉稳、多疑、护短" />
          </Form.Item>
          <Form.Item name="speech" label="说话风格" help="这是对白辨识度的关键。">
            <Input.TextArea rows={2} placeholder="话少，句子短，不用形容词" />
          </Form.Item>
          <Form.Item name="goal" label="核心目标" help="他当下最想达成什么，AI 靠它推演行为。">
            <Input placeholder="查清三年前那桩旧案" />
          </Form.Item>
          <Form.Item name="arc" label="成长弧" help="从什么状态变成什么状态。">
            <Input placeholder="从独来独往到愿意信任搭档" />
          </Form.Item>
          {/* 历史悬疑模板的四项。留空不写入任何标签，老卡片行为不变。 */}
          <Form.Item name="canon" label="正史 / 虚构" help="这个人哪些是史实、哪些是虚构。">
            <Input placeholder="史实人物；早年经历为虚构" />
          </Form.Item>
          <Form.Item name="stance" label="立场" help="他站在谁那边，遇到冲突会怎么选。">
            <Input placeholder="忠于司空，但不愿牵连旧友" />
          </Form.Item>
          <Form.Item name="bottom_line" label="底线" help="什么事他绝不会做，越线即人设崩坏。">
            <Input placeholder="不出卖同僚，不杀妇孺" />
          </Form.Item>
          <Form.Item name="weakness" label="弱点" help="能被对手利用的软肋。">
            <Input placeholder="多疑；护短，容易被家人要挟" />
          </Form.Item>
          <Form.Item name="notes" label="备注">
            <Input.TextArea rows={2} placeholder="禁忌、习惯、小动作" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
