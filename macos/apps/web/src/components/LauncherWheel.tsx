import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { LauncherCatalog, LauncherEvent, LauncherTarget, LauncherWorkspace } from '@cbct/shared';
import { innerWorkspaceAt, PROJECT_INNER_RADIUS, PROJECT_OUTER_RADIUS, PROJECTS_PER_PAGE, projectPlacement, projectSector, projectSlotAt, WHEEL_SIZE, WHEEL_WORKSPACES, wheelPoint, wheelSector } from '../lib/launcherGeometry';
import { WorkspaceIcon } from './WorkspaceIcon';
import './launcher-wheel.css';

export function LauncherWheel() {
  const [catalog, setCatalog] = useState<LauncherCatalog>({ current: 'library', groups: [] });
  const [active, setActive] = useState<LauncherWorkspace>('library');
  const [page, setPage] = useState(0);
  const [hover, setHover] = useState<LauncherTarget | null>(null);
  const [shown, setShown] = useState(false);
  const [size, setSize] = useState(Math.min(window.innerWidth, window.innerHeight));
  const state = useRef({ catalog, active, page, shown });
  state.current = { catalog, active, page, shown };
  const pointer = useRef({ x: 360, y: 360 });
  const wheelAt = (rawX: number, rawY: number): LauncherTarget | null => {
    const scale = Math.min(window.innerWidth, window.innerHeight) / WHEEL_SIZE;
    const x = rawX / scale, y = rawY / scale;
    const inner = innerWorkspaceAt(x, y);
    if (inner) {
      if (inner !== state.current.active) {
        state.current.active = inner;
        state.current.page = 0;
        setActive(inner); setPage(0);
      }
      return { workspace: inner };
    }
    const { catalog: current, active: workspace, page: currentPage } = state.current;
    const projects = current.groups.find(group => group.workspace === workspace)?.projects ?? [];
    const pages = Math.max(1, Math.ceil(projects.length / PROJECTS_PER_PAGE));
    const start = Math.min(currentPage, pages - 1) * PROJECTS_PER_PAGE;
    const slot = projectSlotAt(x, y, projects.slice(start, start + PROJECTS_PER_PAGE).length);
    const project = slot === null ? null : projects[start + slot];
    return project ? { workspace, id: project.id } : null;
  };
  const hitRef = useRef(wheelAt);
  hitRef.current = wheelAt;
  useEffect(() => {
    document.title = 'ReadX · 快速轮盘';
    document.documentElement.classList.add('readx-launcher-window');
    const bridge = window.__READX_LAUNCHER__;
    const resize = () => setSize(Math.min(window.innerWidth, window.innerHeight));
    window.addEventListener('resize', resize);
    const off = bridge?.onEvent((event: LauncherEvent) => {
      if (event.type === 'show') {
        state.current = { catalog: event.catalog, active: event.catalog.current, page: 0, shown: true };
        pointer.current = { x: event.x, y: event.y };
        setCatalog(event.catalog); setActive(event.catalog.current); setPage(0); setHover(null); setShown(true);
        resize();
      } else if (event.type === 'catalog') {
        state.current.catalog = event.catalog;
        setCatalog(event.catalog);
        setHover(hitRef.current(pointer.current.x, pointer.current.y));
      } else if (event.type === 'pointer') {
        pointer.current = { x: event.x, y: event.y };
        setHover(hitRef.current(event.x, event.y));
      } else if (event.type === 'release') {
        const target = hitRef.current(event.x, event.y);
        if (target) bridge?.activate(target); else bridge?.dismiss();
      } else if (event.type === 'hide') {
        state.current.shown = false; setShown(false); setHover(null);
      } else if (event.type === 'wheel') {
        const projects = state.current.catalog.groups.find(group => group.workspace === state.current.active)?.projects ?? [];
        const count = Math.max(1, Math.ceil(projects.length / PROJECTS_PER_PAGE));
        const next = (state.current.page + (event.delta > 0 ? 1 : -1) + count) % count;
        state.current.page = next; setPage(next);
        setHover(hitRef.current(pointer.current.x, pointer.current.y));
      }
    });
    bridge?.ready();
    return () => { off?.(); window.removeEventListener('resize', resize); document.documentElement.classList.remove('readx-launcher-window'); };
  }, []);
  const workspace = WHEEL_WORKSPACES.find(item => item.id === active)!;
  const group = catalog.groups.find(item => item.workspace === active);
  const projects = group?.projects ?? [];
  const pages = Math.max(1, Math.ceil(projects.length / PROJECTS_PER_PAGE));
  const currentPage = Math.min(page, pages - 1);
  const visible = projects.slice(currentPage * PROJECTS_PER_PAGE, (currentPage + 1) * PROJECTS_PER_PAGE);
  const changePage = (delta: number) => {
    const next = (currentPage + delta + pages) % pages;
    state.current.page = next; setPage(next); setHover(null);
  };
  return <main className={`readx-wheel-root${shown ? ' is-shown' : ''}`} aria-label="ReadX 快速轮盘" onContextMenu={event => { event.preventDefault(); window.__READX_LAUNCHER__?.dismiss(); }} onClick={event => {
    if ((event.target as Element).closest('button')) return;
    const target = hitRef.current(event.clientX, event.clientY);
    if (target) window.__READX_LAUNCHER__?.activate(target); else window.__READX_LAUNCHER__?.dismiss();
  }}>
    <div className="readx-wheel" style={{ transform: `scale(${size / WHEEL_SIZE})`, '--wheel-accent': workspace.color, '--wheel-logo-color': workspace.logoColor } as CSSProperties}>
      <svg className="readx-wheel-outer-ring" viewBox="0 0 720 720" aria-hidden="true">
        <circle className="readx-wheel-outer-base" cx="360" cy="360" r={(PROJECT_INNER_RADIUS + PROJECT_OUTER_RADIUS) / 2} strokeWidth={PROJECT_OUTER_RADIUS - PROJECT_INNER_RADIUS} />
        {visible.map((project, index) => <path key={project.id} d={projectSector(index, visible.length)} className={hover?.id === project.id && hover.workspace === active ? 'is-hovered' : ''} />)}
      </svg>
      <svg className="readx-wheel-sectors" viewBox="0 0 720 720" aria-hidden="true">
        {WHEEL_WORKSPACES.map((item, index) => <path key={item.id} d={wheelSector(index)} className={active === item.id ? 'is-active' : ''} style={{ '--sector-accent': item.color } as CSSProperties} />)}
      </svg>
      {WHEEL_WORKSPACES.map((item, index) => {
        const point = wheelPoint(-90 + index * 72, 122);
        return <button type="button" key={item.id} className={`readx-wheel-workspace${active === item.id ? ' is-active' : ''}`} style={{ left: point.x, top: point.y, '--sector-accent': item.color } as CSSProperties}
          aria-label={`打开${item.label}`}
          onClick={() => window.__READX_LAUNCHER__?.activate({ workspace: item.id })}>
          <WorkspaceIcon name={item.icon} size={23} /><span>{item.label}</span>
        </button>;
      })}
      <button type="button" className="readx-wheel-center" aria-label="取消轮盘" onClick={() => window.__READX_LAUNCHER__?.dismiss()}>
        <strong>Read<span>X</span></strong><small>{workspace.label}</small>
      </button>
      {visible.map((project, index) => {
        const point = projectPlacement(index, visible.length);
        return <button type="button" key={project.id} className={`readx-wheel-project${hover?.id === project.id && hover.workspace === active ? ' is-hovered' : ''}`}
          style={{ left: point.x, top: point.y, transform: `translate(-50%, -50%) rotate(${point.rotation}deg)` }} title={project.title} onClick={() => window.__READX_LAUNCHER__?.activate({ workspace: active, id: project.id })}>
          <span className="readx-wheel-project-mark"><WorkspaceIcon name={workspace.icon} size={15} /></span>
          <span className="readx-wheel-project-copy"><strong>{project.title}</strong><small>{project.subtitle || workspace.label}</small></span>
        </button>;
      })}
      {!visible.length && <div className="readx-wheel-empty"><WorkspaceIcon name={workspace.icon} size={20} /><p>{group?.error || '还没有项目，进入工作区后添加'}</p></div>}
      {pages > 1 && <nav className="readx-wheel-pagination" aria-label="项目翻页"><button type="button" aria-label="上一页项目" onClick={() => changePage(-1)}>‹</button><span>{currentPage + 1} / {pages}</span><button type="button" aria-label="下一页项目" onClick={() => changePage(1)}>›</button></nav>}
    </div>
  </main>;
}
