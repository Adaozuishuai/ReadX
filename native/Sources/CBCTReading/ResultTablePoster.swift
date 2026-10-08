import SwiftUI

// MARK: - 实验结果结构化对比表
//
// 组织方式（对应「按实验配置维度组织行列」）：
// 列 = 数据集/协议 × 指标（两级表头），行 = 方法；配置维度（views / 数据 / 评测协议）
// 单独成条放在表上方，避免与数值混读。数值统一居中等宽，与居中的表头相互对齐。
// 多组对比：先选基线方法，再勾选任意多个对比方法，逐列给出 Δ 与相对差。

struct ResultColumnGroup: Identifiable {
    var label: String
    var columns: [ResultColumn]
    var id: String { label }
    var unitSummary: String {
        let units = Set(columns.map(\.unit)).sorted()
        return units.joined(separator: " / ")
    }
}

enum ResultTableLayout {
    /// 按列标签（数据集 / 协议）分组，保持原表列顺序。
    static func groups(_ columns: [ResultColumn]) -> [ResultColumnGroup] {
        var order: [String] = []
        var map: [String: [ResultColumn]] = [:]
        for column in columns {
            if map[column.label] == nil { order.append(column.label) }
            map[column.label, default: []].append(column)
        }
        return order.map { ResultColumnGroup(label: $0, columns: map[$0] ?? []) }
    }

    /// 数值右对齐用的等宽格式：保留原记法（.958 这类），只补空白。
    static func padded(_ text: String, width: Int) -> String {
        let pad = max(0, width - text.count)
        return String(repeating: " ", count: pad) + text
    }

    /// 该列的最宽单元格字符数（表头与数据行取最大值），用于数值对齐。
    static func columnWidth(_ column: ResultColumn, rows: [ResultRow]) -> Int {
        var w = (column.metric + " [" + column.unit + "]").count
        for row in rows {
            if let cell = row.cells.first(where: { $0.columnID == column.id }) {
                w = max(w, cell.text.count)
            }
        }
        return min(w, 22)
    }
}

private extension ResultCell {
    /// 单元格展示文本：含误差项时附加 ±
    var text: String {
        valueText + (uncertaintyText.map { " ± " + $0 } ?? "")
    }
}

struct ResultTablePosterView: View {
    var table: ResultTable
    var onEvidence: (Int, String) -> Void

    @State private var baselineID = ""
    @State private var compared: Set<String> = []
    @State private var showConfig = false

