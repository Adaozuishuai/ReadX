import SwiftUI

/// Each result object owns its explanation. No separate pile of figures followed by discussions.
enum ResultDocumentPlan {
    struct Item: Identifiable {
        var id: String
        var page: Int
        var table: ResultTable?
        var visual: ResultVisual?
        var discussions: [ResultDiscussion]
    }
    static func visualID(for table: ResultTable) -> String? {
        let text = table.caption.k + " " + table.caption.v
        let regex = try! NSRegularExpression(pattern: "(?i)\\btable\\s*(\\d+)")
        let ns = text as NSString
        return regex.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)).map { "table" + ns.substring(with: $0.range(at: 1)) }
    }
    static func items(_ analysis: ResultsAnalysis, visuals: [ResultVisual]) -> [Item] {
        var result = analysis.tables.map { table in
            Item(id: "table:" + table.id, page: table.caption.page ?? 0, table: table,
                 visual: visuals.first { $0.kind == "table" && $0.id == visualID(for: table) },
                 discussions: analysis.discussions.filter { entry in
                     entry.tableID == table.id || (entry.visualID != nil && entry.visualID == visualID(for: table))
                 })
        }
        let attached = Set(result.compactMap { $0.visual?.id })
        for visual in visuals where !attached.contains(visual.id) {
            result.append(Item(id: "visual:" + visual.id, page: visual.page, table: nil, visual: visual,
                               discussions: analysis.discussions.filter { $0.visualID == visual.id }))
        }
        return result.sorted { $0.page == $1.page ? $0.id < $1.id : $0.page < $1.page }
    }
}

