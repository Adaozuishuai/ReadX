import { useCallback, useEffect, useRef, useState } from 'react';
import type { ImportProgress, ImportStreamEvent } from '../api/client';

const stages: Record<string, string> = { preparing: '准备文件', search: '检索论文', download: '下载全文', parse: '解析排版', upload: '上传文件', received: '检查文件', metadata: 'AI 识别信息', translation: '翻译全文', saving: '保存书库', complete: '处理完成', failed: '处理失败', cancelled: '已取消', done: '文件已导入' };
type Activity = ImportProgress & { at: number };

export function useImportProgress() {
  const [current, setCurrent] = useState<Activity | null>(null);
  const [history, setHistory] = useState<Activity[]>([]);
  const [startedAt, setStartedAt] = useState(0);
  const [stageStartedAt, setStageStartedAt] = useState(0);
  const [serverAt, setServerAt] = useState(0);
  const last = useRef<Activity | null>(null);
  const update = useCallback((progress: ImportProgress) => {
    const next = { ...progress, at: Date.now() };
    if (last.current?.stage !== next.stage || last.current?.name !== next.name) setStageStartedAt(next.at);
    // Byte counters update the bar continuously, while the activity list records
    // upload/download stage changes rather than filling with network chunks.
    const changed = last.current?.message !== next.message || last.current?.name !== next.name;
    if (changed) setHistory(items => [...items.slice(-119), next]);
    last.current = next;
    setCurrent(next);
  }, []);
  /**
   * 开始一次新的导入。
   *
   * 刻意**不清空** history：弹弓式上传是一篇一篇投的，每投一篇都会 begin 一次，
   * 若在这里清空，处理记录就永远只剩当前这一条（用户看不到前面几篇的结果）。
   * 记录改为按篇累积；清空由用户显式点「清空记录」或在对话框重开时发生。
   */
  const begin = useCallback((stage: string, message: string) => {
    setStartedAt(Date.now());
    setServerAt(0);
    last.current = null;
    update({ stage, message, completed: 0, total: 0 });
  }, [update]);
  const clearHistory = useCallback(() => setHistory([]), []);
  const receive = useCallback((event: ImportStreamEvent) => {
    if (event.heartbeat || event.progress) setServerAt(Date.now());
    if (event.progress) update(event.progress);
  }, [update]);
  return { current, history, startedAt, stageStartedAt, serverAt, update, begin, clearHistory, receive };
}

function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
function counter(item: Activity) {
  if (item.stage === 'upload' || item.stage === 'download') {
    const size = (bytes: number) => bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
    return item.total > 0 ? `${size(item.completed)} / ${size(item.total)}` : '';
  }
  const unit = item.stage === 'parse' ? '页' : item.stage === 'translation' ? '段' : '';
  return item.total > 0 ? `${item.completed} / ${item.total} ${unit}`.trim() : '';
}

export function ImportProgressPanel({ activity, busy }: { activity: ReturnType<typeof useImportProgress>; busy: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!busy) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);
  const { current, history, startedAt, stageStartedAt, serverAt } = activity;
  if (!current) return null;
  const measured = current.total > 0;
  const percent = measured ? Math.min(100, Math.floor(current.completed / current.total * 100)) : null;
  return (
    <section className="import-progress" aria-label="导入进度" data-stage={current.stage}>
      <div className="flex items-center justify-between gap-3 text-xs">
        <strong>{stages[current.stage] || current.stage}</strong>
        <span className="text-ink-faint">已用时 {duration(now - startedAt)}</span>
      </div>
      {current.name ? <p className="mt-2 break-all text-xs text-ink-soft">文件 {current.file ?? 1}/{current.files ?? 1}：{current.name}</p> : null}
      <p role="status" aria-live="polite" className="my-2 text-[13px] leading-relaxed">{current.message}</p>
      <progress aria-label="当前阶段进度" max={measured ? current.total : 1} value={measured ? current.completed : busy ? undefined : 0} />
      <div className="mt-1 flex justify-between gap-2 text-[11px] text-ink-faint">
        <span>{measured ? `${counter(current)} · ${percent}%` : busy ? '当前阶段暂无可计量的总量' : stages[current.stage]}</span>
        <span>{busy ? `此阶段 ${duration(now - stageStartedAt)}` : ''}</span>
      </div>
      {busy && serverAt > 0 && current.stage !== 'upload' ? <p className="mt-2 text-[11px] text-ink-faint">{now - serverAt < 10000 ? '服务连接正常' : '等待服务下一条消息'} · 上次消息 {duration(now - serverAt)}前</p> : null}
      <details className="mt-3" open>
        <summary className="cursor-pointer text-xs text-ink-soft">
          处理记录{history.length ? `（${history.length} 条）` : ''}
        </summary>
        <ol className="mt-2 max-h-40 overflow-y-auto text-[11px] text-ink-faint" aria-label="导入处理记录">
          {[...history].reverse().map((item, index) => (
            <li key={`${item.at}-${index}`} className="mb-1 leading-relaxed">
              <time>{new Date(item.at).toLocaleTimeString([], { hour12: false })}</time>
              {item.name ? ` · ${item.name}：` : ' · '}
              {item.message}
            </li>
          ))}
          {!history.length ? <li className="leading-relaxed">还没有记录。</li> : null}
        </ol>
        {history.length ? (
          <button type="button" className="mt-2 text-[11px] text-ink-faint hover:text-bad" onClick={activity.clearHistory}>
            清空记录
          </button>
        ) : null}
      </details>
    </section>
  );
}
