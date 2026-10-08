import Foundation

struct ResultColumn: Codable, Identifiable {
    var id: String
    var label: String
    var metric: String
    // Unknown units are retained; the model must not guess a numeric scale.
    var unit: String
    var context: ExperimentField
    var unitEvidence: ExperimentField? = nil
}
struct ResultCell: Codable {
    var columnID: String
    var valueText: String
    var uncertaintyText: String? = nil
    var value: Double? {
        guard valueText.range(of: "^[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?$", options: .regularExpression) != nil,
              let value = Double(valueText), value.isFinite else { return nil }
        return value
    }
}
struct ResultRow: Codable, Identifiable {
    var id: String
    var method: String
    var evidence: ExperimentField
    var cells: [ResultCell]
}
struct ResultTable: Codable, Identifiable {
    var id: String
    var caption: ExperimentField
    var header: ExperimentField
    var `protocol`: ExperimentField
    var columns: [ResultColumn]
    var rows: [ResultRow]
    var primaryMethodID: String? = nil
}
struct ResultDiscussion: Codable {
    var evidence: ExperimentField
    var interpretation: String
    var tableID: String? = nil
    var visualID: String? = nil
}
struct ResultsAnalysis: Codable {
    var tables: [ResultTable]
    var stability: [ResultDiscussion]
    var ablation: [ResultDiscussion]
    var generalization: [ResultDiscussion]
    var efficiency: [ResultDiscussion]
    // Only exact author-reported tests/claims; never a model-generated p-value.
    var statistics: [ExperimentField]
    var missing: [String]
    var groups: [(String, [ResultDiscussion])] { [("稳定性 / 多数据集", stability), ("消融", ablation), ("泛化", generalization), ("效率", efficiency)] }
    var discussions: [ResultDiscussion] { groups.flatMap { $0.1 } }
    func validateBindings(visuals: [ResultVisual]) throws {
        let tables = Set(tables.map(\.id)), figures = Set(visuals.filter { $0.kind == "figure" && $0.jpeg != nil }.map(\.id))
        for item in discussions {
            guard (item.tableID == nil) != (item.visualID == nil),
                  item.tableID.map({ tables.contains($0) }) ?? item.visualID.map({ figures.contains($0) }) ?? false else {
                throw NSError(domain: "results", code: 4, userInfo: [NSLocalizedDescriptionKey: "每条结果解读必须绑定一张实际存在的表或图，不能悬空或同时绑定多个对象。"])
            }
        }
        // 每条解读仍必须绑定一张实际存在的表或图；但「表没有解读」不再硬性失败——
        // 辅助性表格常无解读，UI 会显示「尚无绑定的文字解读」占位（曾导致部分论文结果分析整体失败）。
    }
    static func decode(_ raw: String) throws -> Self {
        let text = JSONExtract.object(from: raw)
        return try JSONDecoder().decode(Self.self, from: Data(text.utf8))
    }
    func validate(source: String) throws {
        func fail(_ why: String) throws { throw NSError(domain: "results", code: 1, userInfo: [NSLocalizedDescriptionKey: why]) }
        var fields = statistics + groups.flatMap { $0.1.map(\.evidence) }
        guard !tables.isEmpty || !fields.isEmpty else { try fail("没有表格或有依据的结果分析"); return }
        guard Set(tables.map(\.id)).count == tables.count else { try fail("结果表 ID 重复"); return }
        for table in tables {
            fields += [table.caption, table.header, table.protocol] + table.columns.map(\.context) + table.rows.map(\.evidence)
            fields += table.columns.compactMap(\.unitEvidence)
            if let primary = table.primaryMethodID, !table.rows.contains(where: { $0.id == primary }) {
                try fail("本文方法不在该表的方法行中：" + primary); return
            }
            guard table.caption.page != nil, table.header.page != nil, !table.columns.isEmpty, !table.rows.isEmpty,
                  Set(table.columns.map(\.id)).count == table.columns.count, Set(table.rows.map(\.id)).count == table.rows.count else { try fail("表格缺少表头、方法行或唯一标识：" + table.id); return }
            for column in table.columns {
                guard !column.id.isEmpty, !column.label.isEmpty, !column.metric.isEmpty,
                      column.context.page != nil else { try fail("列缺少原文上下文：" + column.id); return }
                // A unit is a reported fact, not inferred from metric name.
                if column.unit != "论文未说明" {
                    guard Evidence.normalized((column.unitEvidence ?? column.context).excerpt ?? "").contains(Evidence.normalized(column.unit)), !column.unit.isEmpty else { try fail("列单位未被其摘录支持：" + column.id); return }
                }
            }
            for row in table.rows {
                guard row.evidence.page != nil, !row.method.isEmpty,
                      Evidence.normalized(row.evidence.excerpt ?? "").contains(Evidence.normalized(row.method)),
                      Set(row.cells.map(\.columnID)).isSubset(of: Set(table.columns.map(\.id))),
                      Set(row.cells.map(\.columnID)).count == row.cells.count else { try fail("行标签或单元格无法定位：" + row.id); return }
                let numbers = Evidence.numbers(row.evidence.excerpt ?? "")
                for cell in row.cells {
                    guard cell.value != nil, !Evidence.numbers(cell.valueText).isEmpty, Evidence.numbers(cell.valueText).isSubset(of: numbers) else { try fail("单元格数字未匹配方法行：\(row.id)/\(cell.columnID) = \(cell.valueText)"); return }
                    if let uncertainty = cell.uncertaintyText, !uncertainty.isEmpty,
                       !Evidence.numbers(uncertainty).isSubset(of: numbers) { try fail("不确定性数值未匹配方法行：" + row.id); return }
                }
                // 位置敏感校验：上面的「数字 ∈ 该行数字集合」是集合语义，一行 2×N 个数字时
                // 任意列置换都满足它（实测转置后可整体通过）。这里按「表头定义的列顺序」取出各行
                // 单元格，要求它们在行摘录中按先后顺序出现，从而拦住列错位。
                // 值必须逐字匹配（保留 .958 这类原记法），与上面的一致性约束一致。
                let excerpt = row.evidence.excerpt ?? ""
                var cursor = excerpt.startIndex
                for column in table.columns {
                    guard let cell = row.cells.first(where: { $0.columnID == column.id }) else { continue }
                    guard let found = excerpt.range(of: cell.valueText, range: cursor..<excerpt.endIndex) else {
                        try fail("单元格数值未按表头列顺序排列，疑似列错位：\(row.id)/\(column.id) = \(cell.valueText)。请对照 PDF 原表逐列核对后再输出。")
                        return
                    }
                    cursor = found.upperBound
                }
            }
        }
        try ExperimentExtraction(dataset: fields, acquisition: [], training: [], loss: [], metrics: [], results: []).validate(source: source)
    }

