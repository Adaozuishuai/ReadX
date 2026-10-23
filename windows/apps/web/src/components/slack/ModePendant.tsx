export type WorkspaceMode = 'research' | 'slack';

/** 点击挂件拉上舞台幕布，在幕布后切换工作区。原生按钮同时支持键盘操作。 */
export function ModePendant({
  mode,
  onMode,
}: {
  mode: WorkspaceMode;
  onMode: (mode: WorkspaceMode) => void;
}) {
  const next = mode === 'slack' ? 'research' : 'slack';
  const label = mode === 'slack' ? '点击挂件，拉幕返回科研界面' : '点击挂件，拉幕进入摸鱼界面';

  return (
    <div className="mode-pendant" data-mode={mode}>
      <div className="mode-pendant__swing">
        <button
          type="button"
          className="mode-pendant__handle"
          aria-label={label}
          title={label}
          onClick={() => onMode(next)}
        >
          <img src="/slack/qwen.png" alt="" draggable={false} />
        </button>
        {mode === 'slack' ? <span className="mode-pendant__tag">摸鱼中</span> : null}
      </div>
    </div>
  );
}
