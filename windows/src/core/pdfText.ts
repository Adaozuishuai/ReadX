// PDF 文本抽取的纯函数部分（不依赖 pdfjs，便于回归测试）。
//
// Windows 版此前没有任何 PDF 文本抽取能力，只能读 macOS 版生成的 library/text 缓存，
// 所以每篇论文都要手动下载、再手动导入。这里配合 main/pdfExtract.ts 补上抽取链路，
// 产出与 macOS 版同一套 `=== Page N ===` 分页格式，使 evidence 校验与页码跳转可直接复用。

export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
}

export interface PdfPageLines {
  number: number;
  lines: string[];
}

/** PDF 魔数校验：下载到的字节必须以 `%PDF-` 开头。
 *  仅看 HTTP content-type 不够——被重定向到登录页/HTML 时 content-type 也可能是 text/html 但不含 PDF。 */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const magic = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  if (bytes.length < magic.length) return false;
  return magic.every((b, i) => bytes[i] === b);
}

/**
 * 把 pdfjs 的文本项按物理行归并。
 *
 * pdfjs 给出的是带坐标的碎片（一个词甚至一个字符一项），直接拼接会丢掉换行，
 * 表格会糊成一整段。这里按 y 坐标分组（同一行的 y 差异在容差内），组内按 x 排序，
 * 于是「表头一行、数据一行」的结构能保留下来，与 macOS 版按物理行恢复的取向一致。
 */
export function groupItemsIntoLines(items: PdfTextItem[], yTolerance = 3): string[] {
  const kept = items.filter((it) => typeof it.str === 'string' && it.str.length > 0);
  if (!kept.length) return [];
  // 按 y 从大到小（页面自上而下）、同 y 按 x 升序
  const sorted = [...kept].sort((a, b) => (Math.abs(a.y - b.y) <= yTolerance ? a.x - b.x : b.y - a.y));

  const lines: string[] = [];
  let current: PdfTextItem[] = [];
  let baseY: number | null = null;

  const flush = (): void => {
    if (!current.length) return;
    const text = current.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
    if (text) lines.push(text);
    current = [];
  };

  for (const item of sorted) {
    if (baseY === null || Math.abs(item.y - baseY) <= yTolerance) {
      if (baseY === null) baseY = item.y;
      current.push(item);
    } else {
      flush();
      baseY = item.y;
      current.push(item);
    }
  }
  flush();
  return lines;
}

/** 组装 `=== Page N ===` 分页文本，与 macOS 版缓存格式一致（evidence.ts 的 pages() 依赖它）。 */
export function formatPdfPages(pages: PdfPageLines[]): string {
  return pages.map((p) => `=== Page ${p.number} ===\n${p.lines.join('\n')}`).join('\n\n');
}

/** 粗判抽取结果是否「有内容」：几乎没有可读字符说明是扫描件，需要 OCR（本版不支持）。 */
export function isLikelyScanned(text: string): boolean {
  const letters = text.replace(/[^0-9A-Za-z\u4e00-\u9fff]/g, '').length;
  return letters < 50;
}
