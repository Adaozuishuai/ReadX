import SwiftUI

// 排版尺度（Typography）统一入口。
// 目的：把散落在各视图里的 size 字面量收敛成一套可复核的层级，
// 并让中英混排、行距、表格密度有统一定义。
// 只定义「尺度」，不改变任何业务逻辑。

enum Typography {
    // MARK: - 字号层级
    /// 页面主标题（如「你的研究论文库」）
    static let display: CGFloat = 27
    /// 区块标题
    static let title: CGFloat = 21
    /// 小节标题
    static let section: CGFloat = 17
    /// 正文默认
    static let body: CGFloat = 15
    /// 次要正文（卡片内说明）
    static let callout: CGFloat = 14
    /// 辅助信息
    static let footnote: CGFloat = 12
    /// 最小可读标注（徽章、页码）
    static let caption: CGFloat = 11
    /// 极小的技术标注（confidence、审计行）
    static let micro: CGFloat = 10

    // MARK: - Markdown 块级字号
    static func heading(_ level: Int) -> CGFloat {
        switch level {
        case 1: return 20
        case 2: return 17
        default: return 15.5
        }
    }

    // MARK: - 行距与间距
    /// 正文行距。中文正文需要比纯英文更大的行距才不挤。
    static let bodyLineSpacing: CGFloat = 5
    /// 块与块之间
    static let blockSpacing: CGFloat = 9
    /// 列表项之间
    static let itemSpacing: CGFloat = 6
    /// 表格单元格内边距
    static let cellPaddingH: CGFloat = 10
    static let cellPaddingV: CGFloat = 7

    // MARK: - 表格
    /// 单元格最小宽度，避免窄列挤成竖排
    static let minColumnWidth: CGFloat = 96
    /// 单列最大宽度，超出则换行而不是无限拉伸
    static let maxColumnWidth: CGFloat = 320
    /// 表格整体最大高度（超过则内部滚动，避免把整页撑开）
    static let maxTableHeight: CGFloat = 420

    /// 按列数分配宽度：至少 minColumnWidth，最多 maxColumnWidth。
    static func columnWidths(columnCount: Int, available: CGFloat) -> [CGFloat] {
        guard columnCount > 0 else { return [] }
        let gaps = CGFloat(columnCount - 1) * 1
        let usable = max(0, available - gaps)
        let even = usable / CGFloat(columnCount)
        let clamped = min(max(even, minColumnWidth), maxColumnWidth)
        return Array(repeating: clamped, count: columnCount)
    }
}
