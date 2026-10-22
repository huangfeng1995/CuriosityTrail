import React, {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import api from '../api/client';
import { convertBlock as convertBlockData } from '../components/Editor/blocks';

/**
 * 工作区全局状态。
 *
 * 跨组件共享的东西：当前作品、章节列表、当前章节与它的块、文本选区、
 * 当前 AI 角色、会话 id、对话消息流、撤销/重做栈、保存状态。
 *
 * 块是编辑器的权威数据；每次改动打 dirty 标记，由本文件统一防抖落库，
 * 避免每个块组件各写各的保存逻辑。
 */
const WorkspaceContext = createContext(null);

// 撤销栈上限。超出就把最早的丢掉。
const MAX_UNDO = 50;
// 连续输入合并窗口：在这个时间内的连续输入算同一次撤销单元。
const EDIT_BURST_MS = 700;

const initialState = {
  work: null,
  chapters: [],
  chapter: null,
  blocks: [],
  selection: null, // { blockId, start, end, text }
  roleKey: 'writer',
  conversationId: null,
  messages: [],
  sending: false,
  streaming: '',
  notice: '',
  error: '',
  // 撤销/重做：past 存历史快照，future 存被撤销掉的快照
  past: [],
  future: [],
  // 保存状态：idle（无改动）/ saving（防抖等待或请求中）/ saved / error
  saveStatus: 'idle',
};

function reducer(state, action) {
  switch (action.type) {
    case 'work/loaded':
      return { ...state, work: action.work, chapters: action.chapters };

    case 'chapter/loaded': {
      const blocks = Array.isArray(action.blocks) ? action.blocks : [];
      return {
        ...state,
        chapter: action.chapter,
        blocks,
        selection: null,
        // 换章即换会话上下文，避免上一章的对话串味
        conversationId: null,
        messages: [],
        streaming: '',
        error: '',
        // 撤销栈按章隔离：上一章的快照对这一章没有意义
        past: [],
        future: [],
        saveStatus: 'idle',
      };
    }

    case 'blocks/set':
      return { ...state, blocks: action.blocks };

    // 版本回滚：整体替换内容。
    // 撤销栈必须清空——栈里的快照是回滚前的内容，留在栈里会让"撤销"跳到无关状态。
    // 但对话不清：回滚只改了正文，作者跟 AI 的对话记录不该被抹掉。
    case 'blocks/replaceAll':
      return {
        ...state,
        blocks: action.blocks,
        past: [],
        future: [],
        saveStatus: 'idle',
      };

    case 'blocks/replace': {
      const blocks = state.blocks.map((b) =>
        b.id === action.id ? { ...b, ...action.patch } : b
      );
      return { ...state, blocks };
    }

    case 'blocks/insert': {
      const blocks = [...state.blocks];
      blocks.splice(action.index, 0, action.block);
      return { ...state, blocks };
    }

    case 'blocks/remove': {
      const blocks = state.blocks.filter((b) => b.id !== action.id);
      return { ...state, blocks };
    }

    case 'blocks/convert': {
      const blocks = state.blocks.map((b) =>
        b.id === action.id ? action.block : b
      );
      return { ...state, blocks };
    }

    case 'blocks/move': {
      const index = state.blocks.findIndex((b) => b.id === action.id);
      const target = index + action.offset;
      if (index < 0 || target < 0 || target >= state.blocks.length) return state;
      const blocks = [...state.blocks];
      const [moved] = blocks.splice(index, 1);
      blocks.splice(target, 0, moved);
      return { ...state, blocks };
    }

    case 'selection/set':
      return { ...state, selection: action.selection };

    case 'role/set':
      return { ...state, roleKey: action.roleKey };

    case 'conversation/set':
      return { ...state, conversationId: action.conversationId };

    case 'message/add':
      return { ...state, messages: [...state.messages, action.message] };

    case 'message/update': {
      const messages = state.messages.map((m) =>
        m.id === action.id ? { ...m, ...action.patch } : m
      );
      return { ...state, messages };
    }

    case 'message/remove':
      return {
        ...state,
        messages: state.messages.filter((m) => m.id !== action.id),
      };

    case 'message/clear':
      return { ...state, messages: [], conversationId: null, streaming: '' };

    case 'sending/set':
      return { ...state, sending: action.sending };

    case 'streaming/set':
      return { ...state, streaming: action.streaming };

    case 'notice/set':
      return { ...state, notice: action.notice, error: action.error || '' };

    case 'history/push': {
      // 记一个撤销点。action.snapshot 是改动前的 blocks。
      const past = [...state.past, action.snapshot].slice(-MAX_UNDO);
      return { ...state, past, future: [], saveStatus: 'dirty' };
    }

    case 'history/undo': {
      if (!state.past.length) return state;
      // 快照栈顶就是"上一步"的状态；当前状态压进 future 供重做
      const restored = state.past[state.past.length - 1];
      const past = state.past.slice(0, -1);
      const future = [...state.future, state.blocks].slice(-MAX_UNDO);
      return { ...state, blocks: restored, past, future, saveStatus: 'dirty' };
    }

    case 'history/redo': {
      if (!state.future.length) return state;
      const restored = state.future[state.future.length - 1];
      const future = state.future.slice(0, -1);
      const past = [...state.past, state.blocks].slice(-MAX_UNDO);
      return { ...state, blocks: restored, past, future, saveStatus: 'dirty' };
    }

    case 'save/status':
      return { ...state, saveStatus: action.status };

    default:
      return state;
  }
}

function parseBlocks(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

export function WorkspaceProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  // blocks 的防抖保存
  const dirtyRef = useRef(false);
  const timerRef = useRef(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!dirtyRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      const { chapter, blocks } = stateRef.current;
      if (!chapter) return;
      dispatch({ type: 'save/status', status: 'saving' });
      try {
        await api.put(`/chapters/${chapter.id}`, { blocks });
        dirtyRef.current = false;
        dispatch({ type: 'save/status', status: 'saved' });
      } catch (e) {
        dispatch({
          type: 'notice/set',
          error: '自动保存失败：' + (e.response?.data?.error || e.message),
        });
        dispatch({ type: 'save/status', status: 'error' });
      }
    }, 800);

    return () => clearTimeout(timerRef.current);
  }, [state.blocks]);

  // 离开页面前把未落库的改动写掉
  useEffect(() => {
    const flush = () => {
      const { chapter, blocks } = stateRef.current;
      if (!dirtyRef.current || !chapter) return;
      dirtyRef.current = false;
      const blob = new Blob(
        [JSON.stringify({ blocks })],
        { type: 'application/json' }
      );
      // 同步请求走 keepalive，页面关闭时也能发出去
      navigator.sendBeacon?.(
        `/api/chapters/${chapter.id}`,
        blob
      );
    };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, []);

  // 上一次输入的归组信息：同一块 + 仍在 burst 窗口内 → 合并成一次撤销单元
  const lastEditRef = useRef(null);

  /**
   * 记一个撤销点。
   *
   * snapshot 是「改动前」的 blocks。连续输入要合并成一次撤销单元：
   * 如果上一次输入还在 burst 窗口内且是同一个块，就不再记新点，
   * 否则连打一句话会产生几十个撤销步。
   */
  const pushHistory = useCallback((snapshot, { groupKey } = {}) => {
    const now = Date.now();
    const last = lastEditRef.current;
    if (groupKey && last && last.key === groupKey && now - last.at < EDIT_BURST_MS) {
      last.at = now;
      return;
    }
    lastEditRef.current = groupKey ? { key: groupKey, at: now } : null;
    dispatch({ type: 'history/push', snapshot });
  }, []);

  const setBlocks = useCallback(
    (blocks) => {
      dirtyRef.current = true;
      dispatch({ type: 'blocks/set', blocks });
    },
    []
  );

  const updateBlock = useCallback(
    (id, patch) => {
      dirtyRef.current = true;
      // 同一个块在 burst 窗口内的连续输入合并成一次撤销
      pushHistory(stateRef.current.blocks, { groupKey: `text:${id}` });
      dispatch({ type: 'blocks/replace', id, patch });
    },
    [pushHistory]
  );

  const insertBlock = useCallback(
    (index, block) => {
      dirtyRef.current = true;
      pushHistory(stateRef.current.blocks);
      dispatch({ type: 'blocks/insert', index, block });
    },
    [pushHistory]
  );

  const removeBlock = useCallback(
    (id) => {
      dirtyRef.current = true;
      pushHistory(stateRef.current.blocks);
      dispatch({ type: 'blocks/remove', id });
    },
    [pushHistory]
  );

  const convertBlock = useCallback(
    (id, type) => {
      const target = stateRef.current.blocks.find((b) => b.id === id);
      if (!target) return;
      dirtyRef.current = true;
      pushHistory(stateRef.current.blocks);
      dispatch({ type: 'blocks/convert', id, block: convertBlockData(target, type) });
    },
    [pushHistory]
  );

  const moveBlock = useCallback(
    (id, offset) => {
      dirtyRef.current = true;
      pushHistory(stateRef.current.blocks);
      dispatch({ type: 'blocks/move', id, offset });
    },
    [pushHistory]
  );

  const undo = useCallback(() => {
    const { past } = stateRef.current;
    if (!past.length) return;
    dirtyRef.current = true;
    dispatch({ type: 'history/undo' });
  }, []);

  /**
   * 用一整套块替换当前内容（版本回滚用）。
   *
   * 服务端已经把回滚后的内容落库了，所以这里不能再标 dirty——
   * 否则防抖保存会拿新内容再写一遍，凭空多出一条自动快照。
   */
  const replaceAllBlocks = useCallback((blocks) => {
    dirtyRef.current = false;
    dispatch({ type: 'blocks/replaceAll', blocks });
  }, []);

  const redo = useCallback(() => {
    const { future } = stateRef.current;
    if (!future.length) return;
    dirtyRef.current = true;
    dispatch({ type: 'history/redo' });
  }, []);

  const loadWork = useCallback(async (workId) => {
    try {
      const res = await api.get(`/works/${workId}`);
      dispatch({
        type: 'work/loaded',
        work: res.data,
        chapters: res.data.chapters || [],
      });
      return res.data;
    } catch (e) {
      dispatch({
        type: 'notice/set',
        error: '作品加载失败：' + (e.response?.data?.error || e.message),
      });
      return null;
    }
  }, []);

  const loadChapter = useCallback(async (chapterId) => {
    try {
      const res = await api.get(`/chapters/${chapterId}`);
      const chapter = res.data;
      dispatch({
        type: 'chapter/loaded',
        chapter,
        blocks: parseBlocks(chapter.blocks),
      });
      dirtyRef.current = false;
      lastEditRef.current = null;
      return chapter;
    } catch (e) {
      dispatch({
        type: 'notice/set',
        error: '章节加载失败：' + (e.response?.data?.error || e.message),
      });
      return null;
    }
  }, []);

  const value = useMemo(
    () => ({
      ...state,
      dispatch,
      setBlocks,
      updateBlock,
      insertBlock,
      removeBlock,
      convertBlock,
      moveBlock,
      undo,
      redo,
      replaceAllBlocks,
      loadWork,
      loadChapter,
    }),
    [
      state,
      setBlocks,
      updateBlock,
      insertBlock,
      removeBlock,
      convertBlock,
      moveBlock,
      undo,
      redo,
      replaceAllBlocks,
      loadWork,
      loadChapter,
    ]
  );

  return (
    <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error('useWorkspace 必须在 WorkspaceProvider 内使用');
  }
  return ctx;
}
