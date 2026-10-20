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
 * 当前 AI 角色、会话 id、对话消息流。
 *
 * 块是编辑器的权威数据；每次改动打 dirty 标记，由本文件统一防抖落库，
 * 避免每个块组件各写各的保存逻辑。
 */
const WorkspaceContext = createContext(null);

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
      };
    }

    case 'blocks/set':
      return { ...state, blocks: action.blocks };

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
      try {
        await api.put(`/chapters/${chapter.id}`, { blocks });
        dirtyRef.current = false;
      } catch (e) {
        dispatch({
          type: 'notice/set',
          error: '自动保存失败：' + (e.response?.data?.error || e.message),
        });
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

  const setBlocks = useCallback((blocks) => {
    dirtyRef.current = true;
    dispatch({ type: 'blocks/set', blocks });
  }, []);

  const updateBlock = useCallback((id, patch) => {
    dirtyRef.current = true;
    dispatch({ type: 'blocks/replace', id, patch });
  }, []);

  const insertBlock = useCallback((index, block) => {
    dirtyRef.current = true;
    dispatch({ type: 'blocks/insert', index, block });
  }, []);

  const removeBlock = useCallback((id) => {
    dirtyRef.current = true;
    dispatch({ type: 'blocks/remove', id });
  }, []);

  const convertBlock = useCallback((id, type) => {
    const target = stateRef.current.blocks.find((b) => b.id === id);
    if (!target) return;
    dirtyRef.current = true;
    dispatch({ type: 'blocks/convert', id, block: convertBlockData(target, type) });
  }, []);

  const moveBlock = useCallback((id, offset) => {
    dirtyRef.current = true;
    dispatch({ type: 'blocks/move', id, offset });
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
