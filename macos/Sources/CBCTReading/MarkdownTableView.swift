import SwiftUI

// 表格渲染（GFM 管道表格）。
//
// 设计取舍：
// - 列宽按表头列数均分并夹在 [minColumnWidth, maxColumnWidth]，避免窄列竖排 / 单列过宽；
// - 超宽时**整体横向滚动**，而不是压缩字号（压缩会让数字难读）；
// - 超高时**内部纵向滚动**并固定表头，避免一个长表把整页撑开；
// - 表头与单元格内容统一**居中**：内容与表头相互对齐，文字在列内两侧留白对称；
//   分隔行的 :/对齐标记不再驱动显示对齐（plainText 导出仍保留原对齐声明）；
// - 表头有底色以区隔；斑马纹提升多行可读性。

struct MarkdownTableView: View {
    let table: MarkdownTable
    var size: CGFloat = Typography.callout
    var onEvidence: ((Int, String) -> Void)? = nil

    /// 单元格内联渲染（复用 Markdown 的行内解析，保留 **粗体** / `代码` / 链接）。
    private func cell(_ text: String, isHeader: Bool) -> some View {
        Markdown.inline(text.isEmpty ? " " : text, size: size)
            .fontWeight(isHeader ? .semibold : .regular)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.horizontal, Typography.cellPaddingH)
            .padding(.vertical, Typography.cellPaddingV)
    }

    private var minWidth: CGFloat {
        CGFloat(table.columnCount) * Typography.minColumnWidth + CGFloat(max(0, table.columnCount - 1))
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 0) {
                headerRow
                ScrollView(.vertical, showsIndicators: true) {
                    VStack(spacing: 0) {
                        ForEach(Array(table.rows.enumerated()), id: \.offset) { i, row in
                            HStack(spacing: 0) {
                                ForEach(Array(row.enumerated()), id: \.offset) { c, value in
                                    cell(value, isHeader: false)
                                    if c < row.count - 1 { Divider().overlay(Color.line) }
                                }
                            }
                            .background(i % 2 == 0 ? Color.card : Color.paper)
                            .overlay(alignment: .top) { if i > 0 { Divider().overlay(Color.line) } }
                        }
                    }
                }
                .frame(maxHeight: table.rows.count > 8 ? Typography.maxTableHeight : nil)
            }
            .frame(minWidth: minWidth, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.line, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
        .accessibilityLabel("表格，\(table.columnCount) 列 \(table.rows.count) 行")
    }

    private var headerRow: some View {
        HStack(spacing: 0) {
            ForEach(Array(table.header.enumerated()), id: \.offset) { c, value in
                cell(value, isHeader: true)
                if c < table.header.count - 1 { Divider().overlay(Color.line) }
            }
        }
        .background(Color.tealSoft)
        .overlay(alignment: .bottom) { Divider().overlay(Color.line) }
    }
}

// 无表格能力的环境（或复制到剪贴板）用等宽纯文本回退。
struct MarkdownTablePlainView: View {
    let table: MarkdownTable
    var body: some View {
        ScrollView(.horizontal, showsIndicators: true) {
            Text(table.plainText())
                .font(.system(size: Typography.caption, design: .monospaced))
                .textSelection(.enabled)
                .padding(Typography.cellPaddingV)
        }
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.card))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.line, lineWidth: 1))
    }
}
