import { useMemo, useRef, useState } from 'react';
import type { LatexNode } from '@cbct/shared';
import { WorkspaceIcon } from '../WorkspaceIcon';

/**
 * 文件树。服务端返回的是深度优先的扁平列表，这里按 `/` 层级缩进渲染，
 * 只折叠「用户主动收起」的目录——默认全展开，写作时最常做的是直接点开某个 .tex。
 */
export function LatexFileTree({
  nodes,
  activePath,
  mainFile,
  onOpen,
  onOpenAsset,
  onOp,
  onDelete,
  onExportZip,
  onUploadAssets,
  busy,
}: {
  nodes: LatexNode[];
  activePath: string | null;
  mainFile: string;
  onOpen: (path: string) => void;
  onOpenAsset: (path: string) => void;
  onOp: (op: { op: 'new-file' | 'new-dir' | 'rename' | 'move' | 'copy'; from?: string; to: string }) => void;
  onDelete: (path: string) => void;
  onExportZip: () => void;
  onUploadAssets: (files: File[]) => void;
  busy: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const assetInput = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    const out: LatexNode[] = [];
    for (const node of nodes) {
      // 只要任一祖先被收起，这个节点就不显示。
      const parts = node.path.split('/');
      let hidden = false;
      for (let index = 1; index < parts.length; index += 1) {
        if (collapsed.has(parts.slice(0, index).join('/'))) {
          hidden = true;
          break;
        }
      }
      if (!hidden) out.push(node);
    }
    return out;
  }, [collapsed, nodes]);

  const depthOf = (path: string) => path.split('/').length - 1;

  return (
    <div className="latex-tree">
      <div className="latex-tree-head">
        <span>项目文件</span>
        <div className="latex-tree-actions">
          <button type="button" disabled={busy} aria-label="新建 .tex 文件" title="新建 .tex 文件" onClick={() => {
            const name = window.prompt('新文件名（可带相对路径，如 sections/related.tex）', 'sections/related.tex');
            if (name) onOp({ op: 'new-file', to: name.trim() });
          }}>
            <WorkspaceIcon name="filePlus" size={15} />
          </button>
          <button type="button" disabled={busy} aria-label="新建目录" title="新建目录" onClick={() => {
            const name = window.prompt('新目录名（可带相对路径）', 'sections');
            if (name) onOp({ op: 'new-dir', to: name.trim() });
          }}>
            <WorkspaceIcon name="folderPlus" size={15} />
          </button>
          <button type="button" disabled={busy} aria-label="上传资源" title="上传图片等资源到 figures/" onClick={() => assetInput.current?.click()}>
            <WorkspaceIcon name="upload" size={15} />
          </button>
          <button type="button" disabled={busy} aria-label="导出源码 ZIP" onClick={onExportZip} title="导出源码 ZIP（排除编译副产物）">
            <WorkspaceIcon name="archive" size={15} />
          </button>
          <input
            ref={assetInput}
            type="file"
            multiple
            accept="image/*,.eps,.pdf"
            hidden
            onChange={(event) => {
              if (event.target.files?.length) onUploadAssets(Array.from(event.target.files));
              event.target.value = '';
            }}
          />
        </div>
      </div>
      <ul className="latex-tree-list">
        {visible.map((node) => {
          const depth = depthOf(node.path);
          const isDir = node.kind === 'dir';
          const isCollapsed = collapsed.has(node.path);
          if (renaming === node.path) {
            return (
              <li key={node.path} style={{ paddingLeft: 8 + depth * 12 }}>
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && renameValue.trim()) {
                      onOp({ op: 'rename', from: node.path, to: renameValue.trim() });
                      setRenaming(null);
                    }
                    if (event.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={() => setRenaming(null)}
                />
              </li>
            );
          }
          return (
            <li key={node.path} style={{ paddingLeft: 8 + depth * 12 }}>
              <button
                type="button"
                className={`latex-tree-item kind-${node.kind}${activePath === node.path ? ' active' : ''}`}
                onClick={() => {
                  if (isDir) {
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(node.path)) next.delete(node.path);
                      else next.add(node.path);
                      return next;
                    });
                    return;
                  }
                  if (node.kind === 'tex' || node.kind === 'bib' || node.kind === 'text') onOpen(node.path);
                  else if (node.kind !== 'dir') onOpenAsset(node.path);
                }}
                title={node.path + (isDir ? '' : `（${node.size} 字节）`)}
              >
                <span className="latex-tree-icon" aria-hidden="true">
                  {isDir ? (isCollapsed ? '▸' : '▾') : node.kind === 'image' ? '▣' : node.kind === 'bib' ? '❝' : '▤'}
                </span>
                <span className="latex-tree-name">{node.name}</span>
                {node.path === mainFile ? <span className="latex-tree-badge">根文档</span> : null}
                {node.kind === 'image' ? <span className="latex-tree-note">预览</span> : null}
              </button>
              <div className="latex-tree-row-actions">
                <button
                  type="button"
                  title="重命名"
                  onClick={() => {
                    setRenaming(node.path);
                    setRenameValue(node.path);
                  }}
                >
                  ✎
                </button>
                <button
                  type="button"
                  title="删除"
                  onClick={() => {
                    if (window.confirm(`删除 ${node.path}？`)) onDelete(node.path);
                  }}
                >
                  ✕
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
