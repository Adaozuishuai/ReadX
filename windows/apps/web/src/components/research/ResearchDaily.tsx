import { useState, type Dispatch, type SetStateAction } from 'react';
import type { DocumentSummary } from '@cbct/shared';
import { dayDistance, localDay, logFocusLabel, newId, priorityLabels, selectTodos, totalFocusMinutes, weekActivity, type Todo, type TodoFilter, type WorkbenchData } from '../../lib/researchWorkbench';
import { AppDialog } from '../AppDialog';
import { WorkspaceIcon } from '../WorkspaceIcon';
import { ResearchFocus } from './ResearchFocus';

function DueLabel({ due, day }: { due: string; day: string }) {
  if (!due) return <span className="rw-due">未设截止日期</span>;
  const days = dayDistance(day, due);
  return <span className={`rw-due${days < 0 ? ' overdue' : days === 0 ? ' today' : ''}`}><WorkspaceIcon name="calendar" size={12} />{days < 0 ? `逾期 ${-days} 天` : days === 0 ? '今天截止' : days === 1 ? '明天截止' : `${due.slice(5).replace('-', '/')} 截止`}</span>;
}

export function ResearchDaily({ data, setData, now, documents, onOpenDocument, onOpenLibrary }: {
  data: WorkbenchData; setData: Dispatch<SetStateAction<WorkbenchData>>; now: number;
  documents: DocumentSummary[]; onOpenDocument: (id: string) => void; onOpenLibrary: () => void;
}) {
  const day = localDay(new Date(now));
  const [filter, setFilter] = useState<TodoFilter>('active');
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<Todo['priority']>('medium');
  const [due, setDue] = useState('');
  const [editing, setEditing] = useState<Todo | null>(null);
  const [logDraft, setLogDraft] = useState('');
  const [logDay, setLogDay] = useState(day);
  const [allLogs, setAllLogs] = useState(false);
  const [selectedTodo, setSelectedTodo] = useState(data.focusSession?.todoId ?? '');
  const active = selectTodos(data.todos, 'active', day);
  const visible = selectTodos(data.todos, filter, day);
  const todayTasks = selectTodos(data.todos, 'today', day);
  const overdue = active.filter(todo => todo.due && todo.due < day).length;
  const activity = weekActivity(data.logs, day);
  const weekMinutes = activity.reduce((sum, item) => sum + item.minutes, 0);
  const todayLogs = data.logs.filter(log => log.day === day);
  const session = data.focusSession;
  const recent = [...documents].sort((a, b) => Number(b.status === 'reading') - Number(a.status === 'reading') || b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3);
  const logs = [...data.logs].sort((a, b) => b.day.localeCompare(a.day));

  const addTodo = () => {
    if (!title.trim()) return;
    const todo: Todo = { id: newId(), title: title.trim(), priority, due, done: false, createdAt: new Date().toISOString() };
    setData(current => ({ ...current, todos: [todo, ...current.todos] }));
    setTitle(''); setDue(''); setFilter('active');
  };
  const toggleTodo = (id: string) => setData(current => ({ ...current, todos: current.todos.map(todo => todo.id === id ? { ...todo, done: !todo.done, completedAt: todo.done ? undefined : new Date().toISOString() } : todo) }));

  return <>
    <div className="rw-metrics">
      <div><span><WorkspaceIcon name="list" size={16} />进行中的任务</span><strong>{active.length}<small>项</small></strong><p>{data.todos.filter(todo => todo.done).length} 项已完成</p></div>
      <div className={overdue ? 'rw-metric-alert' : ''}><span><WorkspaceIcon name="calendar" size={16} />今天与逾期</span><strong>{todayTasks.length}<small>项</small></strong><p>{overdue ? `${overdue} 项已过截止日期` : '今天没有逾期任务'}</p></div>
      <div><span><WorkspaceIcon name="clock" size={16} />近 7 天专注</span><strong>{weekMinutes}<small>分钟</small></strong><p>今天 {totalFocusMinutes(todayLogs)} 分钟</p></div>
      <div><span><WorkspaceIcon name="file" size={16} />今日研究记录</span><strong>{todayLogs.length}<small>条</small></strong><p>手动日志与专注记录</p></div>
    </div>
    <div className="rw-daily-grid">
      <div className="rw-main-column">
        <section className="rw-card rw-task-card">
          <div className="rw-section-heading"><div><span className="rw-kicker">RESEARCH PLAN</span><h2>研究任务</h2></div><span className="rw-badge">{active.length} 项待办</span></div>
          <form className="rw-task-composer" onSubmit={event => { event.preventDefault(); addTodo(); }}>
            <div><WorkspaceIcon name="plus" size={18} /><input id="rw-task-input" aria-label="新任务内容" placeholder="下一步，想推进什么研究？" value={title} onChange={event => setTitle(event.target.value)} /><button className="rw-button rw-primary" disabled={!title.trim()}>添加</button></div>
            <div className="rw-composer-options"><label><span className={`rw-priority-dot ${priority}`} /><select aria-label="新任务优先级" value={priority} onChange={event => setPriority(event.target.value as Todo['priority'])}>{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><WorkspaceIcon name="calendar" size={14} /><input type="date" aria-label="新任务截止日期" value={due} onChange={event => setDue(event.target.value)} /></label><span>Enter 快速添加</span></div>
          </form>
          <div className="rw-segmented" aria-label="任务筛选">{([['active', '全部待办'], ['today', '今天与逾期'], ['week', '未来 7 天'], ['done', '已完成']] as const).map(([id, label]) => <button key={id} aria-pressed={filter === id} className={filter === id ? 'selected' : ''} onClick={() => setFilter(id)}>{label}<small>{selectTodos(data.todos, id, day).length}</small></button>)}</div>
          <div className="rw-task-list">{visible.map(todo => <article key={todo.id} className={`rw-task-row${todo.done ? ' is-done' : ''}`}>
            <button className="rw-check" aria-label={todo.done ? `恢复任务：${todo.title}` : `完成任务：${todo.title}`} aria-pressed={todo.done} onClick={() => toggleTodo(todo.id)}>{todo.done && <WorkspaceIcon name="check" size={13} />}</button>
            <div className="rw-task-body"><button className="rw-task-title" onClick={() => setEditing({ ...todo })}>{todo.title}</button><div><DueLabel due={todo.due} day={day} />{todo.notes && <span className="rw-task-has-note">有备注</span>}</div></div>
            <span className={`rw-priority ${todo.priority}`}><i />{todo.priority === 'high' ? '高' : todo.priority === 'medium' ? '中' : '低'}</span>
            {!todo.done && <button className="rw-icon-button rw-task-focus" title="选择此任务进行专注" aria-label={`专注任务：${todo.title}`} disabled={Boolean(session)} onClick={() => { setSelectedTodo(todo.id); document.getElementById('rw-focus-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }}><WorkspaceIcon name="play" size={15} /></button>}
          </article>)}</div>
          {!visible.length && <div className="rw-empty"><span><WorkspaceIcon name={filter === 'done' ? 'check' : 'list'} size={26} /></span><h3>{filter === 'done' ? '已完成的研究任务' : filter === 'active' ? '从一个小而明确的任务开始' : '这个时间范围内没有待办'}</h3><p>{filter === 'active' ? '例如：读完一篇论文，或整理今天的实验结果。' : '使用上方筛选查看其他任务。'}</p></div>}
        </section>
        <section className="rw-card rw-journal">
          <div className="rw-section-heading"><div><span className="rw-kicker">RESEARCH JOURNAL</span><h2>研究日志</h2></div><WorkspaceIcon name="edit" size={19} /></div>
          <form className="rw-journal-composer" onSubmit={event => { event.preventDefault(); if (!logDraft.trim()) return; const entry = { id: newId(), day: logDay, text: logDraft.trim(), minutes: 0 }; setData(current => ({ ...current, logs: [entry, ...current.logs] })); setLogDraft(''); }}>
            <textarea aria-label="研究日志内容" placeholder="今天验证了什么？发现了什么问题？下一步准备怎么做？" rows={3} value={logDraft} onChange={event => setLogDraft(event.target.value)} />
            <div><label><WorkspaceIcon name="calendar" size={14} /><input aria-label="日志日期" type="date" required value={logDay} onChange={event => setLogDay(event.target.value)} /></label><button className="rw-button rw-primary" disabled={!logDraft.trim() || !logDay}>记录进展<WorkspaceIcon name="arrow" size={15} /></button></div>
          </form>
          <div className="rw-journal-list">{logs.slice(0, allLogs ? undefined : 5).map(log => <article key={log.id}>
            <span className={`rw-journal-marker${log.seconds != null || log.minutes > 0 ? ' is-focus' : ''}`}><WorkspaceIcon name={log.seconds != null || log.minutes > 0 ? 'clock' : 'file'} size={14} /></span>
            <div><div className="rw-journal-meta"><time>{log.day === day ? '今天' : log.day}</time>{(log.seconds != null || log.minutes > 0) && <span>专注 {logFocusLabel(log)}</span>}</div><p>{log.text}</p></div>
            <button className="rw-icon-button" aria-label={`删除日志：${log.text}`} onClick={() => setData(current => ({ ...current, logs: current.logs.filter(item => item.id !== log.id) }))}><WorkspaceIcon name="trash" size={14} /></button>
          </article>)}</div>
          {!logs.length && <p className="rw-quiet-note">你的第一条研究记录，将从这里开始。完成专注后也会自动生成记录。</p>}
          {logs.length > 5 && <button className="rw-text-button" onClick={() => setAllLogs(value => !value)}>{allLogs ? '收起记录' : `查看全部 ${logs.length} 条记录`}<WorkspaceIcon name="chevron" size={14} /></button>}
        </section>
      </div>
      <div className="rw-aside-column">
        <ResearchFocus data={data} setData={setData} now={now} selectedTodo={selectedTodo} onSelectTodo={setSelectedTodo} />
        <section className="rw-card rw-activity-card"><div className="rw-section-heading"><h2>最近的专注</h2><span className="rw-subtle">{weekMinutes} 分钟 / 7 天</span></div><div className="rw-activity-chart">{activity.map(item => <div key={item.day} title={`${item.day} · 专注 ${item.minutes} 分钟`}><span>{item.minutes || ''}</span><div><i className={item.minutes ? 'has-activity' : ''} style={{ height: `${Math.max(4, item.minutes / Math.max(30, ...activity.map(entry => entry.minutes)) * 100)}%` }} /></div><small className={item.day === day ? 'is-today' : ''}>{item.day === day ? '今' : item.label}</small></div>)}</div></section>
        <section className="rw-card rw-reading-card"><div className="rw-section-heading"><h2>继续阅读</h2><button className="rw-text-button" onClick={onOpenLibrary}>书库<WorkspaceIcon name="arrow" size={14} /></button></div>{recent.map((doc, index) => <button className="rw-reading-item" key={doc.id} onClick={() => onOpenDocument(doc.id)}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{doc.translatedTitle || doc.title}</strong><small>{[doc.authors[0], doc.year].filter(Boolean).join(' · ') || (doc.format?.toUpperCase() ?? 'PDF')}</small></div><WorkspaceIcon name="chevronRight" size={16} /></button>)}{!recent.length && <div className="rw-reading-empty"><WorkspaceIcon name="library" size={25} /><p>从书库导入第一篇文献，研究从阅读开始。</p><button className="rw-text-button" onClick={onOpenLibrary}>前往个人书库<WorkspaceIcon name="arrow" size={14} /></button></div>}</section>
      </div>
    </div>
    {editing && <AppDialog open onClose={() => setEditing(null)} className="rw-dialog" aria-labelledby="rw-edit-task-title"><form onSubmit={event => { event.preventDefault(); if (!editing.title.trim()) return; setData(current => ({ ...current, todos: current.todos.map(todo => todo.id === editing.id ? { ...editing, title: editing.title.trim() } : todo) })); setEditing(null); }}>
      <header><div><span className="rw-kicker">TASK DETAILS</span><h2 id="rw-edit-task-title">编辑研究任务</h2></div><button type="button" className="rw-icon-button" aria-label="关闭任务编辑" onClick={() => setEditing(null)}><WorkspaceIcon name="close" /></button></header>
      <label>任务内容<input autoFocus required value={editing.title} onChange={event => setEditing({ ...editing, title: event.target.value })} /></label><div className="rw-form-columns"><label>优先级<select value={editing.priority} onChange={event => setEditing({ ...editing, priority: event.target.value as Todo['priority'] })}>{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>截止日期<input type="date" value={editing.due} onChange={event => setEditing({ ...editing, due: event.target.value })} /></label></div><label>研究备注<textarea rows={4} placeholder="记录完成标准、实验思路或相关线索" value={editing.notes ?? ''} onChange={event => setEditing({ ...editing, notes: event.target.value })} /></label>
      <footer><button type="button" className="rw-button rw-danger" onClick={() => { setData(current => ({ ...current, todos: current.todos.filter(todo => todo.id !== editing.id) })); setEditing(null); }}>删除任务</button><button type="button" className="rw-button" onClick={() => setEditing(null)}>取消</button><button className="rw-button rw-primary">保存修改</button></footer>
    </form></AppDialog>}
  </>;
}