    private var groups: [ResultColumnGroup] { ResultTableLayout.groups(table.columns) }
    private var shape: String { table.rows.map(\.id).joined(separator: ",") + "|" + table.columns.map(\.id).joined(separator: ",") }

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                header
                configStrip
                tableGrid
                comparison
            }
        }
        .onChange(of: shape) { _ in resetStaleSelection() }
        .onAppear { resetStaleSelection() }
    }

    // MARK: 标题与表题
    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(table.caption.k + "：" + table.caption.v).font(serifFont(15, weight: .bold)).textSelection(.enabled)
            if let page = table.caption.page {
                Button("表题原文 Page \(page)") { onEvidence(page, table.caption.excerpt ?? "") }.buttonStyle(FunButtonStyle(small: true))
            }
            Text("表头（原文）：" + table.header.v).font(.system(size: 11)).foregroundColor(.inkSoft).textSelection(.enabled)
        }
    }

    // MARK: 实验配置维度
    private var configStrip: some View {
        DisclosureGroup(isExpanded: $showConfig) {
            VStack(alignment: .leading, spacing: 6) {
                ResultEvidenceCompact(field: table.protocol, label: "评测协议 / 设置", onEvidence: onEvidence)
                ForEach(table.columns) { column in
                    ResultEvidenceCompact(field: column.context, label: "列配置：" + column.label + " · " + column.metric, onEvidence: onEvidence)
                    if let unit = column.unitEvidence {
                        ResultEvidenceCompact(field: unit, label: "单位依据：" + column.unit, onEvidence: onEvidence)
                    }
                }
                Text("配置维度由原文摘录支持；未报告的单位显示为「论文未说明」，不按指标名推断。")
                    .font(.system(size: 10)).foregroundColor(.gold)
            }
        } label: {
            Text("实验配置维度（数据集 / 参数设置 / 评价指标）").font(.system(size: 12, weight: .semibold))
        }
    }

    // MARK: 表格主体：两级表头 + 数值居中
    private var tableGrid: some View {
        ScrollView(.horizontal, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 0) {
                // 第一级：数据集 / 协议分组
                HStack(alignment: .bottom, spacing: 0) {
                    headerCell("方法", width: 150, alignment: .leading)
                    ForEach(groups) { group in
                        VStack(spacing: 2) {
                            Text(group.label.isEmpty ? "未分组" : group.label)
                                .font(.system(size: 11, weight: .semibold))
                                .lineLimit(2).multilineTextAlignment(.center)
                        }
                        .frame(width: CGFloat(group.columns.count) * columnWidth, alignment: .center)
                        .padding(.vertical, 4)
                        .background(RoundedRectangle(cornerRadius: 4).fill(Color.tealSoft.opacity(0.5)))
                        .overlay(Rectangle().frame(width: 1).foregroundColor(.line), alignment: .trailing)
                    }
                }
                // 第二级：指标 [单位]
                HStack(spacing: 0) {
                    headerCell("（行 / 列）", width: 150, alignment: .leading)
                    ForEach(table.columns) { column in
                        Text(column.metric + (column.unit == "论文未说明" ? "" : "\n[" + column.unit + "]"))
                            .font(.system(size: 10.5, weight: .semibold))
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(width: columnWidth, alignment: .center)
                            .padding(.vertical, 3)
                            .background(Color.card)
                    }
                }
                Divider().overlay(Color.ink.opacity(0.4))
                // 数据行
                ForEach(table.rows) { row in
                    HStack(spacing: 0) {
                        methodCell(row)
                        ForEach(table.columns) { column in
                            let cell = row.cells.first { $0.columnID == column.id }
                            Text(cell?.text ?? "—")
                                .font(.system(size: 11, design: .monospaced))
                                .monospacedDigit()
                                .frame(width: columnWidth, alignment: .center)
                                .padding(.vertical, 3)
                                .background(row.id == baselineID ? Color.funYellow.opacity(0.25) : Color.clear)
                                .overlay(alignment: .center) {
                                    if compared.contains(row.id) {
                                        RoundedRectangle(cornerRadius: 3).stroke(Color.accent, lineWidth: 1)
                                    }
                                }
                                .help(cell?.valueText ?? "")
                        }
                    }
                    Divider().overlay(Color.line.opacity(0.4))
                }
            }
            .padding(.vertical, 4)
        }
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.line, lineWidth: 1))
    }

    private var columnWidth: CGFloat { 92 }

    private func headerCell(_ text: String, width: CGFloat, alignment: Alignment) -> some View {
        Text(text).font(.system(size: 11, weight: .semibold))
            .frame(width: width, alignment: alignment)
            .padding(.vertical, 4)
            .background(Color.card)
    }

    private func methodCell(_ row: ResultRow) -> some View {
        HStack(spacing: 4) {
            Button {
                if compared.contains(row.id) { compared.remove(row.id) } else { compared.insert(row.id) }
            } label: {
                Image(systemName: compared.contains(row.id) ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 11))
                    .foregroundColor(compared.contains(row.id) ? .accent : .inkSoft)
            }.buttonStyle(.plain).help("加入多组对比")

            Button {
                baselineID = baselineID == row.id ? "" : row.id
            } label: {
                Text(row.method + (row.id == baselineID ? " · 基线" : ""))
                    .font(.system(size: 11, weight: row.id == baselineID ? .bold : .regular))
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }.buttonStyle(.plain).help("设为对比基线")

            if let page = row.evidence.page {
                Button("P\(page)") { onEvidence(page, row.evidence.excerpt ?? "") }.buttonStyle(FunButtonStyle(small: true))
            }
        }
        .frame(width: 150, alignment: .leading)
        .padding(.vertical, 3)
        .background(row.id == baselineID ? Color.funYellow.opacity(0.25) : Color.clear)
    }

    // MARK: 多组对比
    private var comparison: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("多组对比：点左侧圆圈勾选方法，点方法名设为基线（黄底）。Δ = 方法 − 基线，逐列给出。")
                .font(.system(size: 11)).foregroundColor(.inkSoft)
            if baselineID.isEmpty {
                Text("尚未选择基线方法。").font(.system(size: 11)).foregroundColor(.gold)
            } else if compared.isEmpty {
                Text("已选基线：\(table.rows.first { $0.id == baselineID }?.method ?? "")，请勾选至少一个对比方法。")
                    .font(.system(size: 11)).foregroundColor(.gold)
            } else {
                ForEach(table.rows.filter { compared.contains($0.id) && $0.id != baselineID }) { row in
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(row.method) − \(table.rows.first { $0.id == baselineID }?.method ?? "")")
                            .font(.system(size: 11.5, weight: .semibold))
                        ForEach(table.columns) { column in
                            if let delta = ResultDifference.calculate(table: table, columnID: column.id, aID: row.id, bID: baselineID) {
                                HStack(spacing: 6) {
                                    Text(column.label + " · " + column.metric).font(.system(size: 10.5)).foregroundColor(.inkSoft).frame(width: 150, alignment: .leading)
                                    Text("Δ \(fmt(delta.absolute))" + (column.unit == "论文未说明" ? "" : " [\(column.unit)]"))
                                        .font(.system(size: 11, design: .monospaced)).monospacedDigit()
                                    if let relative = delta.relativePercent {
                                        Text("数值相对差 \(fmt(relative))%")
                                            .font(.system(size: 10.5)).foregroundColor(.inkSoft)
                                    }
                                }
                            }
                        }
                    }
                    .padding(.vertical, 3)
                }
                Text("Δ 由程序计算；数值相对差仅表示报告值的算术变化（dB/PSNR 不代表物理量的百分比变化）。仅比较本表协议与指标，显著性与训练公平性需另行核对。")
                    .font(.system(size: 10)).foregroundColor(.gold)
            }
        }
    }

    private func fmt(_ value: Double) -> String { String(format: "%.6g", value) }

    private func resetStaleSelection() {
        let ids = Set(table.rows.map(\.id))
        if !ids.contains(baselineID) { baselineID = "" }
        compared = compared.filter { ids.contains($0) }
    }
}

private struct ResultEvidenceCompact: View {
    var field: ExperimentField
    var label: String
    var onEvidence: (Int, String) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label + "：" + field.v).font(.system(size: 11)).textSelection(.enabled)
            if let page = field.page {
                HStack(spacing: 6) {
                    Button("原文 Page \(page)") { onEvidence(page, field.excerpt ?? "") }.buttonStyle(FunButtonStyle(small: true))
                    if let quote = field.excerpt {
                        Text(quote).font(.system(size: 10)).foregroundColor(.inkSoft).lineLimit(2).textSelection(.enabled)
                    }
                }
            }
        }
    }
}
