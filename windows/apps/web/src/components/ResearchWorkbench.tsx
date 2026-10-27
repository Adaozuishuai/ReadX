import { useEffect, useRef, useState } from 'react';
import type { DocumentSummary, LauncherOpenRequest } from '@cbct/shared';
import { focusSeconds, formatFocusClock, isFocusRunning, localDay, totalFocusMinutes, type WorkbenchTab } from '../lib/researchWorkbench';
import { useFocusClock, type ResearchWorkbenchController } from '../hooks/useResearchWorkbench';
import { WorkspaceIcon } from './WorkspaceIcon';
import { ResearchDaily } from './research/ResearchDaily';
import { ResearchAcademics } from './research/ResearchAcademics';
import { ResearchNews } from './research/ResearchNews';
import './research-workbench.css';

const pages = {
  daily: { title: '科研日常', description: '安排研究任务，留出专注时间，记录每一步进展。', icon: 'list' },
  academics: { title: '学业看板', description: '从入学到毕业，让培养进度和研究成果清晰可见。', icon: 'graduation' },
  news: { title: '资讯追踪', description: '浏览领域更新，把值得继续阅读的内容留下来。', icon: 'rss' },
} as const;

export function ResearchWorkbench({ documents, onOpenDocument, onReload, onOpenLibrary, controller, launchRequest }: {
  documents: DocumentSummary[]; onOpenDocument: (id: string) => void; onReload: () => void; onOpenLibrary: () => void;
  controller: ResearchWorkbenchController;
  launchRequest?: LauncherOpenRequest | null;
}) {
  const { data, setData } = controller;
  const now = useFocusClock(data.focusSession);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const pageRef = useRef<HTMLElement>(null);
  const tab = data.activeTab;
  const session = data.focusSession;
  const day = localDay(new Date(now));
  const todayMinutes = totalFocusMinutes(data.logs.filter(log => log.day === day));
  const activeCount = data.todos.filter(todo => !todo.done).length;
  const page = pages[tab];

  useEffect(() => { pageRef.current?.scrollTo({ top: 0 }); }, [tab]);

  const selectTab = (activeTab: WorkbenchTab) => setData(current => ({ ...current, activeTab }));
  const clock = session ? formatFocusClock(focusSeconds(session, now)) : '';

  return <div className="rw-layout">
    <aside className="rw-sidebar" aria-label="ReadX 工作区导航">
      <div className="rw-sidebar-brand"><span className="rw-brand-mark"><WorkspaceIcon name="grid" size={21} /></span><div><strong>工作台</strong><span>ReadX Workspace</span></div></div>
      <div className="rw-sidebar-primary">
        <button className="rw-side-link" onClick={onOpenLibrary}><WorkspaceIcon name="library" /><span>个人书库</span><WorkspaceIcon name="chevronRight" size={14} /></button>
        <button className="rw-side-link active" aria-current="page"><WorkspaceIcon name="graduation" /><span>学术工作台</span></button>
      </div>
      <div className="rw-sidebar-caption">研究空间</div>
      <nav className="rw-sidebar-subnav" aria-label="学术工作台页面">
        {(Object.keys(pages) as WorkbenchTab[]).map(id => <button key={id} aria-current={tab === id ? 'page' : undefined} className={tab === id ? 'active' : ''} onClick={() => selectTab(id)}>
          <WorkspaceIcon name={pages[id].icon} size={18} /><span>{pages[id].title}</span>
          {id === 'daily' && activeCount > 0 && <small>{activeCount}</small>}
          {id === 'news' && data.savedArticles.length > 0 && <small>{data.savedArticles.length}</small>}
        </button>)}
      </nav>
      <div className="rw-sidebar-bottom">
        <button className={`rw-sidebar-focus${session ? ' is-active' : ''}`} onClick={() => selectTab('daily')}>
          <WorkspaceIcon name="clock" size={20} /><span><small>{session ? isFocusRunning(session) ? '专注进行中' : '专注已暂停' : '今日专注'}</small><strong>{session ? clock : `${todayMinutes} 分钟`}</strong></span>
          <WorkspaceIcon name="chevronRight" size={15} />
        </button>
      </div>
    </aside>
    <main className="rw-page" ref={pageRef}>
      <div className="rw-content">
        <div className="rw-topline"><span>工作台 <b>/</b> 学术工作台</span><time>{new Date(now).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</time></div>
        <header className="rw-page-heading">
          <div><h1>{page.title}<span className="rw-heading-dot">.</span></h1><p>{page.description}</p></div>
          {tab === 'daily' && <button className="rw-button rw-primary" onClick={() => { const input = document.getElementById('rw-task-input'); input?.scrollIntoView({ behavior: 'smooth', block: 'center' }); input?.focus({ preventScroll: true }); }}><WorkspaceIcon name="plus" size={16} />添加任务</button>}
          {tab === 'academics' && <button className="rw-button" onClick={() => setSettingsOpen(true)}><WorkspaceIcon name="settings" size={16} />培养设置</button>}
        </header>
        {tab === 'daily' ? <ResearchDaily data={data} setData={setData} now={now} documents={documents} onOpenDocument={onOpenDocument} onOpenLibrary={onOpenLibrary} launchRequest={launchRequest} />
          : tab === 'academics' ? <ResearchAcademics data={data} setData={setData} now={now} settingsOpen={settingsOpen} onCloseSettings={() => setSettingsOpen(false)} />
          : <ResearchNews data={data} setData={setData} documents={documents} onReload={onReload} />}
      </div>
    </main>
  </div>;
}
