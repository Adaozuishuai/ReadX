// 架构图 / 模型结构图解析（纯逻辑部分）——移植自 macOS FigureAnalysis.swift。
//
// 链路：定位图中区域（图题启发式）→ OCR 取图中文字 → 视觉模型输出模块与连接的 JSON
// → 校验（标签必须在图中 OCR 文本里出现，防止凭空编造）→ 分层布局渲染。
// 任一步失败都只保留目标图块裁剪与图题；没有可靠裁剪时不发送/展示整页，绝不推测结构。
//
// 这里只做可测的纯函数：解码、校验清洗、分层、布局。视觉调用在 main/figureAnalysis.ts。

import { normalized } from './evidence';

export interface FigureNode {
  id: string;
  label: string;
  /** 模块类型：input / module / loss / output / data */
  kind: string;
  layer?: number | null;
}

export interface FigureEdge { from: string; to: string; label?: string | null }

export interface FigureSubpanel {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  nodes: FigureNode[];
  edges: FigureEdge[];
  ocrText: string;
  dropped: string[];
  note: string;
}

export interface FigureAnalysis {
  page: number;
  title: string;
  nodes: FigureNode[];
  edges: FigureEdge[];
  /** 未通过校验（标签未出现在图中 OCR 文本）而被剔除的节点标签 */
  dropped: string[];
  note: string;
  panels: FigureSubpanel[];
}

