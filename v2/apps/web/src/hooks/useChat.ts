import { useCallback, useRef, useState } from 'react';
import { ApiError, streamChat } from '../api/client';

export interface ChatTurn {
  role: 'user' | 'ai';
  text: string;
  /** 流中断时服务端会带 error：半句要留在界面上，但必须标出「未保存」，否则读者会当成完整回答。 */
  error?: string;
  scope?: { included: number; total: number };
}

export function useChat(key: string | null) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);

  const send = useCallback(
    async (question: string, mode = '') => {
      if (!key || busy || !question.trim()) return;
      const history = turns.map((turn) => ({ role: turn.role, text: turn.text }));
      setTurns((current) => [...current, { role: 'user', text: question }]);
      setBusy(true);

      const abort = new AbortController();
      controller.current = abort;
      let streaming = '';
      let failure: string | undefined;
      let scope: ChatTurn['scope'];

      setTurns((current) => [...current, { role: 'ai', text: '' }]);
      const patch = (patcher: (turn: ChatTurn) => ChatTurn) =>
        setTurns((current) => {
          if (!current.length) return current;
          const next = [...current];
          next[next.length - 1] = patcher(next[next.length - 1] as ChatTurn);
          return next;
        });

      try {
        await streamChat(
          { key, question, mode, history },
          (chunk) => {
            if (chunk.meta) {
              scope = { included: chunk.meta.included, total: chunk.meta.total };
              patch((turn) => ({ ...turn, scope }));
            }
            if (chunk.delta) {
              streaming += chunk.delta;
              patch((turn) => ({ ...turn, text: streaming }));
            }
            if (chunk.done) {
              streaming = chunk.text ?? streaming;
              patch((turn) => ({ ...turn, text: streaming, scope }));
            }
            if (chunk.error) {
              failure = chunk.error;
              streaming = chunk.partial ?? streaming;
              patch((turn) => ({ ...turn, text: streaming, error: chunk.error, scope }));
            }
          },
          abort.signal,
        );
      } catch (error) {
        const message = error instanceof ApiError ? error.message : String(error);
        patch((turn) => ({ ...turn, error: message }));
      } finally {
        setBusy(false);
        controller.current = null;
        if (!streaming && !failure) {
          patch((turn) => ({ ...turn, error: turn.error ?? '（没有收到内容）' }));
        }
      }
    },
    [busy, key, turns],
  );

  const stop = useCallback(() => controller.current?.abort(), []);
  const clear = useCallback(() => setTurns([]), []);

  return { turns, busy, send, stop, clear };
}
