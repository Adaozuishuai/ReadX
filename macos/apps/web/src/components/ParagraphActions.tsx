import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

export interface SelectedParagraph {
  text: string;
  position: number;
  index: number;
  top: number;
  left: number;
  kind: 'pdf' | 'epub';
  translatedText?: string;
}
export interface ParagraphQuestion {
  text: string;
  position: number;
  kind: 'pdf' | 'epub';
  nonce: number;
}

export function ParagraphActions({ documentKey, paragraph, onAsk, onClose }: {
  documentKey: string;
  paragraph: SelectedParagraph;
  onAsk: () => void;
  onClose: () => void;
}) {
  const [target, setTarget] = useState(paragraph.translatedText ?? '');
  useEffect(() => { setTarget(paragraph.translatedText ?? ''); }, [paragraph]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const translate = async () => {
    if (busy) return;
    controller.current = new AbortController();
    setBusy(true);
    setError('');
    try {
      const result = await api.translate(documentKey, [paragraph.text], controller.current.signal);
      setTarget(result.items[0]?.target ?? '');
    } catch (cause) {
      if (!controller.current.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return <section role="dialog" aria-label="段落操作" className="paragraph-actions"
    style={{ top: Math.max(8, Math.min(paragraph.top + 8, window.innerHeight - 480)), left: Math.max(8, Math.min(paragraph.left, window.innerWidth - 488)) }}>
    <header><strong>{paragraph.kind === 'pdf' ? 'Page' : 'Chapter'} {paragraph.position} · 第 {paragraph.index + 1} 段</strong>
      <button aria-label="关闭段落操作" onClick={onClose}>×</button></header>
    <p className="paragraph-source">{paragraph.text}</p>
    <div className="paragraph-buttons">
      <button disabled={busy || Boolean(target)} onClick={() => void translate()}>{busy ? '翻译中…' : target ? '译文已就绪' : '翻译此段'}</button>
      <button onClick={onAsk}>就此段提问</button>
      {busy && <button onClick={() => { controller.current?.abort(); onClose(); }}>取消</button>}
    </div>
    {target && <div className="paragraph-target" aria-label="段落译文" lang="zh-CN">{target}</div>}
    {error && <p role="alert" className="text-bad">{error}</p>}
  </section>;
}
