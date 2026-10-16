import Foundation

// 对比矩阵的列固定逻辑（PRD 5.3「对比维度控制 + 可固定列」）。
// 纯函数：把「固定列」从滚动区提到前面，便于单元测试与复用。

enum CompareLayout {
    /// 把被固定的论文列移到最前，其余保持原有相对顺序。
    /// - Parameters:
    ///   - keys: 当前选中的论文 key（顺序即展示顺序）
    ///   - pinned: 被固定的 key；不在 keys 中时视为未固定
    static func orderedKeys(_ keys: [String], pinned: String?) -> [String] {
        guard let pin = pinned, keys.contains(pin) else { return keys }
        return [pin] + keys.filter { $0 != pin }
    }

    /// 该列是否处于固定状态（用于按钮高亮）。
    static func isPinned(_ key: String, pinned: String?) -> Bool {
        pinned == key
    }

    /// 点击固定按钮：同一列再点一次即取消固定。
    static func toggled(_ key: String, current: String?) -> String? {
        current == key ? nil : key
    }

    /// 选中的论文集合变化后，固定列可能已不在其中，需要清理失效的固定。
    static func reconciled(_ keys: [String], pinned: String?) -> String? {
        guard let pin = pinned else { return nil }
        return keys.contains(pin) ? pin : nil
    }
}

// MARK: - 对比会话持久化（PRD 4.8：对比选择可保存）

/// 选中的论文集合与固定列，写入 app/data/compare.json，重启后恢复。
struct CompareSession: Codable {
    var selected: [String] = []
    var pinned: String? = nil
}

// MARK: - 跨协议可比性检查（PRD 12：不同协议的结果不能直接排名）

enum Comparability {
    /// 参与可比性检查的维度（行标签必须与 CompareWorkspace 的行标签一致）。
    static let checkedRows: Set<String> = ["视角数", "几何", "数据集"]

    /// 基于已展示的对比行做规则检查：同一维度下，两篇以上给出了**不同**的已知值时给出警示。
    /// 未知（未抽取/未说明）不参与判断——不补造、不误报。
    static func warnings(rows: [(String, [String])]) -> [String] {
        var out: [String] = []
        for (label, values) in rows where checkedRows.contains(label) {
            let known = values
                .map { $0.replacingOccurrences(of: " [研究笔记，需核对]", with: "") }
                .filter { !$0.contains("论文未说明") && !$0.contains("尚未抽取") }
                .map { $0.lowercased().filter { !$0.isWhitespace } }
            let distinct = Array(Set(known))
            if distinct.count > 1 {
                out.append("\(label)不一致（\(distinct.count) 种已知设置）：不同实验协议的指标不能直接排名，请核对采集条件后再比较。")
            }
        }
        return out
    }
}
