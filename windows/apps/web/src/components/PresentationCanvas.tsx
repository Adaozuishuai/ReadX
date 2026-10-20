import { NUMBER_FONT, NUMBER_PATTERN, TEXT_FONT, SLIDE_WIDTH, SLIDE_HEIGHT, type PresentationScene, type TextNode, type TableNode } from '../lib/presentationDesign';

function numericText(value: string) {
  return value.split(NUMBER_PATTERN).map((part, i) => <tspan key={i} fontFamily={/^[0-9０-９⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]/.test(part) ? NUMBER_FONT : TEXT_FONT}>{part}</tspan>);
}
function SceneText({ node }: { node: TextNode }) {
  const x = node.align === 'right' ? node.x + node.w : node.align === 'center' ? node.x + node.w / 2 : node.x;
  return <text fill={`#${node.color}`} fontSize={node.fontSize / 72} fontWeight={node.bold ? 700 : 400} textAnchor={node.align === 'right' ? 'end' : node.align === 'center' ? 'middle' : 'start'}>
    {node.lines.map((value, i) => <tspan key={i} x={x} y={node.y + node.fontSize / 72 * .9 + i * node.lineHeight}>{numericText(value)}</tspan>)}
  </text>;
}

function SceneTable({ node }: { node: TableNode }) {
  const width = node.w / node.header.length;
  let y = node.y;
  return <g>{[node.header, ...node.rows].map((row, index) => {
    const rowY = y, height = node.rowHeights[index] ?? .62;
    y += height;
    return <g key={index}>{row.map((cell, column) => <g key={column}>
      <rect x={node.x + column * width} y={rowY} width={width} height={height} fill={`#${index === 0 ? node.accent : index % 2 ? node.paper : node.canvas}`} stroke={`#${node.line}`} strokeWidth={.5 / 72} />
      <SceneText node={{ kind: 'text', x: node.x + column * width + .14, y: rowY + .12, w: width - .28, h: height - .24, text: cell, lines: cell.split('\n'), fontSize: node.fontSize, bold: index === 0, color: index === 0 ? node.headerInk : node.ink, align: 'left', lineHeight: node.fontSize / 72 * 1.18 }} />
    </g>)}</g>;
  })}</g>;
}

/** Shared slide coordinates, not a separate approximation of the exported layout. */
export function PresentationCanvas({ scene, thumbnail = false }: { scene: PresentationScene; thumbnail?: boolean }) {
  return <svg className="presentation-canvas" viewBox={`0 0 ${SLIDE_WIDTH} ${SLIDE_HEIGHT}`} role={thumbnail ? undefined : 'img'} aria-label={thumbnail ? undefined : scene.title} aria-hidden={thumbnail || undefined} fontFamily={TEXT_FONT}>
    <rect width={SLIDE_WIDTH} height={SLIDE_HEIGHT} fill={`#${scene.background}`} />
    {scene.nodes.map((node, index) => {
      if (node.kind === 'text') return <SceneText key={index} node={node} />;
      if (node.kind === 'rect') return <rect key={index} x={node.x} y={node.y} width={node.w} height={node.h} fill={`#${node.color}`} />;
      if (node.kind === 'line') return <line key={index} x1={node.x} y1={node.y} x2={node.x + node.w} y2={node.y} stroke={`#${node.color}`} strokeWidth={node.width / 72} />;
      if (node.kind === 'image') return <image key={index} x={node.x} y={node.y} width={node.w} height={node.h} href={node.url} preserveAspectRatio="xMidYMid meet"><title>{node.alt}</title></image>;
      return <SceneTable key={index} node={node} />;
    })}
  </svg>;
}
