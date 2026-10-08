// GFM 管道表格解析。与 native/Sources/CBCTReading/MarkdownTable.swift 语义一致。
//
// 设计要点（保证「不猜」与「不崩」）：
// - 只把「表头行 + 分隔行 + 至少一行数据」识别为表格；缺分隔行则按普通段落处理；
// - 列数按表头决定；数据行多出的单元格丢弃（不静默改变列语义），少则补空；
// - 单元格内的 `\|` 视为转义管道符，不参与切分；
// - 对齐方式取自分隔行（:--- / :---: / ---:）。

export type TableAlignment = 'leading' | 'center' | 'trailing';

export interface MarkdownTable {
  header: string[];
  alignments: TableAlignment[];
  rows: string[][];
}

export function columnCount(t: MarkdownTable): number {
  return t.header.length;
}

export function parseAlignment(cell: string): TableAlignment {
  const t = cell.trim();
  const left = t.startsWith(':');
  const right = t.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'trailing';
  return 'leading';
}

/** 切分单元格：支持 `\|` 转义，去掉首尾空格外层管道。 */
export function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  let escaped = false;
  for (const ch of t) {
    if (escaped) {
      // 只对管道符还原转义；其它反斜杠保持原样
      if (ch === '|') current += '|';
      else current += '\\' + ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '|') { cells.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (escaped) current += '\\';
  cells.push(current.trim());
  return cells;
}

/** 是否为合法分隔行：每格由 -、:、空格组成且至少一个 -。 */
export function isDelimiterRow(line: string): boolean {
  const cells = splitRow(line);
  if (!cells.length) return false;
  return cells.every((cell) => {
    const t = cell.trim();
    if (!t) return false;
    const body = t.replace(/^:+|:+$/g, '');
    return body.length > 0 && /^-+$/.test(body);
  });
}

export function starts(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length) return false;
  const head = lines[index].trim();
  if (!head.startsWith('|') && !head.includes('|')) return false;
  return isDelimiterRow(lines[index + 1]);
}

/** 从 lines[start...] 解析表格，返回表格与消耗的行数。解析失败返回 null。 */
export function parseTable(lines: string[], start: number): { table: MarkdownTable; consumed: number } | null {
  if (!starts(lines, start)) return null;
  const header = splitRow(lines[start]);
  if (!header.length || !header.some((c) => c !== '')) return null;

  const cols = header.length;
  let alignments = splitRow(lines[start + 1]).map(parseAlignment);
  if (alignments.length < cols) {
    alignments = alignments.concat(Array<TableAlignment>(cols - alignments.length).fill('leading'));
  } else if (alignments.length > cols) {
    alignments = alignments.slice(0, cols);
  }

  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t) break;                                  // 空行结束表格
    if (!t.startsWith('|') && !t.includes('|')) break;
    if (isDelimiterRow(t)) break;                   // 多余的连续分隔行视为结束
    let cells = splitRow(raw);
    // 列数对齐：多出的丢弃（不改列语义），少的补空
    if (cells.length > cols) cells = cells.slice(0, cols);
    while (cells.length < cols) cells.push('');
    rows.push(cells);
    i++;
  }
  if (!rows.length) return null;
  return { table: { header, alignments, rows }, consumed: i - start };
}

/** 导出为对齐的纯文本（用于复制 / 无表格能力的环境回退）。 */
export function plainText(t: MarkdownTable): string {
  const cols = columnCount(t);
  const width = (col: number): number => {
    let w = t.header[col]?.length ?? 0;
    for (const r of t.rows) if (r[col] !== undefined) w = Math.max(w, r[col].length);
    return Math.max(1, w);
  };
  const widths = Array.from({ length: cols }, (_, c) => width(c));
  const pad = (s: string, w: number, a: TableAlignment): string => {
    const diff = Math.max(0, w - s.length);
    if (a === 'leading') return s + ' '.repeat(diff);
    if (a === 'trailing') return ' '.repeat(diff) + s;
    const l = Math.floor(diff / 2);
    return ' '.repeat(l) + s + ' '.repeat(diff - l);
  };
  let out = '| ' + Array.from({ length: cols }, (_, c) => pad(t.header[c], widths[c], t.alignments[c])).join(' | ') + ' |';
  out += '\n|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|';
  for (const r of t.rows) {
    out += '\n| ' + Array.from({ length: cols }, (_, c) => pad(r[c], widths[c], t.alignments[c])).join(' | ') + ' |';
  }
  return out;
}
