export interface ParagraphQuestion {
  text: string;
  position: number;
  kind: 'pdf' | 'epub';
  nonce: number;
}

/** 段落浮窗：只保留「以此段提问」。段落翻译已并入 LeePDF 排版译文，不再单独调用模型。 */
export function ParagraphActions({
  paragraph,
  onAsk,
  onClose,
}: {
  paragraph: SelectedParagraph;
  onAsk: () => void;
  onClose: () => void;
}) {
  return (
    <section
      role="dialog"
      aria-label="段落操作"
      className="paragraph-actions"
      style={{
        top: Math.max(8, Math.min(paragraph.top + 8, window.innerHeight - 480)),
        left: Math.max(8, Math.min(paragraph.left, window.innerWidth - 488)),
      }}
    >
      <header>
        <strong>
          {paragraph.kind === 'pdf' ? 'Page' : 'Chapter'} {paragraph.position} · 第 {paragraph.index + 1} 段
        </strong>
        <button aria-label="关闭段落操作" onClick={onClose}>×</button>
      </header>
      <p className="paragraph-source">{paragraph.text}</p>
      <div className="paragraph-buttons">
        <button onClick={onAsk}>就此段提问</button>
      </div>
    </section>
  );
}

export interface SelectedParagraph {
  text: string;
  position: number;
  index: number;
  targetY?: number;
  viewportOffset?: number;
  top: number;
  left: number;
  kind: 'pdf' | 'epub';
}
