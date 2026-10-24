import { useEffect, useRef, useState } from 'react';
import { STORAGE_KEYS, writeJSON } from '../../lib/storage';

const EDGE_GAP = 8;
const WIDGET_WIDTH = 340;

interface CountdownConfig {
  /** 下班时间，HH:mm。 */
  offWork: string;
  /** 沿窗口顶部的悬挂位置；null 用默认（挂件在右，这块牌在左）。 */
  x: number | null;
}

function loadConfig(): CountdownConfig {
  let parsed: Partial<CountdownConfig> | null = null;
  try {
    parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.slackCountdown) ?? 'null') as Partial<CountdownConfig> | null;
  } catch {
    parsed = null;
  }
  // 功能未发布前默认值改过一次（18:00 → 17:00）：存着旧默认值的当没设置过。
  const offWork = typeof parsed?.offWork === 'string' && /^\d{2}:\d{2}$/.test(parsed.offWork) && parsed.offWork !== '18:00'
    ? parsed.offWork
    : '17:00';
  return { offWork, x: Number.isFinite(Number(parsed?.x)) ? Number(parsed?.x) : null };
}

function clampLeft(left: number): number {
  return Math.min(Math.max(left, EDGE_GAP), Math.max(EDGE_GAP, window.innerWidth - WIDGET_WIDTH - EDGE_GAP));
}

function saveConfig(config: CountdownConfig): void {
  writeJSON(STORAGE_KEYS.slackCountdown, config);
}

/** 倒计时精确到秒：满一小时 H:MM:SS，不足一小时 MM:SS。 */
function formatClock(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

function segments(now: Date, offWork: string): { label: string; value: string }[] {
  const [hours, minutes] = offWork.split(':').map(Number);
  const off = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours || 0, minutes || 0);
  const deltaSeconds = Math.floor((now.getTime() - off.getTime()) / 1000);
  const offLabel = deltaSeconds < 0
    ? `距下班 ${formatClock(-deltaSeconds)}`
    : deltaSeconds >= 12 * 60 * 60
      ? '早点休息'
      : `已下班 ${formatClock(deltaSeconds)}`;

  const weekday = now.getDay();
  const weekLabel = weekday === 6
    ? '周末第 1 天'
    : weekday === 0
      ? '周末第 2 天'
      : `距周末 ${6 - weekday} 天`;

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const newYear = today.getMonth() === 0 && today.getDate() === 1
    ? '元旦快乐'
    : `距元旦 ${Math.round((new Date(now.getFullYear() + 1, 0, 1).getTime() - today.getTime()) / 86400000)} 天`;

  return [
    { label: '下班', value: offLabel },
    { label: '周末', value: weekLabel },
    { label: '元旦', value: newYear },
  ];
}

/** 摸鱼界面的下班倒计时小牌：沿窗口顶部拖动，点开可改下班时间或收起。 */
export function CountdownWidget({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<CountdownConfig>(loadConfig);
  const [now, setNow] = useState(() => new Date());
  const [editing, setEditing] = useState(false);
  const [left, setLeft] = useState(() => clampLeft(config.x ?? EDGE_GAP + 16));
  const drag = useRef<{ pointerId: number; startX: number; startLeft: number; moved: boolean } | null>(null);
  const leftRef = useRef(left);
  leftRef.current = left;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    const sync = () => setNow(new Date());
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  const current = segments(now, config.offWork);

  return (
    <aside
      className="slack-countdown"
      style={{ left: `${left}px` }}
      aria-label="下班倒计时"
      onPointerDown={(event) => {
        drag.current = { pointerId: event.pointerId, startX: event.clientX, startLeft: leftRef.current, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        const nextLeft = clampLeft(active.startLeft + event.clientX - active.startX);
        if (Math.abs(nextLeft - active.startLeft) > 3) active.moved = true;
        leftRef.current = nextLeft;
        setLeft(nextLeft);
      }}
      onPointerUp={(event) => {
        const active = drag.current;
        drag.current = null;
        if (!active || active.pointerId !== event.pointerId) return;
        if (active.moved) {
          setConfig((currentConfig) => {
            const next = { ...currentConfig, x: leftRef.current };
            saveConfig(next);
            return next;
          });
          return;
        }
        // 没拖动就是点按：展开设置。
        setEditing((value) => !value);
      }}
    >
      <span className="slack-countdown__string" aria-hidden="true" />
      <div className="slack-countdown__card">
        {current.map((segment) => (
          <span key={segment.label} className="slack-countdown__seg">{segment.value}</span>
        ))}
      </div>
      {editing ? (
        <div className="slack-countdown__panel" role="dialog" aria-label="倒计时设置">
          <label>
            下班时间
            <input
              type="time"
              value={config.offWork}
              onChange={(event) => {
                const next = { ...config, offWork: event.target.value || config.offWork };
                setConfig(next);
                saveConfig(next);
              }}
            />
          </label>
          <button type="button" onClick={onClose}>收起挂件</button>
          <button type="button" className="slack-primary" onClick={() => setEditing(false)}>完成</button>
        </div>
      ) : null}
    </aside>
  );
}
