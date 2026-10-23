import { useCallback, useEffect, useRef, useState } from 'react';
import { api, streamChat, type ChatChunk } from '../api/client';

type ChatTransport = (
  request: { key: string; mode?: string; question: string; scope?: string; history?: Array<{ role: string; text: string }>; images?: string[] },
  onChunk: (chunk: ChatChunk) => void,
  signal?: AbortSignal,
) => Promise<void>;

export interface ChatTurn {
  id: string;
  role: 'user' | 'ai';
  text: string;
  error?: string;
  completed?: boolean;
  scope?: { included: number; total: number; unit?: string };
  provider?: string;
  model?: string;
  reasoningEffort?: string;
}
interface Conversation { id: string; title: string; updatedAt: string; turns: ChatTurn[] }
const fresh = (): Conversation => ({ id: crypto.randomUUID(), title: '新对话', updatedAt: new Date().toISOString(), turns: [] });
const storageKey = (key: string) => `cbct.chat.v2:${key}`;
function load(key: string | null): { conversations: Conversation[]; active: string } {
  try {
    const parsed = key ? JSON.parse(localStorage.getItem(storageKey(key)) ?? 'null') : null;
    if (parsed && Array.isArray(parsed.conversations)) {
      const conversations = parsed.conversations.filter((c: Conversation) => c && typeof c.id === 'string' && typeof c.title === 'string' && Array.isArray(c.turns) && c.turns.every((t) => t && typeof t.id === 'string' && ['user', 'ai'].includes(t.role) && typeof t.text === 'string')) as Conversation[];
      if (conversations.length) return { conversations, active: conversations.some((c) => c.id === parsed.active) ? parsed.active : conversations[0]!.id };
    }
  } catch { /* A damaged local record must not prevent reading a paper. */ }
  const conversation = fresh();
  return { conversations: [conversation], active: conversation.id };
}