    /// Salvage independently verifiable table content so one unreadable cell does
    /// not discard the rest of the paper's results. Missing cells remain blank in
    /// the table; every dropped item is named in `missing` for manual review.
    func salvaged(source: String, visuals: [ResultVisual]) -> ResultsAnalysis {
        let pageText = Dictionary(uniqueKeysWithValues: Evidence.pages(source).map { ($0.number, $0.text) })
        func supported(_ field: ExperimentField) -> Bool {
            if ["论文未说明", "论文中未说明", "论文中未找到", "未报告"].contains(field.v), field.page == nil, field.excerpt == nil { return true }
            guard let page = field.page, let text = pageText[page], let excerpt = field.excerpt,
                  Evidence.normalized(excerpt).count >= 8,
                  Evidence.normalized(text).contains(Evidence.normalized(excerpt)) else { return false }
            return Evidence.numbers(field.v).isSubset(of: Evidence.numbers(excerpt))
        }
        func unknown(_ key: String) -> ExperimentField {
            ExperimentField(k: key, v: "论文未说明", page: nil, excerpt: nil)
        }

        var issues = missing
        var acceptedTables: [ResultTable] = []
        var seenTables = Set<String>()
        for var table in tables {
            guard !table.id.isEmpty, seenTables.insert(table.id).inserted else {
                issues.append("结果表存在空 ID 或重复 ID，重复对象已省略。")
                continue
            }
            guard table.caption.page != nil, table.header.page != nil,
                  supported(table.caption), supported(table.header), !table.columns.isEmpty else {
                issues.append("\(table.id)：表题、表头或列证据无法核验，已隐藏该表；请对照 PDF 复核。")
                continue
            }
            if !supported(table.protocol) { table.protocol = unknown("评测协议") }
            let tableID = table.id
            let proposedColumns = table.columns
            var seenColumns = Set<String>()
            table.columns = proposedColumns.compactMap { column in
                guard !column.id.isEmpty, seenColumns.insert(column.id).inserted,
                      !column.label.isEmpty, !column.metric.isEmpty,
                      column.context.page != nil, supported(column.context) else {
                    issues.append("\(tableID)：一列的标签或数据集证据未能核验，已省略该列。")
                    return nil
                }
                var column = column
                if column.unit == "论文未说明" {
                    column.unitEvidence = nil
                } else if !supported(column.unitEvidence ?? column.context) {
                    column.unit = "论文未说明"; column.unitEvidence = nil
                    issues.append("\(tableID)/\(column.id)：单位证据未能核验，单位显示为未说明。")
                }
                return column
            }
            guard !table.columns.isEmpty else {
                issues.append("\(table.id)：没有可核验的数据列，已隐藏该表。")
                continue
            }
            let columnIDs = Set(table.columns.map(\.id))
            let columnOrder = Dictionary(uniqueKeysWithValues: table.columns.enumerated().map { ($0.element.id, $0.offset) })
            var seenRows = Set<String>()
            table.rows = table.rows.compactMap { row in
                guard !row.id.isEmpty, seenRows.insert(row.id).inserted,
                      !row.method.isEmpty, row.evidence.page != nil, supported(row.evidence),
                      Evidence.normalized(row.evidence.excerpt ?? "").contains(Evidence.normalized(row.method)) else {
                    issues.append("\(tableID)：方法行「\(row.method)」的原文依据未能核验，已省略该行。")
                    return nil
                }
                var row = row
                let excerpt = row.evidence.excerpt ?? ""
                var seenCells = Set<String>()
                let candidates = row.cells.filter { cell in
                    guard columnIDs.contains(cell.columnID), seenCells.insert(cell.columnID).inserted,
                          cell.value != nil, !Evidence.numbers(cell.valueText).isEmpty,
                          Evidence.numbers(cell.valueText).isSubset(of: Evidence.numbers(excerpt)),
                          cell.uncertaintyText.map({ Evidence.numbers($0).isSubset(of: Evidence.numbers(excerpt)) }) ?? true else {
                        issues.append("\(tableID)/\(row.method)/\(cell.columnID)：单元格无法与该方法行证据对应，已留空。")
                        return false
                    }
                    return true
                }
                var cursor = excerpt.startIndex
                row.cells = candidates.sorted { lhs, rhs in
                    (columnOrder[lhs.columnID] ?? .max) < (columnOrder[rhs.columnID] ?? .max)
                }.filter { cell in
                    guard let found = excerpt.range(of: cell.valueText, range: cursor..<excerpt.endIndex) else {
                        issues.append("\(tableID)/\(row.method)/\(cell.columnID)：数值列顺序无法核验，该单元格已留空。")
                        return false
                    }
                    cursor = found.upperBound
                    return true
                }
                return row
            }
            guard !table.rows.isEmpty else {
                issues.append("\(table.id)：没有保留下可核验的方法行，已隐藏该表。")
                continue
            }
            if let primary = table.primaryMethodID, !table.rows.contains(where: { $0.id == primary }) {
                table.primaryMethodID = nil
                issues.append("\(table.id)：本文方法行身份未能核验，已取消基线差值计算。")
            }
            acceptedTables.append(table)
        }

        let tableIDs = Set(acceptedTables.map(\.id))
        let figureIDs = Set(visuals.filter { $0.kind == "figure" && $0.jpeg != nil }.map(\.id))
        func keep(_ discussion: ResultDiscussion) -> Bool {
            guard discussion.evidence.page != nil, supported(discussion.evidence),
                  Evidence.numbers(discussion.interpretation).isSubset(of: Evidence.numbers(discussion.evidence.excerpt ?? "")) else {
                issues.append("一条结果解读的依据或数字无法核验，已省略。")
                return false
            }
            let tableValid = discussion.tableID.map(tableIDs.contains) ?? false
            let figureValid = discussion.visualID.map(figureIDs.contains) ?? false
            guard tableValid != figureValid else {
                issues.append("一条结果解读没有绑定到可用图表，已省略。")
                return false
            }
            return true
        }
        let validStatistics = statistics.filter { $0.page != nil && supported($0) }
        if validStatistics.count != statistics.count {
            issues.append("作者报告的统计材料中有无法核验的条目，已省略。")
        }
        return ResultsAnalysis(
            tables: acceptedTables,
            stability: stability.filter(keep),
            ablation: ablation.filter(keep),
            generalization: generalization.filter(keep),
            efficiency: efficiency.filter(keep),
            statistics: validStatistics,
            missing: Array(Set(issues)).sorted()
        )
    }
}

struct ResultDifference {
    var a: Double
    var b: Double
    var absolute: Double { a - b }
    var relativePercent: Double? {
        // 仅表示报告数值的算术相对变化；对 dB/PSNR 等对数尺度不作物理意义解释。
        guard b != 0 else { return nil }
        let result = (a - b) / abs(b) * 100
        return result.isFinite ? result : nil
    }
    var unit: String
    var metric: String
    static func calculate(table: ResultTable, columnID: String, aID: String, bID: String) -> Self? {
        guard aID != bID, let column = table.columns.first(where: { $0.id == columnID }),
              let a = table.rows.first(where: { $0.id == aID })?.cells.first(where: { $0.columnID == columnID })?.value,
              let b = table.rows.first(where: { $0.id == bID })?.cells.first(where: { $0.columnID == columnID })?.value else { return nil }
        guard (a - b).isFinite else { return nil }
        return Self(a: a, b: b, unit: column.unit, metric: column.metric)
    }
}
