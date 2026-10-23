import type { LatexBuild, LatexDiagnostic, LatexToolchainReport } from '@cbct/shared';

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '编译中',
  succeeded: '编译成功',
  failed: '编译失败',
  cancelled: '已取消',
  timeout: '编译超时',
};

/**
 * 编译面板：工具链状态、编译控制、诊断列表。
 *
 * 诊断的每条都能点回源码行——排版错误的修复体验几乎全取决于这一点。
 * 没有工具链时这里给出具体原因与建议，而不是让人对着「编译失败」猜。
 */
export function LatexBuildPanel({
  toolchains,
  build,
  running,
  starting,
  onCompile,
  onCancel,
  onReloadToolchains,
  onOpenDiagnostic,
  onShowLog,
}: {
  toolchains: LatexToolchainReport | null;
  build: LatexBuild | null;
  running: boolean;
  starting: boolean;
  onCompile: () => void;
  onCancel: () => void;
  onReloadToolchains: () => void;
  onOpenDiagnostic: (diagnostic: LatexDiagnostic) => void;
  onShowLog: () => void;
}) {
  const unavailable = toolchains?.strategy === 'unavailable';
  const diagnostics = build?.diagnostics ?? [];
  // 后端已保证这些字段是数组，这里再兜一层：一个 null 就能把整个面板打崩，
  // 而崩溃现场（React 卸载整棵子树）看起来像「编译卡住了」，极难自查。
  const missingCitations = build?.missingCitations ?? [];
  const missingReferences = build?.missingReferences ?? [];

  return (
    <div className="latex-build-panel">
      <div className="latex-build-head">
        <strong>编译</strong>
        <span className={`latex-build-status status-${build?.status ?? 'idle'}`}>
          {build ? STATUS_LABEL[build.status] ?? build.status : '尚未编译'}
        </span>
        <div className="latex-build-actions">
          {running ? (
            <button type="button" onClick={onCancel} className="danger">
              停止
            </button>
          ) : (
            <button type="button" onClick={onCompile} disabled={starting || unavailable} title={unavailable ? '本机没有可用的 TeX 引擎' : '编译当前项目'}>
              编译
            </button>
          )}
          {build?.hasLog ? (
            <button type="button" onClick={onShowLog}>
              日志
            </button>
          ) : null}
        </div>
      </div>

      {toolchains ? (
        <p className="latex-build-toolchain">
          {toolchains.strategy === 'latexmk'
            ? '编译方式：latexmk'
            : unavailable
              ? '本机没有找到可用的 TeX 引擎'
              : '编译方式：内置多趟（引擎 + bibtex/biber + 交叉引用重跑）'}
          {' · '}
          {toolchains.engines
            .map((tool) => `${tool.name}${tool.usable ? '' : '（不可用）'}`)
            .join(' / ')}
          <button type="button" className="link" onClick={onReloadToolchains} title="重新探测（装完 TeX 后不必重启）">
            重新探测
          </button>
        </p>
      ) : null}

      {unavailable && toolchains?.hints.length ? (
        <div className="latex-build-hints">
          {toolchains.hints.map((hint) => (
            <p key={hint}>{hint}</p>
          ))}
        </div>
      ) : null}

      {build?.message ? (
        <p className={`latex-alert ${build.status === 'succeeded' ? 'ok' : 'error'}`}>{build.message}</p>
      ) : null}
      {build?.stale && build.hasPdf ? (
        <p className="latex-alert warn">源码已改动，当前 PDF 是上一次编译的产物。重新编译即可更新。</p>
      ) : null}

      {build ? (
        <p className="latex-build-meta">
          {build.engine} · 根文档 {build.mainFile} · 退出码 {build.exitCode} ·{' '}
          {build.errorCount} 个错误 / {build.warningCount} 个警告
          {build.pages ? ` · ${build.pages} 页` : ''}
        </p>
      ) : null}

      {diagnostics.length ? (
        <ul className="latex-diagnostics">
          {diagnostics.map((diagnostic, index) => (
            <li key={`${diagnostic.file ?? ''}:${diagnostic.line ?? 0}:${index}`} className={`severity-${diagnostic.severity}`}>
              <button
                type="button"
                onClick={() => onOpenDiagnostic(diagnostic)}
                disabled={!diagnostic.file || !diagnostic.line}
                title={
                  diagnostic.file && diagnostic.line
                    ? diagnostic.locationSource === 'search'
                      ? '在项目源码里找到了这个引用键：点它跳到那一行'
                      : '跳到源码这一行（位置来自日志）'
                    : '日志里没有给出文件位置——它可能是整篇级的警告，宁可不给也不猜错'
                }
              >
                <span className="latex-diagnostic-where">
                  {diagnostic.file
                    ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ''}`
                    : diagnostic.line
                      ? `全文 · 第 ${diagnostic.line} 行`
                      : '（日志未给出位置）'}
                </span>
                {diagnostic.source ? (
                  <span className="latex-diagnostic-source" title="这条诊断是谁报的">
                    {diagnostic.source}
                  </span>
                ) : null}
                <span className="latex-diagnostic-message">{diagnostic.message}</span>
                {diagnostic.snippet ? <code className="latex-diagnostic-snippet">{diagnostic.snippet}</code> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : build && !running ? (
        <p className="latex-build-clean">
          {build.status === 'succeeded' ? '没有错误或警告。' : '这次编译没有产生可定位的诊断，请查看日志。'}
        </p>
      ) : null}

      {build && (missingCitations.length || missingReferences.length) ? (
        <p className="latex-alert warn">
          未定义的引用：
          {missingCitations.length ? ` 文献 ${missingCitations.join('、')}` : ''}
          {missingReferences.length ? ` 标签 ${missingReferences.join('、')}` : ''}
        </p>
      ) : null}
    </div>
  );
}