export function useChat(key: string | null, transport: ChatTransport = streamChat, trackDocumentStatus = true) {
  const [data, setData] = useState(() => load(key));
  const [dataKey, setDataKey] = useState(key);
  const dataRef = useRef(data);
  const [busy, setBusy] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [deleted, setDeleted] = useState<Conversation | null>(null);
  const controller = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const documentRef = useRef(key);
  const commit = useCallback((next: typeof data) => { dataRef.current = next; setData(next); }, []);
  useEffect(() => {
    documentRef.current = key;
    ++epoch.current;
    controller.current?.abort(); controller.current = null;
    commit(load(key)); setDataKey(key); setBusy(false); setStorageError(''); setDeleted(null);
    return () => { ++epoch.current; controller.current?.abort(); controller.current = null; };
  }, [key, commit]);
  const hasConversationHistory = data.conversations.some((conversation) =>
    conversation.turns.some((turn) => turn.role === 'user' && !!turn.text.trim()),
  );
  useEffect(() => {
    if (!trackDocumentStatus || !key || dataKey !== key) return;
    void api.setStatus(key, hasConversationHistory ? 'reading' : 'queue').catch(() => {});
  }, [key, dataKey, hasConversationHistory, trackDocumentStatus]);
  useEffect(() => {
    if (!key || documentRef.current !== key || busy) return;
    try { localStorage.setItem(storageKey(key), JSON.stringify(data)); setStorageError(''); }
    catch { setStorageError('本机历史保存失败；请及时复制需要保留的回答。'); }
  }, [data, busy, key]);

  const send = useCallback(async (question: string, mode = '', regenerate = false, images: string[] = []) => {
    if (!key || controller.current || !question.trim()) return;
    const snapshot = dataRef.current;
    const conversation = snapshot.conversations.find((c) => c.id === snapshot.active)!;
    let previous = conversation.turns;
    if (regenerate) {
      const lastUser = previous.map((t) => t.role).lastIndexOf('user');
      if (lastUser < 0) return;
      question = previous[lastUser]!.text;
      previous = previous.slice(0, lastUser);
    }
    const history = previous.flatMap((turn, i) => turn.role === 'user' && previous[i + 1]?.role === 'ai' && previous[i + 1]?.completed && !previous[i + 1]?.error
      ? [{ role: 'user', text: turn.text }, { role: 'ai', text: previous[i + 1]!.text }] : []);
    const requestEpoch = epoch.current;
    const requestID = crypto.randomUUID();
    const abort = new AbortController();
    controller.current = abort; setBusy(true);
    const update = (turns: ChatTurn[]) => {
      if (epoch.current !== requestEpoch) return;
      const current = dataRef.current;
      commit({ ...current, conversations: current.conversations.map((c) => c.id === conversation.id ? { ...c, turns, title: c.turns.length > 0 ? c.title : question.replace(/\s+/g, ' ').slice(0, 48), updatedAt: new Date().toISOString() } : c) });
    };
    let turns: ChatTurn[] = [...previous, { id: crypto.randomUUID(), role: 'user', text: question }, { id: requestID, role: 'ai', text: '' }];
    const patch = (changes: Partial<ChatTurn>) => { turns = turns.map((t) => t.id === requestID ? { ...t, ...changes } : t); update(turns); };
    update(turns);
    let streaming = '';
    let finished = false;
    try {
      await transport({ key, question, mode, history, images: images.length ? images : undefined }, (chunk) => {
        if (epoch.current !== requestEpoch) return;
        if (chunk.meta) patch({ scope: { included: chunk.meta.included, total: chunk.meta.total, unit: chunk.meta.unit }, provider: chunk.meta.provider, model: chunk.meta.model, reasoningEffort: chunk.meta.reasoningEffort });
        if (chunk.delta) { streaming += chunk.delta; patch({ text: streaming }); }
        if (chunk.done) { finished = true; streaming = chunk.text ?? streaming; patch({ text: streaming, completed: !!streaming }); }
        if (chunk.error) { finished = true; patch({ text: chunk.partial ?? streaming, error: chunk.error, completed: false }); }
      }, abort.signal);
      if (!finished || !streaming) patch({ error: '连接结束，未收到完整回答。可重新回答。', completed: false });
    } catch (cause) {
      patch({ error: abort.signal.aborted ? '已停止；这条回答不进入后续上下文。' : cause instanceof Error ? cause.message : String(cause), completed: false });
    } finally {
      if (epoch.current === requestEpoch) { controller.current = null; setBusy(false); }
    }
  }, [key, commit, transport]);
  const stop = useCallback(() => controller.current?.abort(), []);
  const newConversation = () => {
    if (controller.current) return;
    const current = dataRef.current;
    const existing = current.conversations.find((c) => !c.turns.length);
    const next = existing ?? fresh();
    commit({ active: next.id, conversations: existing ? current.conversations : [next, ...current.conversations] });
  };
  const selectConversation = (id: string) => {
    if (!controller.current && dataRef.current.conversations.some((c) => c.id === id)) commit({ ...dataRef.current, active: id });
  };
  const deleteConversation = (id: string) => {
    if (controller.current) return;
    setDeleted(dataRef.current.conversations.find((c) => c.id === id) ?? null);
    let conversations = dataRef.current.conversations.filter((c) => c.id !== id);
    if (!conversations.length) conversations = [fresh()];
    commit({ conversations, active: dataRef.current.active === id ? conversations[0]!.id : dataRef.current.active });
  };
  const undoDelete = () => {
    if (!deleted || controller.current) return;
    const current = dataRef.current;
    commit({ conversations: [deleted, ...current.conversations.filter((c) => c.id !== deleted.id)], active: deleted.id }); setDeleted(null);
  };
  return { turns: data.conversations.find((c) => c.id === data.active)?.turns ?? [], conversations: data.conversations, active: data.active, busy, send, stop, newConversation, selectConversation, deleteConversation, undoDelete, canUndo: !!deleted, storageError };
}
