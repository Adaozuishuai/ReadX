import type { LatexEngine, LatexNode, LatexProject } from '@cbct/shared';
import { LATEX_ENGINES } from '@cbct/shared';

/**
 * 工作区顶部工具栏：项目名、根文档、引擎、自动编译、保存状态与导出。
 * 「编译 / 停止」在 PR3 接入编译引擎后出现在这里——不做占位死按钮。
 */
export function LatexToolbar({
  project,
  nodes,
  busy,
  dirtyCount,
  onPatch,
  onFlush,
  onExportZip,
  onImportZip,
  onToggleAI,
  aiOpen,
  onBack,
  extra,
}: {
  project: LatexProject;
  nodes: LatexNode[];
  busy: boolean;
  dirtyCount: number;
  onPatch: (patch: { title?: string; mainFile?: string; engine?: LatexEngine; autoCompile?: boolean; aiAutoFix?: boolean }) => void;
  onFlush: () => void;
  onExportZip: () => void;
  onImportZip: (file: File) => void;
  onToggleAI: () => void;
  aiOpen: boolean;
  onBack: () => void;
  /** PR3 在此注入编译按钮组。 */
  extra?: React.ReactNode;
}) {
  const texFiles = nodes.filter((node) => node.kind === 'tex');
  return (
    <header className="latex-toolbar">
      <div className="latex-toolbar-row">
        <button type="button" onClick={onBack} title="回到项目列表">
          ← 项目
        </button>
        <input
          className="latex-title-input"
          value={project.title}
          onChange={(event) => onPatch({ title: event.target.value })}
          aria-label="项目名"
        />
        <label className="latex-field">
          根文档
          <select value={project.mainFile} onChange={(event) => onPatch({ mainFile: event.target.value })}>
            {texFiles.some((node) => node.path === project.mainFile) ? null : (
              <option value={project.mainFile}>{project.mainFile}（缺失）</option>
            )}
            {texFiles.map((node) => (
              <option key={node.path} value={node.path}>
                {node.path}
              </option>
            ))}
          </select>
        </label>
        <label className="latex-field">
          引擎
          <select
            value={project.engine}
            onChange={(event) => onPatch({ engine: event.target.value as LatexEngine })}
          >
            {LATEX_ENGINES.map((item) => (
              <option key={item.id} value={item.id} title={item.hint}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="latex-toggle" title="保存后自动编译（默认关闭）">
          <input
            type="checkbox"
            checked={project.autoCompile}
            onChange={(event) => onPatch({ autoCompile: event.target.checked })}
          />
          自动编译
        </label>
        {/* AI 直接改文件：默认关闭，开启时把后果说清楚——它真的会改磁盘上的源码。 */}
        <label
          className={`latex-toggle${project.aiAutoFix ? ' danger' : ''}`}
          title={
            project.aiAutoFix
              ? '允许「自动修复」按钮直接写入，编译错误未减少时自动回滚。聊天中的文件修改始终先请求批准。'
              : '允许「自动修复」按钮直接写入源码；聊天中的文件修改始终先请求批准。'
          }
        >
          <input
            type="checkbox"
            checked={project.aiAutoFix}
            onChange={(event) => {
              if (
                event.target.checked &&
                !window.confirm(
                  '开启后，「自动修复」按钮可以直接改写项目里的 .tex 文件。\n\n' +
                    '写入前自动创建源码快照，并强制编译验证；错误没有减少就自动回滚。聊天中的修改仍需逐次确认。\n\n' +
                    '确定开启吗？',
                )
              ) {
                return;
              }
              onPatch({ aiAutoFix: event.target.checked });
            }}
          />
          自动修复写入{project.aiAutoFix ? '（已开启）' : ''}
        </label>
        <span className={`latex-save-state${dirtyCount ? ' dirty' : ''}`}>
          {busy ? '处理中…' : dirtyCount ? `${dirtyCount} 个文件未保存` : '全部已保存'}
        </span>
        <div className="latex-toolbar-actions">
          <button type="button" className={aiOpen ? 'primary' : ''} aria-expanded={aiOpen} onClick={onToggleAI} title="打开 LaTeX AI 助手">
            AI 助手
          </button>
          <button type="button" disabled={busy} onClick={onFlush} title="立即把所有改动写入磁盘">
            保存
          </button>
          {extra}
          <button type="button" disabled={busy} onClick={onExportZip} title="导出源码 ZIP">
            导出 ZIP
          </button>
          <label className={`latex-upload small${busy ? ' busy' : ''}`} title="把 ZIP 解压进当前项目（同名文件会被覆盖）">
            导入 ZIP
            <input
              type="file"
              accept=".zip,application/zip"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) onImportZip(file);
              }}
            />
          </label>
        </div>
      </div>
    </header>
  );
}
