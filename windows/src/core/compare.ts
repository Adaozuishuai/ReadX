// 对比矩阵的列固定逻辑（PRD 5.3「对比维度控制 + 可固定列」）。
// 纯函数：把「固定列」从滚动区提到前面，便于单元测试与复用。
//
// 移植纪律：逐条对应 native/Sources/CBCTReading/CompareModels.swift 的 CompareLayout / Comparability。

/**
 * 把被固定的论文列移到最前，其余保持原有相对顺序。
 * @param keys 当前选中的论文 key（顺序即展示顺序）
 * @param pinned 被固定的 key；不在 keys 中时视为未固定
 */
export function orderedKeys(keys: string[], pinned: string | null): string[] {
  if (pinned == null || !keys.includes(pinned)) return keys;
  return [pinned, ...keys.filter((k) => k !== pinned)];
}

/** 该列是否处于固定状态（用于按钮高亮）。 */
export function isPinned(key: string, pinned: string | null): boolean {
  return pinned === key;
}

/** 点击固定按钮：同一列再点一次即取消固定。 */
export function toggled(key: string, current: string | null): string | null {
  return current === key ? null : key;
}

/** 选中的论文集合变化后，固定列可能已不在其中，需要清理失效的固定。 */
export function reconciled(keys: string[], pinned: string | null): string | null {
  if (pinned == null) return null;
  return keys.includes(pinned) ? pinned : null;
}

// MARK: - 对比会话持久化（PRD 4.8：对比选择可保存）

/** 选中的论文集合与固定列，写入 app/data/compare.json，重启后恢复。 */
export interface CompareSession {
  selected: string[];
  pinned: string | null;
}

export function defaultCompareSession(): CompareSession {
  return { selected: [], pinned: null };
}

// MARK: - 跨协议可比性检查（PRD 12：不同协议的结果不能直接排名）

export interface CompareRow {
  label: string;
  values: string[];
}

/** 参与可比性检查的维度（行标签必须与 CompareWorkspace 的行标签一致）。 */
export const checkedRows: Set<string> = new Set(['视角数', '几何', '数据集']);

/**
 * 基于已展示的对比行做规则检查：同一维度下，两篇以上给出了**不同**的已知值时给出警示。
 * 未知（未抽取/未说明）不参与判断——不补造、不误报。
 */
export function warnings(rows: Array<[string, string[]]>): string[] {
  const out: string[] = [];
  for (const [label, values] of rows) {
    if (!checkedRows.has(label)) continue;
    const known = values
      .map((v) => v.split(' [研究笔记，需核对]').join(''))
      .filter((v) => !v.includes('论文未说明') && !v.includes('尚未抽取'))
      // Swift 的 lowercase + !isWhitespace：先小写，再删掉所有空白，最后去重。
      .map((v) => Array.from(v.toLowerCase()).filter((ch) => !/\s/u.test(ch)).join(''));
    const distinct = new Set(known);
    if (distinct.size > 1) {
      out.push(`${label}不一致（${distinct.size} 种已知设置）：不同实验协议的指标不能直接排名，请核对采集条件后再比较。`);
    }
  }
  return out;
}
