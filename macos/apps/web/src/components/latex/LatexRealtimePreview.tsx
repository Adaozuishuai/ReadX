import { useEffect, useRef, useState } from 'react';
import type { useLatexRealtime } from '../../hooks/useLatexRealtime';
import type { LivePreview } from '../../lib/rtex/live';
import type { Diagnostic } from '../../lib/rtex/protocol';
import { SP_PER_BP } from '../../lib/rtex/protocol';
import { drawLivePage } from '../../lib/rtex/page';
import './LatexRealtimePreview.css';

type Realtime = ReturnType<typeof useLatexRealtime>;

function LivePage({ live, page, width, height, revision }: { live: LivePreview; page: number; width: number; height: number; revision: number }) {
  const host = useRef<HTMLDivElement>(null);
  const drawing = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [badge, setBadge] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (!host.current) return;
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: '600px' });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !drawing.current) return;
    let cancelled = false;
    void drawLivePage(live, page, width, height, Math.min(window.devicePixelRatio || 1, 3)).then(result => {
      if (!result || cancelled || !drawing.current) return;
      drawing.current.replaceChildren(result.canvas);
      setBadge(result.badge); setReason(result.reason);
    }).catch(cause => { if (!cancelled) { setBadge('预览绘制失败'); setReason(String(cause)); } });
    return () => { cancelled = true; };
  }, [live, page, width, height, revision, visible]);
  return <div className="latex-live-page" ref={host} style={{ width, height }} aria-label={`实时预览第 ${page} 页`}>
    <div ref={drawing} />
    <span className="latex-live-page-number">{page}</span>
    {badge ? <span className="latex-live-badge" title={reason}>{badge}</span> : null}
  </div>;
}

export function LatexRealtimePreview({ realtime, supported, onSwitchEngine, onDiagnostic }: {
  realtime: Realtime;
  supported: boolean;
  onSwitchEngine: () => void;
  onDiagnostic: (diagnostic: Diagnostic) => void;
}) {
  const { live, runtime, installing } = realtime;
  const viewport = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(480);
  const [zoom, setZoom] = useState(0);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setAvailableWidth(Math.max(180, element.clientWidth - 32)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [supported, live]);
  const diagnostics = live ? [...live.diagnostics.values()].flat() : [];
  const pages = live ? [...live.model.pages.values()].sort((a,b) => a.page - b.page) : [];
  const maxWidth = pages.length ? Math.max(...pages.map(page => page.dl.page_width || 39157760)) : 39157760;
  const scale = zoom ? zoom/100*(96/72)/SP_PER_BP : availableWidth/maxWidth;
  const percent = zoom || Math.round(scale*SP_PER_BP*72/96*100);
  return <section className="latex-live" aria-label="LaTeX 实时预览">
    <header className="latex-live-toolbar">
      <strong>实时预览</strong>
      {live?.timing !== undefined ? <small title="rtex 最近一次段落排版耗时，不含网络与画布绘制">段落 {live.timing.toFixed(1)} ms</small> : null}
      <div className="latex-live-actions">
        <button type="button" onClick={() => setZoom(Math.max(25, percent - 25))} aria-label="缩小实时预览">−</button>
        <span>{percent}%</span>
        <button type="button" onClick={() => setZoom(Math.min(250, percent + 25))} aria-label="放大实时预览">+</button>
        <button type="button" onClick={() => setZoom(0)} aria-pressed={zoom === 0}>适宽</button>
        <button type="button" onClick={realtime.requestLayout} disabled={!live?.model.hasLayout}>刷新整页</button>
      </div>
    </header>
    {!supported ? <div className="latex-live-empty">
      <strong>实时预览使用 LuaLaTeX</strong>
      <p>将项目编译引擎切换到 LuaLaTeX 后，即可边编辑边查看段落排版。</p>
      <button type="button" onClick={onSwitchEngine}>切换到 LuaLaTeX</button>
    </div> : <>
      <div className="latex-live-status" role="status"><span className={live?.pending ? 'pending' : ''} />{live?.status || '正在检查实时排版引擎…'}
        <button type="button" onClick={realtime.refresh} disabled={installing}>重新连接</button>
      </div>
      {live?.error ? <pre className="latex-live-error" role="alert">{live.error}</pre> : null}
      {runtime && !runtime.ready ? <div className="latex-live-empty">
        <strong>{runtime.installed ? '实时排版暂不可用' : '安装实时排版引擎'}</strong>
        <p>{runtime.reason}</p>
        {!runtime.installed && runtime.canInstall ? <button type="button" disabled={installing} onClick={() => void realtime.install()}>
          {installing ? '正在下载并安装…' : `下载并安装 rtex ${runtime.version}`}
        </button> : null}
        <small>引擎来自 GitHub 官方发行版，本机还需安装 LuaLaTeX。</small>
      </div> : <div className="latex-live-viewport" ref={viewport}>
        {!pages.length ? <div className="latex-live-empty"><strong>{live?.error ? '等待修复排版错误' : '正在生成首次预览…'}</strong><p>首次启动需要排版整篇文档，之后会直接更新修改的段落。</p></div> : null}
        {live && pages.map(page => <LivePage key={page.page} live={live} page={page.page}
          width={Math.round((page.dl.page_width || 39157760)*scale)}
          height={Math.round((page.dl.page_height || 55380990)*scale)} revision={live.pageRevisions.get(page.page) || 0} />)}
      </div>}
      {diagnostics.length ? <details className="latex-live-diagnostics" open={diagnostics.some(item => item.severity.toLowerCase() === 'error')}>
        <summary>LaTeX 诊断（{diagnostics.length}）</summary>
        <div>{diagnostics.map((item, i) => <button key={i} type="button" onClick={() => onDiagnostic(item)} disabled={!item.file}>
          <small>{item.severity} {item.file}{item.line ? `:${item.line}` : ''}</small><span>{item.message}</span>
        </button>)}</div>
      </details> : null}
    </>}
  </section>;
}
