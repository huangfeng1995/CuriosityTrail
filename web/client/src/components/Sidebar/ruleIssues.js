import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api/client';

/**
 * 规则检查（免费、无模型调用）的静默自查。
 *
 * 左栏不再有「检查」面板：作者写稿时不需要一直盯着一张问题清单。
 * 但规则层的结果仍然有价值——只在**高优先级**问题存在时，
 * 在对应章节行点一个小圆点；点开才在右栏列出来。
 *
 * 触发时机：
 *   · 打开作品时跑一次；
 *   · 每次自动保存成功后跑一次（连续保存合并成一次，不是每个字都查）。
 * 失败静默：这是后台自查，不能因为一次 500 就打断写作。
 */

/** 保存成功后等这么久再查：把连续几次保存合并成一次。 */
const SAVE_CHECK_DELAY_MS = 1200;

/**
 * 把高优先级结论归到章节。
 *
 * 规则层的结论大多只有 target（人物名/设定名/章节标题），没有 chapterId。
 * 能确定章节的只有三种：
 *   1. 服务端直接给了 chapterId / chapterSeq；
 *   2. 标题里写了「第 N 章」（锚点冲突就是这么生成的）；
 *   3. target 恰好等于某个章节的标题（章节状态异常）。
 * 归不到章节的全书级问题不画圆点——硬贴到某一章上只会误导作者。
 *
 * @param {Array<Object>} issues 服务端返回的结论
 * @param {Array<Object>} chapters 当前作品的章节
 * @returns {Map<string, Array<Object>>} chapterId → 该章的高优先级结论
 */
export function groupHighIssues(issues, chapters) {
  const map = new Map();
  const list = Array.isArray(issues) ? issues : [];
  const chapterList = Array.isArray(chapters) ? chapters : [];

  const bySeq = new Map();
  const byTitle = new Map();
  chapterList.forEach((c) => {
    const seq = Number(c.seq);
    if (Number.isFinite(seq)) bySeq.set(seq, c);
    const title = String(c.title || '');
    if (title) {
      if (!byTitle.has(title)) byTitle.set(title, []);
      byTitle.get(title).push(c);
    }
  });

  const push = (chapterId, issue) => {
    if (!chapterId) return;
    if (!map.has(chapterId)) map.set(chapterId, []);
    map.get(chapterId).push(issue);
  };

  list.forEach((issue) => {
    if (!issue || issue.severity !== 'high') return;
    // 已采纳的结论保留在库里，但不再是「需要处理的问题」。
    if (issue.status === 'adopted') return;

    if (issue.chapterId) {
      push(issue.chapterId, issue);
      return;
    }

    if (issue.chapterSeq) {
      const chapter = bySeq.get(Number(issue.chapterSeq));
      if (chapter) {
        push(chapter.id, issue);
        return;
      }
    }

    const seqMatch = /第\s*(\d+)\s*章/.exec(String(issue.title || ''));
    if (seqMatch) {
      const chapter = bySeq.get(Number(seqMatch[1]));
      if (chapter) {
        push(chapter.id, issue);
        return;
      }
    }

    const sameTitle = byTitle.get(String(issue.target || '')) || [];
    sameTitle.forEach((chapter) => push(chapter.id, issue));
  });

  return map;
}

/**
 * 静默跑规则检查。
 *
 * @param {string|undefined} workId
 * @param {string} saveStatus 工作区保存状态（saved 时触发增量自查）
 * @returns {{issues: Array<Object>}}
 */
export default function useRuleIssues(workId, saveStatus) {
  const [issues, setIssues] = useState([]);
  const seqRef = useRef(0);
  const timerRef = useRef(null);

  const run = useCallback(async () => {
    if (!workId) return;
    const seq = ++seqRef.current;
    try {
      const res = await api.get(`/consistency/${workId}`);
      if (seq !== seqRef.current) return;
      setIssues(Array.isArray(res.data?.issues) ? res.data.issues : []);
    } catch (e) {
      // 静默失败：下一次保存后会再查，不用拿错误弹窗打断作者
    }
  }, [workId]);

  // 打开作品（或换作品）先跑一次；旧作品的结果立即作废。
  useEffect(() => {
    setIssues([]);
    seqRef.current += 1;
    run();
    return () => {
      seqRef.current += 1;
      clearTimeout(timerRef.current);
    };
  }, [run]);

  // 保存成功后补跑一次，等作者停手再查。
  useEffect(() => {
    if (saveStatus !== 'saved') return undefined;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(run, SAVE_CHECK_DELAY_MS);
    return () => clearTimeout(timerRef.current);
  }, [saveStatus, run]);

  return { issues };
}