/** 解码模型输出（剥掉可能的代码围栏与非 JSON 前缀）。 */
export function decodeFigureAnalysis(raw: string): FigureAnalysis {
  let text = (raw ?? '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  else if (text.startsWith('```')) text = text.split('\n').slice(1, -1).join('\n');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (e) { throw new Error('图解析不是合法 JSON：' + (e instanceof Error ? e.message : String(e))); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('图解析必须是 JSON 对象。');
  const obj = parsed as Record<string, any>;
  if (!Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) throw new Error('图解析缺少 nodes/edges 数组。');
  return {
    page: typeof obj.page === 'number' ? obj.page : 0,
    title: typeof obj.title === 'string' ? obj.title : '',
    nodes: obj.nodes.map(normNode),
    edges: obj.edges.map(normEdge),
    dropped: [], note: '',
    panels: Array.isArray(obj.panels) ? obj.panels.map(normPanel) : [],
  };
}

function normNode(n: any): FigureNode {
  // Coerce model output into the known shape; missing id/label become empty and get dropped by validation.
  return { id: String(n?.id ?? ''), label: String(n?.label ?? ''), kind: typeof n?.kind === 'string' ? n.kind : 'module', layer: typeof n?.layer === 'number' ? n.layer : null };
}
function normEdge(e: any): FigureEdge {
  return { from: String(e?.from ?? ''), to: String(e?.to ?? ''), label: typeof e?.label === 'string' ? e.label : null };
}
function normPanel(p: any): FigureSubpanel {
  return {
    id: String(p?.id ?? ''), label: String(p?.label ?? ''),
    x: typeof p?.x === 'number' ? p.x : -1, y: typeof p?.y === 'number' ? p.y : -1,
    width: typeof p?.width === 'number' ? p.width : 0, height: typeof p?.height === 'number' ? p.height : 0,
    nodes: Array.isArray(p?.nodes) ? p.nodes.map(normNode) : [],
    edges: Array.isArray(p?.edges) ? p.edges.map(normEdge) : [],
    ocrText: typeof p?.ocrText === 'string' ? p.ocrText : '',
    dropped: [], note: '',
  };
}

/**
 * 校验并清洗：节点标签必须在图中 OCR 文本出现（宽松匹配：忽略空白与大小写）。
 * 边引用的节点必须存在；子图裁剪框必须在 [0,1] 内且不小于 0.08。
 */
export function validateFigureAnalysis(a: FigureAnalysis, ocrText: string): FigureAnalysis {
  const hay = normalized(ocrText);
  const kept: FigureNode[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const node of a.nodes) {
    const label = (node.label ?? '').trim();
    if (!node.id.trim() || !label || seen.has(node.id)) { dropped.push(label ? label + '（重复/空 ID）' : '(空标签或重复/空 ID)'); continue; }
    seen.add(node.id);
    if (hay.includes(normalized(label))) kept.push(node);
    else dropped.push(label);
  }
  const ids = new Set(kept.map((n) => n.id));
  // 边标签也是「被报告的事实」：必须出现在图内 OCR 文本里，否则整条边剔除并披露。
  // （连接与箭头方向本身无法从 OCR 核验，只能靠 note 向用户披露其为模型判读。）
  const edges = a.edges.filter((e) => {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) return false;
    const label = (e.label ?? '').trim();
    if (label && !hay.includes(normalized(label))) {
      dropped.push(`连线标签「${label}」未被图内 OCR 核验`);
      return false;
    }
    return true;
  });

  const panels: FigureSubpanel[] = [];
  for (const panel of a.panels) {
    const okRect = panel.x >= 0 && panel.y >= 0 && panel.x + panel.width <= 1.001 && panel.y + panel.height <= 1.001 && panel.width >= 0.08 && panel.height >= 0.08;
    if (!panel.id || !panel.label || !okRect || !panel.ocrText.trim()) { dropped.push(`子图 ${panel.label}：裁剪框或局部 OCR 无效`); continue; }
    const panelOCR = normalized(panel.ocrText);
    const marker = panel.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const markerRe = new RegExp(`^\\s*\\(?${marker}\\)?[.):]?\\s*$`, 'i');
    const markerFound = panel.ocrText.split('\n').some((l) => markerRe.test(l)) || panelOCR.includes(normalized(panel.label));
    if (!markerFound) { dropped.push(`子图 ${panel.label}：图内标记未被该裁剪 OCR 核验`); continue; }
    const panelNodes: FigureNode[] = [];
    const panelDropped: string[] = [];
    const panelIDs = new Set<string>();
    for (const node of panel.nodes) {
      const label = (node.label ?? '').trim();
      if (!node.id || !label || panelIDs.has(node.id) || !panelOCR.includes(normalized(label))) {
        panelDropped.push(label || '空标签/重复 ID');
        dropped.push(`子图 ${panel.label}：模块「${label}」未被局部 OCR 核验`);
        continue;
      }
      panelIDs.add(node.id);
      panelNodes.push(node);
    }
    const pids = new Set(panelNodes.map((n) => n.id));
    const panelEdges = panel.edges.filter((e) => {
      if (!pids.has(e.from) || !pids.has(e.to) || e.from === e.to) return false;
      const label = (e.label ?? '').trim();
      if (label && !panelOCR.includes(normalized(label))) {
        panelDropped.push(`连线标签「${label}」`);
        dropped.push(`子图 ${panel.label}：连线标签「${label}」未被局部 OCR 核验`);
        return false;
      }
      return true;
    });
    panels.push({
      ...panel, nodes: panelNodes,
      edges: panelEdges,
      dropped: [...panel.dropped, ...panelDropped],
      note: panelDropped.length ? '已剔除本子图 OCR 未核实的模块/连线：' + panelDropped.join('、') : panel.note,
    });
  }
  const noteParts: string[] = [];
  if (dropped.length) noteParts.push(`已剔除 ${dropped.length} 个未通过图内 OCR 核验的标签/连线/子图：` + dropped.join('、'));
  else if (a.note) noteParts.push(a.note);
  if (edges.length > 0 || panels.some((p) => p.edges.length > 0)) {
    noteParts.push('连线与箭头方向为视觉模型判读，图内 OCR 仅能核验端点与边标签');
  }
  return {
    ...a, nodes: kept, edges, panels,
    dropped,
    note: noteParts.join('；'),
  };
}

/** 是否可用于渲染：至少两个节点且至少一条边（或某个子图满足）。 */
export function figureUsable(a: FigureAnalysis): boolean {
  return (a.nodes.length >= 2 && a.edges.length > 0) || a.panels.some((p) => p.nodes.length >= 2 && p.edges.length > 0);
}

// MARK: - 分层布局（纯函数）

export interface PlacedNode { id: string; x: number; y: number; width: number; height: number; label: string; kind: string; layer: number }
export interface LayoutArrow { x1: number; y1: number; x2: number; y2: number; label?: string | null }
export interface LayoutResult { placed: PlacedNode[]; arrows: LayoutArrow[]; layerCount: number }

/** 计算层级：优先用模型给出的 layer，缺失时用「最长路径」分层（迭代松弛，有环也终止）。 */
export function figureLayers(nodes: FigureNode[], edges: FigureEdge[]): Record<string, number> {
  const depth: Record<string, number> = {};
  for (const n of nodes) depth[n.id] = n.layer ?? 0;
  for (let iter = 0; iter < Math.max(1, nodes.length); iter++) {
    let changed = false;
    for (const e of edges) {
      const cur = depth[e.to] ?? 0;
      const cand = (depth[e.from] ?? 0) + 1;
      if (cand > cur) { depth[e.to] = cand; changed = true; }
    }
    if (!changed) break;
  }
  return depth;
}

/** 在给定画布内排布节点：层级沿主轴排列，层内节点沿副轴均分。 */
export function layoutFigure(nodes: FigureNode[], edges: FigureEdge[], canvasW: number, canvasH: number, vertical: boolean): LayoutResult {
  if (!nodes.length || canvasW <= 40 || canvasH <= 40) return { placed: [], arrows: [], layerCount: 0 };
  const depth = figureLayers(nodes, edges);
  const grouped = new Map<number, FigureNode[]>();
  for (const n of nodes) {
    const k = depth[n.id] ?? 0;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k)!.push(n);
  }
  const layerKeys = [...grouped.keys()].sort((a, b) => a - b);
  const padding = 12, gap = 10;
  const layerSpan = vertical ? canvasH - padding * 2 : canvasW - padding * 2;
  const crossSpan = vertical ? canvasW - padding * 2 : canvasH - padding * 2;
  const layerSize = Math.max(40, layerSpan / Math.max(1, layerKeys.length));

  const placed: PlacedNode[] = [];
  layerKeys.forEach((key, index) => {
    const items = grouped.get(key) ?? [];
    const offset = padding + index * layerSize;
    const itemSize = Math.max(28, crossSpan / Math.max(1, items.length) - gap);
    items.forEach((node, i) => {
      const cross = padding + i * (itemSize + gap);
      placed.push(vertical
        ? { id: node.id, x: cross, y: offset, width: itemSize, height: Math.min(layerSize - gap, 62), label: node.label, kind: node.kind, layer: key }
        : { id: node.id, x: offset, y: cross, width: Math.min(layerSize - gap, 132), height: Math.min(itemSize, 54), label: node.label, kind: node.kind, layer: key });
    });
  });

  const byID = new Map<string, PlacedNode>();
  for (const n of placed) if (!byID.has(n.id)) byID.set(n.id, n);
  const arrows: LayoutArrow[] = [];
  for (const e of edges) {
    const a = byID.get(e.from), b = byID.get(e.to);
    if (!a || !b) continue;
    arrows.push(vertical
      ? { x1: a.x + a.width / 2, y1: a.y + a.height, x2: b.x + b.width / 2, y2: b.y, label: e.label }
      : { x1: a.x + a.width, y1: a.y + a.height / 2, x2: b.x, y2: b.y + b.height / 2, label: e.label });
  }
  return { placed, arrows, layerCount: layerKeys.length };
}

/** 把布局结果渲染为 SVG（Windows 渲染层是 DOM；macOS 用 Canvas 视图）。 */
export function figureSVG(result: LayoutResult, width: number, height: number): string {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const arrows = result.arrows.map((a) => `<line x1="${a.x1.toFixed(1)}" y1="${a.y1.toFixed(1)}" x2="${a.x2.toFixed(1)}" y2="${a.y2.toFixed(1)}" stroke="#222" stroke-width="1.3" marker-end="url(#arw)"/>`).join('');
  const boxes = result.placed.map((n) => {
    const fill = ({ input: '#B5F2C8', output: '#FFF2A8', loss: '#FFE8EE', data: '#8BE9FD' } as Record<string, string>)[n.kind] ?? '#F1ECFF';
    return `<g><rect x="${n.x.toFixed(1)}" y="${n.y.toFixed(1)}" width="${n.width.toFixed(1)}" height="${n.height.toFixed(1)}" rx="8" fill="${fill}" stroke="#222" stroke-width="1.3"/>`
      + `<text x="${(n.x + n.width / 2).toFixed(1)}" y="${(n.y + n.height / 2 + 3).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" fill="#222">${esc(n.label.slice(0, 22))}</text></g>`;
  }).join('');
  return `<svg width="100%" height="100%" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`
    + `<defs><marker id="arw" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 z" fill="#222"/></marker></defs>`
    + arrows + boxes + `</svg>`;
}