struct ResultsCard: View {
    var jsonText: String
    var onEvidence: (Int, String) -> Void
    var visuals: [ResultVisual] = []
    static func identity(_ table: ResultTable) -> String {
        let rows = table.rows.map(\.id).joined(separator: ",")
        let cols = table.columns.map(\.id).joined(separator: ",")
        return table.id + "|" + rows + "|" + cols
    }
    var body: some View {
        if let analysis = try? ResultsAnalysis.decode(jsonText) {
            VStack(alignment: .leading, spacing: 24) {
                Text("逐图逐表 · 结果与结论").font(serifFont(21, weight: .bold))
                Text("图表按原文页序展示，紧邻其依据与解读。表格差值由程序计算；数值行列、曲线对应和视觉转写仍可点击页码核对。")
                    .font(.system(size: 12)).foregroundColor(.inkSoft)
                ForEach(ResultDocumentPlan.items(analysis, visuals: visuals)) { item in
                    VStack(alignment: .leading, spacing: 12) {
                        if let visual = item.visual { ResultVisualView(asset: visual, onEvidence: onEvidence) }
                        if let table = item.table {
                            ResultTablePosterView(table: table, onEvidence: onEvidence).id(Self.identity(table))
                            ResultPrimaryDifferenceView(table: table)
                        }
                        let relatedMissing = analysis.missing.filter { $0.localizedCaseInsensitiveContains(item.id.replacingOccurrences(of: "table:", with: "").replacingOccurrences(of: "visual:", with: "")) }
                        if !relatedMissing.isEmpty {
                            Text("本图表有部分内容待人工核对：\n" + relatedMissing.joined(separator: "\n"))
                                .font(.system(size: 11)).foregroundColor(.gold).textSelection(.enabled)
                        }
                        if let reading = item.visual?.reading {
                            MarkdownView(src: reading.interpretation, size: 15)
                            DisclosureGroup("图内 OCR 依据 · \(reading.observations.count) 条，转写待核对") {
                                ForEach(Array(reading.observations.enumerated()), id: \.offset) { _, field in
                                    ResultEvidence(field: field, onEvidence: onEvidence)
                                }
                            }
                        }
                        ForEach(Array(item.discussions.enumerated()), id: \.offset) { _, entry in
                            MarkdownView(src: entry.interpretation.hasPrefix("AI") ? entry.interpretation : "AI 解读：" + entry.interpretation, size: 15)
                            DisclosureGroup("对应原文依据") { ResultEvidence(field: entry.evidence, onEvidence: onEvidence) }
                        }
                        if item.discussions.isEmpty, item.visual?.reading == nil {
                            Text(item.table == nil ? "该图表的结论尚待可靠解析，请结合原文核对。" : "该表尚无绑定的文字解读；可使用上方基线对比，或重新生成解析。")
                                .font(.system(size: 12)).foregroundColor(.gold)
                        }
                        Divider()
                    }
                }
                let unbound = analysis.discussions.filter { $0.tableID == nil && $0.visualID == nil }
                if !unbound.isEmpty {
                    Text("旧版有 \(unbound.count) 条解读未绑定图表，请重新生成以就近排版。")
                        .font(.system(size: 12)).foregroundColor(.gold)
                }
                if !analysis.statistics.isEmpty {
                    DisclosureGroup("作者报告的统计检验 / 措辞与原文依据") {
                        ForEach(Array(analysis.statistics.enumerated()), id: \.offset) { _, field in
                            ResultEvidence(field: field, onEvidence: onEvidence)
                        }
                        Text("作者显著措辞与数值差值不等同于已执行统计检验。")
                            .font(.system(size: 11)).foregroundColor(.gold)
                    }
                }
                if !analysis.missing.isEmpty {
                    Text("当前抽取待核对：\n" + analysis.missing.joined(separator: "\n"))
                        .font(.system(size: 12)).foregroundColor(.gold)
                }
            }
        } else { Text("结果结构不可用，请重新生成").foregroundColor(.accent) }
    }
}
private struct ResultPrimaryDifferenceView: View {
    var table: ResultTable
    var body: some View {
        if let id = table.primaryMethodID, let primary = table.rows.first(where: { $0.id == id }) {
            VStack(alignment: .leading, spacing: 8) {
                Text("本文方法 \(primary.method) 相对各基线的指标变化").font(serifFont(16, weight: .bold))
                ScrollView(.horizontal) {
                    Grid(alignment: .trailing, horizontalSpacing: 16, verticalSpacing: 8) {
                        GridRow {
                            Text("对比基线").gridColumnAlignment(.leading)
                            ForEach(table.columns) { column in Text(column.label + " · " + column.metric).font(.system(size: 11, weight: .semibold)) }
                        }
                        ForEach(table.rows.filter { $0.id != id }) { baseline in
                            GridRow {
                                Text(baseline.method).font(.system(size: 12))
                                ForEach(table.columns) { column in
                                    if let difference = ResultDifference.calculate(table: table, columnID: column.id, aID: id, bID: baseline.id) {
                                        VStack(alignment: .trailing, spacing: 2) {
                                            Text("Δ " + String(format: "%.6g", difference.absolute) + (column.unit == "论文未说明" ? "" : " " + column.unit))
                                                .font(.system(size: 12, design: .monospaced))
                                            if let relative = difference.relativePercent {
                                                Text(String(format: "%+.4g%%", relative)).font(.system(size: 10, design: .monospaced)).foregroundColor(.inkSoft)
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }.padding(8)
                }
                Text("Δ = 本文方法 − 基线；相对差为报告数值的算术变化。指标优劣需结合方向与协议，PSNR 的百分比不代表物理量提升，差值不证明统计显著性。")
                    .font(.system(size: 11)).foregroundColor(.inkSoft)
            }
        }
    }
}
private struct ResultEvidence: View {
    var field: ExperimentField
    var onEvidence: (Int, String) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(field.k + "：" + field.v).font(.system(size: 13)).textSelection(.enabled)
            if let page = field.page { Button("原文 Page \(page)") { onEvidence(page, field.excerpt ?? "") }.buttonStyle(FunButtonStyle(small: true)) }
            if let quote = field.excerpt {
                DisclosureGroup("核对原文摘录") { Text(quote).font(.system(size: 11)).foregroundColor(.inkSoft).textSelection(.enabled) }
            }
        }
    }
}
