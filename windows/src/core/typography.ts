// 排版尺度。与早期 macOS（Swift）版 Typography.swift 数值一致。
// 只定义「尺度」，不含业务逻辑；CSS 侧通过 CSS 变量消费同一套数字。

export const Typography = {
  display: 27,
  title: 21,
  section: 17,
  body: 15,
  callout: 14,
  footnote: 12,
  caption: 11,
  micro: 10,

  heading(level: number): number {
    if (level === 1) return 20;
    if (level === 2) return 17;
    return 15.5;
  },

  bodyLineSpacing: 5,
  blockSpacing: 9,
  itemSpacing: 6,
  cellPaddingH: 10,
  cellPaddingV: 7,

  minColumnWidth: 96,
  maxColumnWidth: 320,
  maxTableHeight: 420,

  /** 按列数分配宽度：至少 minColumnWidth，最多 maxColumnWidth。 */
  columnWidths(count: number, available: number): number[] {
    if (count <= 0) return [];
    const gaps = (count - 1) * 1;
    const usable = Math.max(0, available - gaps);
    const even = usable / count;
    const clamped = Math.min(Math.max(even, this.minColumnWidth), this.maxColumnWidth);
    return Array.from({ length: count }, () => clamped);
  },
} as const;
