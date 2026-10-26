import { useState, type Dispatch, type SetStateAction } from 'react';
import { finishFocusSession, focusSeconds, formatFocusClock, isFocusRunning, newId, startFocusSession, toggleFocusSession, type WorkbenchData } from '../../lib/researchWorkbench';
import { WorkspaceIcon } from '../WorkspaceIcon';

export function ResearchFocus({ data, setData, now, selectedTodo, onSelectTodo }: {
  data: WorkbenchData; setData: Dispatch<SetStateAction<WorkbenchData>>; now: number;
  selectedTodo: string; onSelectTodo: (id: string) => void;
}) {
  const session = data.focusSession;
  const [minutes, setMinutes] = useState(session?.minutes || 25);
  const mode = session?.mode ?? (session ? 'countdown' : data.focusMode);
  const active = data.todos.filter(todo => !todo.done);
  const todoId = session?.todoId ?? (active.some(todo => todo.id === selectedTodo) ? selectedTodo : '');
  const running = isFocusRunning(session);
  const seconds = session ? focusSeconds(session, now) : mode === 'countdown' ? minutes * 60 : 0;
  const progress = mode === 'stopwatch' ? seconds % 60 / 60 : session ? Math.min(1, Math.max(0, 1 - seconds / (session.minutes * 60))) : 0;

  const toggle = () => {
    const timestamp = Date.now();
    const id = newId();
    setData(current => current.focusSession ? toggleFocusSession(current, timestamp)
      : { ...current, focusSession: startFocusSession(mode, minutes, todoId, timestamp, id) });
  };

  return <section className="rw-focus-card" id="rw-focus-panel">
    <div className="rw-focus-heading"><span><WorkspaceIcon name="clock" size={17} />专注计时</span><span className="rw-focus-status">{running ? '进行中' : session ? '已暂停' : '待开始'}</span></div>
    <div className="rw-focus-modes" role="group" aria-label="计时方式">{([['countdown', '倒计时'], ['stopwatch', '正计时']] as const).map(([id, label]) => <button key={id} disabled={Boolean(session)} title={session ? '结束当前专注后可切换计时方式' : label} aria-pressed={mode === id} onClick={() => setData(current => ({ ...current, focusMode: id }))}>{label}</button>)}</div>
    <div className="rw-focus-dial"><svg viewBox="0 0 200 200" aria-hidden="true"><circle className="rw-dial-track" cx="100" cy="100" r="88" /><circle className="rw-dial-progress" cx="100" cy="100" r="88" strokeDasharray={Math.PI * 176} strokeDashoffset={Math.PI * 176 * (1 - progress)} /></svg><div><strong role="timer" aria-label={mode === 'stopwatch' ? '已专注时间' : '专注剩余时间'}>{formatFocusClock(seconds)}</strong><span>{session && !running ? '专注已暂停' : mode === 'stopwatch' ? '累计专注时间' : '剩余专注时间'}</span></div></div>
    <select className="rw-focus-select" aria-label="关联专注任务" disabled={Boolean(session)} value={todoId} onChange={event => onSelectTodo(event.target.value)}><option value="">自由专注</option>{active.map(todo => <option key={todo.id} value={todo.id}>{todo.title}</option>)}{session?.todoId && !active.some(todo => todo.id === session.todoId) && <option value={session.todoId}>{data.todos.find(todo => todo.id === session.todoId)?.title ?? '原关联任务'}</option>}</select>
    {mode === 'countdown' ? <div className="rw-focus-presets" aria-label="专注时长">{[15, 25, 45, 60].map(value => <button key={value} disabled={Boolean(session)} aria-pressed={(session?.minutes ?? minutes) === value} onClick={() => setMinutes(value)}>{value} 分钟</button>)}</div> : <p className="rw-stopwatch-description">从 00:00 开始，按自己的节奏专注。</p>}
    <div className="rw-focus-actions"><button onClick={toggle}><WorkspaceIcon name={running ? 'pause' : 'play'} size={17} />{running ? '暂停' : session ? '继续' : '开始专注'}</button>{session && <><button className="rw-focus-end" onClick={() => setData(current => finishFocusSession(current, Date.now(), true))}><WorkspaceIcon name="check" size={16} />结束并记录</button><button className="rw-focus-reset" title="重置当前专注，不记录本次" aria-label="重置当前专注" onClick={() => setData(current => ({ ...current, focusSession: null }))}><WorkspaceIcon name="reset" size={17} /></button></>}</div>
  </section>;
}
